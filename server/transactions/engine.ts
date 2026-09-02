import { Transaction } from '@solana/web3.js';
import type { ConfirmationResult, DurableTransactionRecord, ReconciliationResult, TransactionIntent, TransactionQuote } from '../../shared/transactions/types.js';
import { prepareProofTransaction, validateSignedProof } from '../../chains/solana/transactions/proof.js';
import { EmergencyControlService } from '../controls/service.js';
import { GaslessError, asGaslessError } from '../errors.js';
import { log } from '../observability/logger.js';
import type { RelayerProvider } from '../relayer/provider.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { DurableStore } from '../storage/durable.js';
import type { TemporaryStore } from '../storage/temporary.js';
import type { TokenRegistry } from '../token-registry/service.js';

export class TransactionEngine {
  constructor(
    private readonly temporary: TemporaryStore,
    private readonly durable: DurableStore,
    private readonly rpc: SolanaRpc,
    private readonly relayer: RelayerProvider,
    private readonly controls: EmergencyControlService,
    private readonly tokenRegistry: TokenRegistry,
    private readonly quoteTtlSeconds: number,
    private readonly maxNetworkFeeLamports = 20_000,
  ) {}

  async createQuote(input: { walletAddress: string; network: 'devnet'; actionType: 'DEVNET_PROOF'; clientRequestId: string; requestId: string }) {
    await this.controls.assertExecutionAllowed(input.actionType, input.network);
    if (!await this.temporary.consumeRateLimit(`quote:${input.walletAddress}`, 10, 60)) throw new GaslessError('RATE_LIMITED', 'quote', 'Too many proof requests. Wait a minute and try again.', true);
    const requestLock = `request:${input.walletAddress}:${input.clientRequestId}`;
    if (!await this.temporary.acquireReplayLock(requestLock, input.requestId, this.quoteTtlSeconds)) throw new GaslessError('REPLAY_DETECTED', 'quote', 'This request was already received.');
    const registry = await this.tokenRegistry.evaluate(input.actionType);
    if (registry.decision !== 'not_applicable') throw new GaslessError('TOKEN_UNSUPPORTED', 'quote', 'This action is not supported.');
    const now = Date.now();
    const intent: TransactionIntent = { intentId: crypto.randomUUID(), walletAddress: input.walletAddress, actionType: input.actionType, network: input.network, requestId: input.requestId, clientRequestId: input.clientRequestId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.quoteTtlSeconds * 1000).toISOString(), metadata: { proof: 'memo-v1' } };
    const quote: TransactionQuote = { quoteId: crypto.randomUUID(), intent, status: 'created', createdAt: intent.createdAt, expiresAt: intent.expiresAt };
    await this.temporary.saveQuote(quote, this.quoteTtlSeconds);
    await this.durable.createIntent(intent, quote.quoteId);
    log('info', 'quote_created', { requestId: input.requestId, intentId: intent.intentId, quoteId: quote.quoteId, walletAddress: input.walletAddress });
    return quote;
  }

  async prepare(quoteId: string, walletAddress: string, requestId: string) {
    const quote = await this.requireQuote(quoteId, walletAddress);
    await this.controls.assertExecutionAllowed(quote.intent.actionType, quote.intent.network);
    if (quote.prepared) return quote.prepared;
    const feePayer = await this.relayer.getFeePayerPublicKey();
    const prepared = await prepareProofTransaction(quote, feePayer, this.rpc);
    quote.status = 'awaiting_user_signature';
    quote.transactionId = prepared.transactionId;
    quote.preparedMessageHash = prepared.preparedMessageHash;
    quote.lastValidBlockHeight = prepared.lastValidBlockHeight;
    quote.simulation = prepared.simulation;
    quote.prepared = prepared;
    await this.temporary.saveQuote(quote, this.remainingTtl(quote));
    const now = new Date().toISOString();
    const record: DurableTransactionRecord = { id: prepared.transactionId, intentId: quote.intent.intentId, quoteId, walletAddress, actionType: quote.intent.actionType, network: quote.intent.network, status: 'awaiting_user_signature', preparedMessageHash: prepared.preparedMessageHash, createdAt: now, updatedAt: now };
    await this.durable.createTransaction(record);
    await this.durable.updateIntentStatus(quote.intent.intentId, 'awaiting_user_signature');
    await this.durable.appendEvent(record.id, 'proof_attempted', 'prepared', { simulation: 'passed', provider: prepared.simulation.provider }, `${record.id}:prepared`);
    log('info', 'transaction_prepared', { requestId, intentId: quote.intent.intentId, quoteId, transactionId: prepared.transactionId });
    return prepared;
  }

  async submit(input: { quoteId: string; walletAddress: string; signedTransaction: string; clientRequestId: string; requestId: string }) {
    const quote = await this.requireQuote(input.quoteId, input.walletAddress);
    const prepared = quote.prepared;
    if (!prepared) throw new GaslessError('INVALID_REQUEST', 'submit', 'Prepare this transaction before submitting it.');
    await this.controls.assertExecutionAllowed(quote.intent.actionType, quote.intent.network);
    if (!await this.temporary.consumeRateLimit(`submit:${input.walletAddress}`, 5, 60)) throw new GaslessError('RATE_LIMITED', 'submit', 'Too many submission attempts. Wait a minute and try again.', true);
    const lockValue = input.requestId;
    const replayKeys = [`submission:${input.quoteId}`, `message:${prepared.preparedMessageHash}`, `submit-request:${input.walletAddress}:${input.clientRequestId}`];
    const acquired: string[] = [];
    let crossedRelayerBoundary = false;
    let submissionSignature: string | undefined;
    try {
      for (const key of replayKeys) {
        if (!await this.temporary.acquireReplayLock(key, lockValue, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This transaction was already submitted.');
        acquired.push(key);
      }
      const validated = await validateSignedProof(input.signedTransaction, prepared, this.rpc);
      quote.status = 'validated';
      await this.temporary.saveQuote(quote, this.remainingTtl(quote));
      await this.durable.updateTransaction(prepared.transactionId, { status: 'validated', updatedAt: new Date().toISOString() });
      await this.durable.updateIntentStatus(quote.intent.intentId, 'validated');
      await this.controls.assertExecutionAllowed(quote.intent.actionType, quote.intent.network);
      const preparedTransaction = Transaction.from(Buffer.from(prepared.serializedTransaction, 'base64'));
      const predictedFee = await this.rpc.getFeeForMessage(preparedTransaction.serializeMessage().toString('base64'));
      if (predictedFee === null || predictedFee > this.maxNetworkFeeLamports) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The predicted network fee exceeds GASLESS policy.');
      const feePayerBalance = await this.rpc.getBalance(prepared.expectedFeePayer);
      if (feePayerBalance < predictedFee) throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_boundary', 'The GASLESS Devnet relayer needs funding.');
      crossedRelayerBoundary = true;
      quote.status = 'relaying';
      await this.temporary.saveQuote(quote, this.remainingTtl(quote));
      await this.durable.updateTransaction(prepared.transactionId, { status: 'relaying', updatedAt: new Date().toISOString() });
      await this.durable.updateIntentStatus(quote.intent.intentId, 'relaying');
      const fullySigned = await this.relayer.signTransaction(validated.serializedTransaction);
      const finalSimulation = await this.rpc.simulateTransaction(fullySigned, true);
      if (finalSimulation.err !== null) throw new GaslessError('SIMULATION_FAILED', 'final_signed_simulation', 'This transaction no longer passes GASLESS safety checks. Nothing was submitted.');
      const submission = await this.rpc.sendRawTransaction(fullySigned);
      submissionSignature = submission.signature;
      const submittedAt = new Date().toISOString();
      await this.durable.updateTransaction(prepared.transactionId, { status: 'submitted', signature: submission.signature, submittedAt, updatedAt: submittedAt });
      quote.status = 'submitted';
      await this.temporary.saveQuote(quote, this.remainingTtl(quote));
      await this.durable.updateIntentStatus(quote.intent.intentId, 'submitted');
      await this.durable.appendEvent(prepared.transactionId, 'proof_submitted', 'submitted', { signature: submission.signature, provider: submission.provider }, `${prepared.transactionId}:submitted`);
      const confirmation = await this.confirm(submission.signature, prepared.lastValidBlockHeight);
      const reconciliation = await this.reconcile(prepared.transactionId, confirmation);
      quote.status = reconciliation.status === 'confirmed' ? 'reconciled' : reconciliation.status === 'failed' ? 'failed' : 'submitted';
      await this.temporary.saveQuote(quote, this.remainingTtl(quote));
      await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
      log('info', 'transaction_reconciled', { requestId: input.requestId, transactionId: prepared.transactionId, signature: submission.signature, status: reconciliation.status });
      return { transactionId: prepared.transactionId, signature: submission.signature, confirmation, reconciliation };
    } catch (error) {
      const normalized = asGaslessError(error, 'submit', input.requestId);
      if (!crossedRelayerBoundary) for (const key of acquired) await this.temporary.releaseReplayLockIfSafe(key, lockValue);
      if (crossedRelayerBoundary) {
        quote.status = submissionSignature ? 'submitted' : 'failed';
        await this.temporary.saveQuote(quote, this.remainingTtl(quote)).catch(() => undefined);
      }
      if (prepared.transactionId) await this.durable.updateTransaction(prepared.transactionId, submissionSignature
        ? { status: 'submitted', signature: submissionSignature, errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }
        : { status: 'failed', failedAt: new Date().toISOString(), errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined);
      await this.durable.updateIntentStatus(quote.intent.intentId, submissionSignature ? 'submitted' : 'failed').catch(() => undefined);
      if (prepared.transactionId) await this.durable.appendEvent(prepared.transactionId, 'proof_failed', normalized.stage, { code: normalized.code }, `${prepared.transactionId}:failed:${normalized.code}`).catch(() => undefined);
      log(normalized.code === 'REPLAY_DETECTED' ? 'warn' : 'error', 'transaction_rejected', { requestId: input.requestId, transactionId: prepared.transactionId, code: normalized.code, stage: normalized.stage });
      throw normalized;
    }
  }

  async confirm(signature: string, lastValidBlockHeight: number): Promise<ConfirmationResult> {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      let status;
      try { status = await this.rpc.getSignatureStatuses(signature); }
      catch (error) { return { signature, outcome: 'rpc_failure', error: error instanceof Error ? error.message : 'RPC failure' }; }
      if (status?.err) return { signature, outcome: 'confirmed_chain_error', slot: status.slot, error: status.err, confirmedAt: new Date().toISOString() };
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { signature, outcome: 'confirmed_success', slot: status.slot, confirmedAt: new Date().toISOString() };
      try { if (await this.rpc.getBlockHeight() > lastValidBlockHeight) return { signature, outcome: 'expired' }; }
      catch { return { signature, outcome: 'rpc_failure' }; }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { signature, outcome: 'timeout_unknown' };
  }

  async reconcile(transactionId: string, known?: ConfirmationResult): Promise<ReconciliationResult> {
    const record = await this.durable.getTransaction(transactionId);
    if (!record) throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'Transaction record was not found.');
    const signature = record.signature ?? known?.signature;
    if (!signature) return { transactionId, status: 'pending', reconciledAt: new Date().toISOString() };
    let chain;
    try { chain = await this.rpc.getTransaction(signature); }
    catch { chain = null; }
    const status = chain ? (chain.meta.err === null ? 'confirmed' : 'failed') : known?.outcome === 'confirmed_chain_error' ? 'failed' : 'pending';
    const result: ReconciliationResult = { transactionId, signature, status, networkFeeLamports: chain ? String(chain.meta.fee) : undefined, reconciledAt: new Date().toISOString() };
    await this.durable.updateTransaction(transactionId, { status: status === 'confirmed' ? 'reconciled' : status === 'failed' ? 'failed' : 'submitted', confirmedAt: status === 'confirmed' ? result.reconciledAt : undefined, updatedAt: result.reconciledAt });
    await this.durable.recordReconciliation(result, record.walletAddress);
    return result;
  }

  async getTransaction(id: string) { return this.durable.getTransaction(id); }
  private async requireQuote(quoteId: string, walletAddress: string) {
    const quote = await this.temporary.getQuote(quoteId);
    if (!quote) throw new GaslessError('QUOTE_NOT_FOUND', 'quote', 'This transaction quote was not found.');
    if (quote.intent.walletAddress !== walletAddress) throw new GaslessError('SESSION_ERROR', 'quote', 'This quote belongs to a different wallet.');
    if (Date.parse(quote.expiresAt) <= Date.now()) throw new GaslessError('QUOTE_EXPIRED', 'quote', 'This transaction quote expired. Request a new one.');
    if (quote.status === 'reconciled' || quote.status === 'failed' || quote.status === 'expired') throw new GaslessError('QUOTE_ALREADY_USED', 'quote', 'This transaction quote has already finished.');
    return quote;
  }
  private remainingTtl(quote: TransactionQuote) { return Math.max(1, Math.ceil((Date.parse(quote.expiresAt) - Date.now()) / 1000)); }
}
