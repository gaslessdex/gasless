import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { batchClaimAccounts, discoverClaimAccounts, inspectClaimAccount } from '../../chains/solana/claim/accounts.js';
import { calculateClaimFee, prepareClaimTransaction, validateSignedClaim } from '../../chains/solana/transactions/claim.js';
import { versionedMessageHash, versionedSignerSignatureIsValid } from '../../chains/solana/transactions/clean.js';
import type { ClaimBatch, ClaimDiscoveryResult, DurableTransactionRecord, ReconciliationResult, SolanaNetwork, TransactionIntent, TransactionQuote } from '../../shared/transactions/types.js';
import type { EmergencyControlService } from '../controls/service.js';
import { GaslessError, asGaslessError } from '../errors.js';
import { log } from '../observability/logger.js';
import type { RelayerProvider } from '../relayer/provider.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { DurableStore } from '../storage/durable.js';
import type { TemporaryStore } from '../storage/temporary.js';
import type { OperationalRiskService } from '../risk/operational.js';
import { SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN, signingDeadlineHasMargin } from '../../chains/solana/swap/validity.js';
import { createSendSigningWindow, SEND_POST_SIGNATURE_BLOCK_MARGIN } from '../../chains/solana/send/validity.js';
import { broadcastAndConfirmClean, confirmCleanSignature, observeCleanSignature, recordCleanConfirmationObservation } from '../clean/submission.js';

interface ClaimPolicy {
  feeDestination?: string;
  feeBps: number;
  minimumUserPayoutLamports: number;
  maximumAccountsPerBatch: number;
  maximumNetworkFeeLamports: number;
  relayerLowBalanceThresholdLamports: number;
}

export class ClaimEngine {
  constructor(
    private readonly temporary: TemporaryStore,
    private readonly durable: DurableStore,
    private readonly rpc: SolanaRpc,
    private readonly relayer: RelayerProvider,
    private readonly controls: EmergencyControlService,
    private readonly quoteTtlSeconds: number,
    private readonly policy: ClaimPolicy,
    private readonly risk?: Pick<OperationalRiskService, 'releaseTransactionExposure'>,
  ) {}

  async discover(walletAddress: string): Promise<ClaimDiscoveryResult> {
    try { new PublicKey(walletAddress); }
    catch { throw new GaslessError('SESSION_ERROR', 'claim_discovery', 'Connect a valid Solana wallet.'); }
    return discoverClaimAccounts(this.rpc, walletAddress);
  }

  async reconcileStatus(quoteId: string, walletAddress: string, network: SolanaNetwork) {
    const record = await this.durable.getTransactionByQuoteId(quoteId);
    if (!record || record.actionType !== 'CLEAN_CLAIM') return { status: 'not_submitted' as const };
    if (record.walletAddress !== walletAddress || record.network !== network) throw new GaslessError('SESSION_ERROR', 'claim_reconciliation', 'This Claim belongs to a different wallet or network.');
    if (record.status === 'reconciled') return { status: 'confirmed' as const, transactionId: record.id, signature: record.signature };
    if (record.status === 'failed') return { status: 'failed' as const, transactionId: record.id, signature: record.signature };
    if (record.status !== 'submitted' || !record.signature) return { status: 'not_submitted' as const, transactionId: record.id };
    const confirmation = await observeCleanSignature(this.rpc, record.signature, record.lastValidBlockHeight);
    if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'claim', transactionId: record.id, signedMessageHash: record.preparedMessageHash, confirmation });
    if (confirmation.outcome === 'confirmed_chain_error') {
      await this.failDurableSubmission(record, 'confirmed_chain_error');
      return { status: 'failed' as const, transactionId: record.id, signature: record.signature };
    }
    if (confirmation.outcome === 'confirmed_success') {
      const reconciliation = await this.reconcileDurableSubmission(record);
      return { status: reconciliation.status, transactionId: record.id, signature: record.signature, reconciliation };
    }
    if (confirmation.outcome === 'expired') {
      await this.failDurableSubmission(record, 'failed_expired');
      return { status: 'failed' as const, transactionId: record.id, signature: record.signature };
    }
    return { status: 'pending' as const, transactionId: record.id, signature: record.signature, blockHeight: confirmation.blockHeight, expired: record.lastValidBlockHeight !== undefined && confirmation.blockHeight !== undefined && confirmation.blockHeight > record.lastValidBlockHeight };
  }

  async createQuote(input: { walletAddress: string; network: SolanaNetwork; clientRequestId: string; requestId: string }) {
    await this.controls.assertExecutionAllowed('CLEAN_CLAIM', input.network);
    if (!await this.temporary.consumeRateLimit(`claim-quote:${input.walletAddress}`, 10, 60)) throw new GaslessError('RATE_LIMITED', 'claim_quote', 'Too many Claim requests. Wait a minute and try again.', true);
    const requestLock = `claim-request:${input.walletAddress}:${input.clientRequestId}`;
    if (!await this.temporary.acquireReplayLock(requestLock, input.requestId, this.quoteTtlSeconds)) throw new GaslessError('REPLAY_DETECTED', 'claim_quote', 'This Claim request was already received.');
    const discovery = await this.discover(input.walletAddress);
    if (!discovery.eligibleAccounts.length) throw new GaslessError('TOKEN_UNSUPPORTED', 'claim_quote', "There's no SOL available to claim right now.");
    this.assertPolicy();
    if (input.walletAddress === this.policy.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'claim_configuration', 'The Claim fee destination cannot be the claiming wallet.');
    const selectedAccounts = discovery.eligibleAccounts.slice(0, this.policy.maximumAccountsPerBatch);
    const grouped = batchClaimAccounts(selectedAccounts, this.policy.maximumAccountsPerBatch);
    const gross = selectedAccounts.reduce((sum, account) => sum + BigInt(account.recoverableLamports), 0n);
    const totalFee = calculateClaimFee(gross, this.policy.feeBps);
    let cumulativeGross = 0n;
    let allocatedFee = 0n;
    const batches: ClaimBatch[] = grouped.map((accounts, batchIndex) => {
      const batchGross = accounts.reduce((sum, account) => sum + BigInt(account.recoverableLamports), 0n);
      cumulativeGross += batchGross;
      const cumulativeFee = calculateClaimFee(cumulativeGross, this.policy.feeBps);
      const batchFee = cumulativeFee - allocatedFee;
      allocatedFee = cumulativeFee;
      return { batchIndex, accounts, grossRecoveredLamports: batchGross.toString(), gaslessFeeLamports: batchFee.toString(), status: 'created' };
    });
    const now = Date.now();
    const intent: TransactionIntent = {
      intentId: crypto.randomUUID(), walletAddress: input.walletAddress, actionType: 'CLEAN_CLAIM', network: input.network, requestId: input.requestId,
      clientRequestId: input.clientRequestId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.quoteTtlSeconds * 1_000).toISOString(),
      metadata: { schemaVersion: 'claim-v1', accountCount: String(selectedAccounts.length), batchCount: String(batches.length) },
    };
    const quote: TransactionQuote = {
      quoteId: crypto.randomUUID(), intent, status: 'created', createdAt: intent.createdAt, expiresAt: intent.expiresAt,
      claim: { schemaVersion: 'claim-v1', feeBps: this.policy.feeBps, feeDestination: this.policy.feeDestination!, grossRecoveredLamports: gross.toString(), gaslessFeeLamports: totalFee.toString(), batches },
    };
    await this.temporary.saveQuote(quote, this.quoteTtlSeconds);
    await this.durable.createIntent(intent, quote.quoteId);
    log('info', 'claim_quote_created', { requestId: input.requestId, quoteId: quote.quoteId, walletAddress: input.walletAddress, accountCount: selectedAccounts.length, remainingEligibleCount: discovery.eligibleAccounts.length - selectedAccounts.length, batchCount: batches.length, grossLamports: gross.toString(), feeLamports: totalFee.toString() });
    return quote;
  }

  async prepare(quoteId: string, walletAddress: string, requestId: string, deferSigningWindow = false) {
    const quote = await this.requireQuote(quoteId, walletAddress);
    await this.controls.assertExecutionAllowed('CLEAN_CLAIM', quote.intent.network);
    if (!quote.claim) throw new GaslessError('INVALID_REQUEST', 'claim_prepare', 'This is not a Claim quote.');
    if (quote.claim.batches.every((batch) => batch.prepared)) {
      const prepared = quote.claim.batches[0]?.prepared;
      if (!prepared || (!deferSigningWindow && !signingDeadlineHasMargin(prepared.walletSigningExpiresAt))) throw this.refreshRequired();
      return quote;
    }
    await this.recheckAccounts(quote.claim.batches.flatMap((batch) => batch.accounts), walletAddress);
    const feePayer = await this.relayer.getFeePayerPublicKey();
    if (feePayer === quote.claim.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'claim_prepare', 'The Claim fee destination must be separate from the GASLESS relayer.');
    quote.claim.expectedRelayer = feePayer;
    for (const batch of quote.claim.batches) {
      if (batch.prepared) continue;
      const result = await prepareClaimTransaction({ quote, batchIndex: batch.batchIndex, accounts: batch.accounts, gaslessFeeLamports: BigInt(batch.gaslessFeeLamports), minimumUserPayoutLamports: BigInt(this.policy.minimumUserPayoutLamports), feePayer, feeDestination: quote.claim.feeDestination, rpc: this.rpc });
      const currentBlockHeight = await this.rpc.getBlockHeight();
      if (result.prepared.lastValidBlockHeight - currentBlockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'claim_blockhash_margin', 'Claim preparation is no longer fresh. Review the Claim again.');
      result.prepared.preparedBlockHeight = currentBlockHeight;
      batch.prepared = result.prepared;
      batch.sponsoredCostLamports = result.sponsoredCostLamports.toString();
      batch.netUserLamports = result.netUserLamports.toString();
      batch.status = 'awaiting_user_signature';
      const now = new Date().toISOString();
      const record: DurableTransactionRecord = {
        id: result.prepared.transactionId, intentId: quote.intent.intentId, quoteId, walletAddress, actionType: 'CLEAN_CLAIM', network: quote.intent.network, status: 'awaiting_user_signature', preparedMessageHash: result.prepared.preparedMessageHash, recentBlockhash: result.prepared.recentBlockhash, lastValidBlockHeight: result.prepared.lastValidBlockHeight,
        batchIndex: batch.batchIndex, accountAddresses: batch.accounts.map((account) => account.address), grossRecoveredLamports: batch.grossRecoveredLamports, gaslessFeeLamports: batch.gaslessFeeLamports,
        sponsoredCostLamports: batch.sponsoredCostLamports, netUserLamports: batch.netUserLamports, relayerAddress: feePayer, feeDestination: quote.claim.feeDestination, createdAt: now, updatedAt: now,
      };
      await this.durable.createTransaction(record);
      await this.durable.appendEvent(record.id, 'claim_attempted', 'prepared', { batchIndex: batch.batchIndex, accountCount: batch.accounts.length, simulation: 'passed', provider: result.prepared.simulation.provider, recentBlockhash: result.prepared.recentBlockhash, lastValidBlockHeight: result.prepared.lastValidBlockHeight, preparedMessageHash: result.prepared.preparedMessageHash }, `${record.id}:prepared`);
      await this.persistQuote(quote);
    }
    const sponsoredTotal = quote.claim.batches.reduce((sum, batch) => sum + BigInt(batch.sponsoredCostLamports ?? 0), 0n);
    const netTotal = quote.claim.batches.reduce((sum, batch) => sum + BigInt(batch.netUserLamports ?? 0), 0n);
    quote.claim.sponsoredCostLamports = sponsoredTotal.toString();
    quote.claim.netUserLamports = netTotal.toString();
    quote.status = 'awaiting_user_signature';
    await this.temporary.saveQuote(quote, this.remainingTtl(quote));
    await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
    log('info', 'claim_prepared', { requestId, quoteId, walletAddress, batchCount: quote.claim.batches.length, sponsoredCostLamports: sponsoredTotal.toString(), netLamports: netTotal.toString() });
    return deferSigningWindow ? quote : this.activateSigningWindow(quote, requestId);
  }

  async activateSigningWindow(quote: TransactionQuote, requestId: string) {
    const prepared = quote.claim?.batches[0]?.prepared;
    if (!prepared) throw new GaslessError('INVALID_REQUEST', 'claim_prepare', 'The Claim preparation was not completed.');
    if (signingDeadlineHasMargin(prepared.walletSigningExpiresAt)) return quote;
    try {
      await this.recheckAccounts(quote.claim!.batches[0].accounts, quote.intent.walletAddress);
      const currentBlockHeight = await this.rpc.getBlockHeight();
      const window = createSendSigningWindow(prepared.lastValidBlockHeight, currentBlockHeight);
      if (!window) throw new GaslessError('QUOTE_EXPIRED', 'claim_blockhash_margin', 'Claim preparation is no longer fresh. Review the Claim again.');
      Object.assign(prepared, { walletSigningReadyAt: window.readyAt, walletSigningExpiresAt: window.walletSigningExpiresAt, walletSigningWindowMs: window.walletSigningWindowMs, preparedBlockHeight: window.preparedBlockHeight });
      quote.expiresAt = window.quoteExpiresAt; quote.intent.expiresAt = window.quoteExpiresAt;
      await this.persistQuote(quote);
      log('info', 'claim_wallet_window_started', { requestId, quoteId: quote.quoteId, transactionId: prepared.transactionId, preparedBlockHeight: prepared.preparedBlockHeight, lastValidBlockHeight: prepared.lastValidBlockHeight });
      return quote;
    } catch (error) {
      await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('RPC_ERROR', 'claim_wallet_gate', 'Claim safety could not be verified.', true));
      throw error;
    }
  }

  async abortBeforeWallet(quote: TransactionQuote, error: unknown) {
    await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('SPONSOR_LIMIT_EXCEEDED', 'sponsorship_policy', 'Sponsored transactions are temporarily unavailable.', true));
  }

  async currentWalletGateBlockHeight(quoteId: string, walletAddress: string) {
    const quote = await this.requireQuote(quoteId, walletAddress);
    try {
      const prepared = quote.claim?.batches[0]?.prepared;
      if (!prepared || !signingDeadlineHasMargin(prepared.walletSigningExpiresAt)) throw this.refreshRequired();
      await this.controls.assertExecutionAllowed('CLEAN_CLAIM', quote.intent.network);
      await this.recheckAccounts(quote.claim!.batches[0].accounts, walletAddress);
      const blockHeight = await this.rpc.getBlockHeight();
      if (prepared.lastValidBlockHeight - blockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'claim_blockhash_margin', 'Claim preparation is no longer fresh. Review the Claim again.');
      return blockHeight;
    } catch (error) {
      await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('RPC_ERROR', 'claim_wallet_gate', 'Claim safety could not be verified.', true));
      throw error;
    }
  }

  async currentWalletApprovalBlockHeight(quoteId: string, walletAddress: string) {
    await this.requireWalletQuote(quoteId, walletAddress);
    return this.rpc.getBlockHeight();
  }

  async recordWalletEvent(quoteId: string, walletAddress: string, event: string, metadata: Record<string, unknown> = {}) {
    const quote = await this.requireWalletQuote(quoteId, walletAddress); const prepared = quote.claim!.batches[0].prepared!;
    if (!new Set(['invoked', 'returned', 'failed', 'expired']).has(event)) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'Unknown wallet event.');
    const blockHeight = await this.rpc.getBlockHeight();
    const safeMetadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 240) : value]));
    await this.durable.appendEvent(prepared.transactionId, `claim_wallet_${event}`, 'wallet_signing', { ...safeMetadata, blockHeight, remainingBlocks: prepared.lastValidBlockHeight - blockHeight }, `${prepared.transactionId}:wallet:${event}`);
  }

  async abortWalletApproval(quoteId: string, walletAddress: string, reason: string, userSignatureReturned: boolean) {
    const quote = await this.requireWalletQuote(quoteId, walletAddress, true); const prepared = quote.claim!.batches[0].prepared!;
    if (quote.status === 'failed') return { status: 'failed' as const };
    const allowed = new Set(['USER_EXPLICITLY_CANCELLED', 'WALLET_SIGNING_TIMEOUT', 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', 'WALLET_PROVIDER_ERROR', 'WALLET_ACCOUNT_CHANGED', 'APP_ABORTED_SIGNING_FLOW', 'SESSION_DISCONNECTED', 'UNKNOWN_WALLET_FAILURE']);
    if (!allowed.has(reason)) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'Unknown wallet failure.');
    const blockHeight = await this.rpc.getBlockHeight(); const remainingBlocks = prepared.lastValidBlockHeight - blockHeight;
    if (reason === 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN' && !userSignatureReturned && remainingBlocks >= 0) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The wallet attempt is not yet provably expired.');
    if (userSignatureReturned && remainingBlocks >= SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The signed Claim still has a safe submission margin.');
    await this.failAfterWallet(quote, reason, userSignatureReturned, blockHeight);
    return { status: 'failed' as const };
  }

  async abortWalletGate(quoteId: string, walletAddress: string, reason: string) {
    const quote = await this.requireQuote(quoteId, walletAddress, true, true);
    if (quote.status === 'failed') return;
    const error = reason === 'blockhash_margin' ? new GaslessError('QUOTE_EXPIRED', 'claim_blockhash_margin', 'Claim preparation is no longer fresh. Review the Claim again.') : this.refreshRequired();
    await this.failBeforeWallet(quote, error);
  }

  async submit(input: { quoteId: string; batchIndex: number; walletAddress: string; signedTransaction: string; clientRequestId: string; requestId: string }) {
    const quote = await this.requireQuote(input.quoteId, input.walletAddress, true);
    const claim = quote.claim;
    const batch = claim?.batches.find((item) => item.batchIndex === input.batchIndex);
    if (!claim || !batch?.prepared) throw new GaslessError('INVALID_REQUEST', 'claim_submit', 'Prepare this Claim batch before submitting it.');
    if (batch.status === 'reconciled' && batch.signature && batch.reconciliation) return { transactionId: batch.prepared.transactionId, signature: batch.signature, reconciliation: batch.reconciliation, alreadyCompleted: true };
    if (batch.status === 'submitted' && batch.signature) {
      const confirmation = await confirmCleanSignature(this.rpc, batch.signature, batch.prepared.lastValidBlockHeight);
      if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'claim', transactionId: batch.prepared.transactionId, signedMessageHash: batch.prepared.preparedMessageHash, confirmation });
      const reconciliation = confirmation.outcome === 'expired'
        ? await this.expireSubmittedBatch(batch, batch.signature)
        : await this.reconcile(batch, input.walletAddress, claim.feeDestination, confirmation);
      if (reconciliation.status === 'confirmed') {
        batch.status = 'reconciled'; batch.reconciliation = reconciliation;
        quote.status = claim.batches.every((item) => item.status === 'reconciled') ? 'reconciled' : 'awaiting_user_signature';
        await this.persistQuote(quote);
        await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
        await this.releaseSuccessfulExposure(quote, batch);
        return { transactionId: batch.prepared.transactionId, signature: batch.signature, confirmation, reconciliation, alreadyCompleted: true };
      }
      throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Claim was submitted but its final result could not be verified yet.', true);
    }
    await this.controls.assertExecutionAllowed('CLEAN_CLAIM', quote.intent.network);
    if (!await this.temporary.consumeRateLimit(`claim-submit:${input.walletAddress}`, 10, 60)) throw new GaslessError('RATE_LIMITED', 'claim_submit', 'Too many Claim submission attempts. Wait a minute and try again.', true);
    const lockValue = input.requestId;
    const replayKeys = [`claim-submission:${input.quoteId}:${input.batchIndex}`, `message:${batch.prepared.preparedMessageHash}`, `claim-submit-request:${input.walletAddress}:${input.clientRequestId}`];
    const acquired: string[] = [];
    let crossedRelayerBoundary = false;
    let submissionSignature: string | undefined;
    try {
      for (const key of replayKeys) {
        if (!await this.temporary.acquireReplayLock(key, lockValue, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Claim batch was already submitted.');
        acquired.push(key);
      }
      const signedReturnBlockHeight = await this.rpc.getBlockHeight();
      if (batch.prepared.lastValidBlockHeight - signedReturnBlockHeight < SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'wallet_signing', 'Claim preparation expired while awaiting wallet approval. Nothing was submitted.');
      const validated = await validateSignedClaim(input.signedTransaction, batch.prepared, this.rpc);
      if (validated.messageHash !== batch.prepared.preparedMessageHash) {
        const finalMessageKey = `message:${validated.messageHash}`;
        if (!await this.temporary.acquireReplayLock(finalMessageKey, lockValue, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Claim batch was already submitted.');
        acquired.push(finalMessageKey);
      }
      await this.recheckAccounts(batch.accounts, input.walletAddress);
      await this.controls.assertExecutionAllowed('CLEAN_CLAIM', quote.intent.network);
      const transaction = VersionedTransaction.deserialize(Buffer.from(validated.serializedTransaction, 'base64'));
      const predictedFee = await this.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
      if (predictedFee === null || String(predictedFee) !== batch.sponsoredCostLamports || predictedFee > this.policy.maximumNetworkFeeLamports) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The Claim network cost no longer matches the preview.');
      const feePayerBalance = await this.rpc.getBalance(batch.prepared.expectedFeePayer);
      if (feePayerBalance < predictedFee + this.policy.relayerLowBalanceThresholdLamports) throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_boundary', 'GASLESS sponsorship is temporarily unavailable.');
      crossedRelayerBoundary = true;
      batch.status = 'relaying';
      await this.persistQuote(quote);
      await this.durable.updateTransaction(batch.prepared.transactionId, { status: 'relaying', updatedAt: new Date().toISOString() });
      const koraSigningStartedAt = new Date().toISOString();
      const fullySigned = await this.relayer.signTransaction(validated.serializedTransaction);
      const koraSigningReturnedAt = new Date().toISOString();
      const signedTransaction = VersionedTransaction.deserialize(Buffer.from(fullySigned, 'base64'));
      if (versionedMessageHash(signedTransaction) !== validated.messageHash || signedTransaction.message.recentBlockhash !== batch.prepared.recentBlockhash) throw new GaslessError('MESSAGE_MISMATCH', 'relayer_boundary', 'The signed Claim changed after approval. Nothing was submitted.');
      if (!versionedSignerSignatureIsValid(signedTransaction, 0, batch.prepared.expectedFeePayer)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The Claim payer signature is invalid. Nothing was submitted.');
      const finalSimulation = await this.rpc.simulateTransaction(fullySigned, true);
      if (finalSimulation.err !== null) throw new GaslessError('SIMULATION_FAILED', 'final_signed_simulation', "This claim couldn't be safely completed. Nothing was submitted.");
      await this.durable.appendEvent(batch.prepared.transactionId, 'claim_fully_signed', 'relayer', { koraSigningStartedAt, koraSigningReturnedAt, preparedMessageHash: batch.prepared.preparedMessageHash, walletReturnedMessageHash: validated.messageHash, koraSignedMessageHash: validated.messageHash, submittedMessageHash: validated.messageHash, userSignatureReturned: true, payerSignatureReturned: true, finalSimulation: 'passed' }, `${batch.prepared.transactionId}:fully_signed`);
      await this.durable.appendEvent(batch.prepared.transactionId, 'claim_submission_attempted', 'submitted', { batchIndex: batch.batchIndex, preparedMessageHash: batch.prepared.preparedMessageHash }, `${batch.prepared.transactionId}:submission_attempted`);
      const canonicalSignature = bs58.encode(signedTransaction.signatures[0]);
      submissionSignature = canonicalSignature;
      batch.signature = canonicalSignature;
      batch.status = 'submitted';
      const submittedAt = new Date().toISOString();
      await this.durable.updateTransaction(batch.prepared.transactionId, { status: 'submitted', signature: canonicalSignature, submittedAt, updatedAt: submittedAt });
      await this.durable.appendEvent(batch.prepared.transactionId, 'claim_submitted', 'submitted', { signature: canonicalSignature, batchIndex: batch.batchIndex, recentBlockhash: batch.prepared.recentBlockhash, lastValidBlockHeight: batch.prepared.lastValidBlockHeight, signedMessageHash: validated.messageHash }, `${batch.prepared.transactionId}:submitted`);
      await this.persistQuote(quote);
      const confirmation = await broadcastAndConfirmClean({ rpc: this.rpc, durable: this.durable, eventPrefix: 'claim', prepared: batch.prepared, fullySigned, canonicalSignature, signedMessageHash: validated.messageHash });
      const reconciliation = confirmation.outcome === 'expired'
        ? await this.expireSubmittedBatch(batch, canonicalSignature)
        : await this.reconcile(batch, input.walletAddress, claim.feeDestination, confirmation);
      batch.reconciliation = reconciliation;
      batch.status = reconciliation.status === 'confirmed' ? 'reconciled' : reconciliation.status === 'failed' ? 'failed' : 'submitted';
      quote.status = claim.batches.every((item) => item.status === 'reconciled') ? 'reconciled' : reconciliation.status === 'failed' ? 'failed' : 'submitted';
      await this.persistQuote(quote);
      await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
      if (reconciliation.status !== 'confirmed') throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Claim was submitted but its final result could not be verified yet.', true);
      await this.releaseSuccessfulExposure(quote, batch);
      log('info', 'claim_reconciled', { requestId: input.requestId, quoteId: input.quoteId, transactionId: batch.prepared.transactionId, signature: canonicalSignature, batchIndex: batch.batchIndex, status: reconciliation.status });
      return { transactionId: batch.prepared.transactionId, signature: canonicalSignature, confirmation, reconciliation, alreadyCompleted: false };
    } catch (error) {
      const normalized = asGaslessError(error, 'claim_submit', input.requestId);
      if (!crossedRelayerBoundary) for (const key of acquired) await this.temporary.releaseReplayLockIfSafe(key, lockValue);
      if (!submissionSignature) {
        batch.status = crossedRelayerBoundary ? 'failed' : 'awaiting_user_signature';
        await this.persistQuote(quote).catch(() => undefined);
        await this.durable.updateTransaction(batch.prepared.transactionId, { status: crossedRelayerBoundary ? 'failed' : 'awaiting_user_signature', failedAt: crossedRelayerBoundary ? new Date().toISOString() : undefined, errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined);
      }
      await this.durable.appendEvent(batch.prepared.transactionId, 'claim_failed', normalized.stage, { code: normalized.code, batchIndex: batch.batchIndex }, `${batch.prepared.transactionId}:failed:${normalized.code}`).catch(() => undefined);
      log(normalized.code === 'REPLAY_DETECTED' ? 'warn' : 'error', 'claim_rejected', { requestId: input.requestId, quoteId: input.quoteId, transactionId: batch.prepared.transactionId, batchIndex: batch.batchIndex, code: normalized.code, stage: normalized.stage });
      throw normalized;
    }
  }

  private async recheckAccounts(accounts: ClaimBatch['accounts'], walletAddress: string) {
    for (let offset = 0; offset < accounts.length; offset += 100) {
      const group = accounts.slice(offset, offset + 100);
      const current = await this.rpc.getMultipleAccounts(group.map((account) => account.address));
      for (let index = 0; index < group.length; index += 1) {
        const chainAccount = current[index];
        if (!chainAccount) throw new GaslessError('MESSAGE_MISMATCH', 'claim_state_recheck', 'Your wallet changed after the preview. Scan again to get an updated claim.');
        const inspected = inspectClaimAccount(group[index].address, chainAccount, walletAddress);
        if (!inspected.eligible || inspected.stateFingerprint !== group[index].stateFingerprint) throw new GaslessError('MESSAGE_MISMATCH', 'claim_state_recheck', 'Your wallet changed after the preview. Scan again to get an updated claim.');
      }
    }
  }

  private async expireSubmittedBatch(batch: ClaimBatch, signature: string): Promise<ReconciliationResult> {
    const record = await this.durable.getTransaction(batch.prepared!.transactionId);
    if (record && record.status !== 'failed') await this.failDurableSubmission(record, 'failed_expired');
    return { transactionId: batch.prepared!.transactionId, signature, status: 'failed', reconciledAt: new Date().toISOString() };
  }

  private async reconcile(batch: ClaimBatch, walletAddress: string, feeDestination: string, confirmation: { signature: string; outcome: string }): Promise<ReconciliationResult> {
    const now = new Date().toISOString();
    const transactionId = batch.prepared!.transactionId;
    if (confirmation.outcome !== 'confirmed_success') return { transactionId, signature: confirmation.signature, status: confirmation.outcome === 'confirmed_chain_error' ? 'failed' : 'pending', reconciledAt: now };
    const chain = await this.rpc.getTransactionAcrossProviders(confirmation.signature);
    if (!chain || chain.meta.err !== null) return { transactionId, signature: confirmation.signature, status: chain ? 'failed' : 'pending', reconciledAt: now };
    const indexOf = (address: string) => chain.transaction.message.accountKeys.indexOf(address);
    const delta = (address: string) => { const index = indexOf(address); return index < 0 ? undefined : BigInt(chain.meta.postBalances[index]) - BigInt(chain.meta.preBalances[index]); };
    const expectedNetwork = BigInt(batch.sponsoredCostLamports!);
    const expectedNet = BigInt(batch.netUserLamports!);
    const expectedSettlement = BigInt(batch.gaslessFeeLamports) + expectedNetwork;
    const closed = await this.rpc.getMultipleAccounts(batch.accounts.map((account) => account.address));
    const economicsMatch = BigInt(chain.meta.fee) === expectedNetwork && delta(walletAddress) === expectedNet && delta(feeDestination) === expectedSettlement && delta(batch.prepared!.expectedFeePayer) === -expectedNetwork;
    const status = economicsMatch && closed.every((account) => account === null) ? 'confirmed' : 'failed';
    const result: ReconciliationResult = { transactionId, signature: confirmation.signature, status, networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
    await this.durable.updateTransaction(transactionId, { status: status === 'confirmed' ? 'reconciled' : 'failed', confirmedAt: status === 'confirmed' ? now : undefined, failedAt: status === 'failed' ? now : undefined, errorCode: status === 'failed' ? 'RECONCILIATION_FAILED' : undefined, errorStage: status === 'failed' ? 'claim_economics' : undefined, updatedAt: now });
    const record = await this.durable.getTransaction(transactionId);
    if (status === 'confirmed' && record) await this.durable.recordClaimAccounting(record, String(chain.meta.fee));
    return result;
  }

  private async reconcileDurableSubmission(record: DurableTransactionRecord): Promise<ReconciliationResult> {
    const now = new Date().toISOString();
    const chain = await this.rpc.getTransactionAcrossProviders(record.signature!);
    if (!chain) return { transactionId: record.id, signature: record.signature, status: 'pending', reconciledAt: now };
    if (chain.meta.err !== null) {
      await this.failDurableSubmission(record, 'confirmed_chain_error');
      return { transactionId: record.id, signature: record.signature, status: 'failed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
    }
    const required = [record.sponsoredCostLamports, record.netUserLamports, record.gaslessFeeLamports, record.relayerAddress, record.feeDestination];
    if (!record.accountAddresses?.length || required.some((value) => value === undefined)) throw new GaslessError('CONFIGURATION_ERROR', 'claim_reconciliation', 'Durable Claim reconciliation data is incomplete.');
    const indexOf = (address: string) => chain.transaction.message.accountKeys.indexOf(address);
    const delta = (address: string) => { const index = indexOf(address); return index < 0 ? undefined : BigInt(chain.meta.postBalances[index]) - BigInt(chain.meta.preBalances[index]); };
    const expectedNetwork = BigInt(record.sponsoredCostLamports!);
    const expectedNet = BigInt(record.netUserLamports!);
    const expectedSettlement = BigInt(record.gaslessFeeLamports!) + expectedNetwork;
    const closed = await this.rpc.getMultipleAccounts(record.accountAddresses);
    const valid = BigInt(chain.meta.fee) === expectedNetwork && delta(record.walletAddress) === expectedNet && delta(record.feeDestination!) === expectedSettlement && delta(record.relayerAddress!) === -expectedNetwork && closed.every((account) => account === null);
    if (!valid) {
      await this.failDurableSubmission(record, 'claim_economics');
      return { transactionId: record.id, signature: record.signature, status: 'failed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
    }
    const reconciled = { ...record, status: 'reconciled' as const, confirmedAt: now, updatedAt: now };
    await this.durable.recordClaimAccounting(reconciled, String(chain.meta.fee));
    await this.releaseDurableExposure(reconciled, 'reconciled_success');
    await this.durable.updateTransaction(record.id, { status: 'reconciled', confirmedAt: now, updatedAt: now });
    await this.durable.updateIntentStatus(record.intentId, 'reconciled');
    return { transactionId: record.id, signature: record.signature, status: 'confirmed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
  }

  private async failDurableSubmission(record: DurableTransactionRecord, reason: string) {
    const now = new Date().toISOString();
    await this.durable.appendEvent(record.id, 'claim_terminal_failure_proven', reason, { signature: record.signature, reason }, `${record.id}:terminal_failure:${reason}`);
    await this.releaseDurableExposure(record, reason);
    await this.durable.updateTransaction(record.id, { status: 'failed', failedAt: now, errorCode: 'CHAIN_EXECUTION_FAILED', errorStage: reason, updatedAt: now });
    await this.durable.updateIntentStatus(record.intentId, 'failed');
  }

  private async releaseDurableExposure(record: DurableTransactionRecord, reason: string) {
    if (!this.risk || record.sponsoredCostLamports === undefined) return;
    await this.durable.appendEvent(record.id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: record.intentId, quoteId: record.quoteId, action: 'CLEAN_CLAIM', network: record.network, amountLamports: record.sponsoredCostLamports, reason }, `${record.id}:${reason}:release_authorized`);
    const result = await this.risk.releaseTransactionExposure({ network: record.network, walletAddress: record.walletAddress, action: 'CLEAN_CLAIM', transactionId: record.id, amountLamports: Number(record.sponsoredCostLamports) });
    await this.durable.appendEvent(record.id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason }, `${record.id}:${reason}:released`);
  }

  private assertPolicy() {
    if (!this.policy.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'claim_configuration', 'The Claim fee destination is not configured.');
    try { new PublicKey(this.policy.feeDestination); } catch { throw new GaslessError('CONFIGURATION_ERROR', 'claim_configuration', 'The Claim fee destination is invalid.'); }
    if (!Number.isInteger(this.policy.minimumUserPayoutLamports) || this.policy.minimumUserPayoutLamports < 1 || !Number.isInteger(this.policy.maximumAccountsPerBatch) || this.policy.maximumAccountsPerBatch < 1 || !Number.isInteger(this.policy.maximumNetworkFeeLamports) || this.policy.maximumNetworkFeeLamports < 1 || !Number.isInteger(this.policy.relayerLowBalanceThresholdLamports) || this.policy.relayerLowBalanceThresholdLamports < 0) throw new GaslessError('CONFIGURATION_ERROR', 'claim_configuration', 'Claim policy is invalid.');
  }

  private async requireQuote(quoteId: string, walletAddress: string, allowFinished = false, allowExpired = false) {
    const quote = await this.temporary.getQuote(quoteId);
    if (!quote) throw new GaslessError('QUOTE_NOT_FOUND', 'claim_quote', 'This Claim preview was not found.');
    if (quote.intent.actionType !== 'CLEAN_CLAIM') throw new GaslessError('INVALID_REQUEST', 'claim_quote', 'This quote is not a Claim SOL quote.');
    if (quote.intent.walletAddress !== walletAddress) throw new GaslessError('SESSION_ERROR', 'claim_quote', 'This Claim preview belongs to a different wallet.');
    if (!allowExpired && Date.parse(quote.expiresAt) <= Date.now() && quote.status !== 'reconciled') throw new GaslessError('QUOTE_EXPIRED', 'claim_quote', 'This Claim preview expired. Scan again.');
    if (!allowFinished && ['reconciled', 'failed', 'expired'].includes(quote.status)) throw new GaslessError('QUOTE_ALREADY_USED', 'claim_quote', 'This Claim preview has already finished.');
    return quote;
  }

  private async requireWalletQuote(quoteId: string, walletAddress: string, allowFinished = false) {
    const quote = await this.requireQuote(quoteId, walletAddress, allowFinished, true);
    if (!quote.claim?.batches[0]?.prepared) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The Claim wallet attempt was not prepared.');
    return quote;
  }

  private remainingTtl(quote: TransactionQuote) { return Math.max(1, Math.ceil((Date.parse(quote.expiresAt) - Date.now()) / 1_000)); }
  private persistQuote(quote: TransactionQuote) { return this.temporary.saveQuote(quote, quote.status === 'reconciled' || quote.status === 'submitted' || quote.claim?.batches.some((batch) => batch.status === 'submitted') ? 86_400 : quote.claim?.batches.some((batch) => batch.prepared) ? 300 : this.remainingTtl(quote)); }
  private async releaseExposure(quote: TransactionQuote, batch: ClaimBatch) { if (this.risk && batch.prepared) return this.risk.releaseTransactionExposure({ network: quote.intent.network, walletAddress: quote.intent.walletAddress, action: 'CLEAN_CLAIM', transactionId: batch.prepared.transactionId, amountLamports: Number(batch.sponsoredCostLamports) }); }
  private async releaseSuccessfulExposure(quote: TransactionQuote, batch: ClaimBatch) { if (!batch.prepared) return; const id = batch.prepared.transactionId; try { await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: quote.intent.intentId, quoteId: quote.quoteId, action: 'CLEAN_CLAIM', network: quote.intent.network, amountLamports: batch.sponsoredCostLamports, reason: 'reconciled_success' }, `${id}:success_release_authorized`); const result = await this.releaseExposure(quote, batch); await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason: 'reconciled_success' }, `${id}:success_released`); } catch { log('error', 'claim_sponsorship_release_failed', { transactionId: id, quoteId: quote.quoteId, reason: 'reconciled_success' }); } }
  private async failBeforeWallet(quote: TransactionQuote, error: GaslessError) { const batch = quote.claim?.batches[0]; if (!batch?.prepared) return; await this.failAfterWallet(quote, error.code, false, await this.rpc.getBlockHeight().catch(() => batch.prepared!.preparedBlockHeight ?? 0), error.stage); }
  private async failAfterWallet(quote: TransactionQuote, code: string, userSignatureReturned: boolean, blockHeight: number, stage = 'wallet_signing') {
    const batch = quote.claim!.batches[0]; const prepared = batch.prepared!; const id = prepared.transactionId; const now = new Date().toISOString();
    if (!userSignatureReturned && this.risk) {
      await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: quote.intent.intentId, quoteId: quote.quoteId, action: 'CLEAN_CLAIM', network: quote.intent.network, amountLamports: batch.sponsoredCostLamports, reason: code, userSignatureReturned: false, payerSignatureReturned: false, broadcastAttempted: false }, `${id}:unsigned_release_authorized`);
      const result = await this.releaseExposure(quote, batch);
      await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason: code }, `${id}:unsigned_released`);
    }
    batch.status = 'failed'; quote.status = 'failed';
    await this.durable.updateTransaction(id, { status: 'failed', failedAt: now, errorCode: code, errorStage: stage, updatedAt: now });
    await this.durable.updateIntentStatus(quote.intent.intentId, 'failed');
    await this.durable.appendEvent(id, 'claim_failed', stage, { code, userSignatureReturned, reservationRetained: userSignatureReturned, payerSignatureReturned: false, broadcastAttempted: false, blockHeight }, `${id}:failed:${stage}`);
    await this.persistQuote(quote);
  }
  private refreshRequired() { return new GaslessError('QUOTE_EXPIRED', 'claim_pre_sign', 'Claim preparation expired. Review the Claim again.'); }
}
