import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { assertRelaySimulation, type ValidatedRelayTransaction } from '../../chains/solana/relay/validator.js';
import type { CrossChainStatus } from '../../shared/cross-chain/types.js';
import type { DurableTransactionRecord, TransactionIntent, TransactionStatus } from '../../shared/transactions/types.js';
import { asGaslessError, GaslessError } from '../errors.js';
import { log } from '../observability/logger.js';
import type { RelayClient } from '../relay/client.js';
import { koraFailure, type RelayerProvider } from '../relayer/provider.js';
import type { OperationalRiskService } from '../risk/operational.js';
import type { DurableStore } from '../storage/durable.js';
import type { TemporaryStore } from '../storage/temporary.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { RelayAuthorizationSigner } from './authorization.js';
import { normalizeRelayStatus } from './registry.js';
import { sponsorSignValidatedRelayTransaction, validateUserSignedRelayTransaction } from './sponsorship.js';

const ROBINHOOD_CHAIN_ID = 4663;

export class CrossChainSponsorshipLifecycle {
  constructor(
    private readonly temporary: TemporaryStore,
    private readonly durable: DurableStore,
    private readonly relay: RelayClient,
    private readonly relayer: RelayerProvider,
    private readonly risk: Pick<OperationalRiskService, 'assertRelayerCanSponsor' | 'reserveTransactionExposure' | 'releaseTransactionExposure'>,
    private readonly authorizationSigner?: RelayAuthorizationSigner,
  ) {}

  async prepareSignOnly(validated: ValidatedRelayTransaction) {
    if (!this.authorizationSigner) throw new GaslessError('CONFIGURATION_ERROR', 'cross_chain_authorization', 'Cross-chain signing authorization is not configured.');
    const stored = await this.temporary.getCrossChainQuote(validated.quoteId);
    if (!stored || stored.walletAddress !== validated.wallet || stored.providerRequestId !== validated.relayRequestId || stored.inputAmountRaw !== validated.inputAmountRaw || stored.quote.inputAsset !== validated.inputAsset || stored.quote.outputAsset !== validated.destinationAsset || stored.quote.recipient.toLowerCase() !== validated.recipient.toLowerCase() || Date.parse(stored.quote.expiresAt) < Date.now() || Date.parse(validated.expiresAt) > Date.parse(stored.quote.expiresAt)) throw new GaslessError('MESSAGE_MISMATCH', 'cross_chain_quote_binding', 'The validated Relay transaction does not match its GASLESS quote.');
    if (await this.durable.getTransactionByQuoteId(validated.quoteId)) throw new GaslessError('QUOTE_ALREADY_USED', 'cross_chain_prepare', 'This cross-chain quote already has a signing attempt.');

    const transactionId = crypto.randomUUID();
    const lockKey = `cross-chain-prepare:${validated.quoteId}:${validated.messageHash}`;
    const ttlSeconds = Math.max(1, Math.ceil((Date.parse(validated.expiresAt) - Date.now()) / 1000));
    if (!await this.temporary.acquireReplayLock(lockKey, transactionId, ttlSeconds)) throw new GaslessError('REPLAY_DETECTED', 'cross_chain_prepare', 'This cross-chain signing attempt is already in progress.');

    const exposure = { network: 'mainnet-beta' as const, walletAddress: validated.wallet, action: 'CROSS_CHAIN' as const, transactionId, amountLamports: validated.expectedSponsorMaxLamports };
    let reserved = false;
    let persisted = false;
    try {
      const health = await this.risk.assertRelayerCanSponsor(validated.expectedSponsorMaxLamports);
      if (health === 'warning') log('warn', 'cross_chain_relayer_balance_warning', { transactionId, quoteId: validated.quoteId, sponsorLamports: validated.expectedSponsorMaxLamports });
      await this.risk.reserveTransactionExposure(exposure); reserved = true;
      const now = new Date().toISOString();
      const intent: TransactionIntent = { intentId: crypto.randomUUID(), walletAddress: validated.wallet, actionType: 'CROSS_CHAIN', network: 'mainnet-beta', requestId: validated.relayRequestId, clientRequestId: validated.quoteId, createdAt: now, expiresAt: validated.expiresAt, metadata: { relayOrderId: validated.orderId, messageHash: validated.messageHash } };
      const record: DurableTransactionRecord = { id: transactionId, intentId: intent.intentId, quoteId: validated.quoteId, walletAddress: validated.wallet, actionType: 'CROSS_CHAIN', network: 'mainnet-beta', status: 'validated', preparedMessageHash: validated.messageHash, recentBlockhash: validated.recentBlockhash, lastValidBlockHeight: validated.lastValidBlockHeight, sponsoredCostLamports: String(validated.expectedSponsorMaxLamports), relayerAddress: validated.depositFeePayer, tokenAmountRaw: validated.inputAmountRaw, inputMint: validated.inputMint, sourceAsset: validated.inputAsset, destinationChainId: ROBINHOOD_CHAIN_ID, destinationAsset: validated.destinationAsset, crossChainRecipient: validated.recipient, relayRequestId: validated.relayRequestId, relayOrderId: validated.orderId, quoteExpiresAt: validated.expiresAt, crossChainStatus: 'preparing', createdAt: now, updatedAt: now };
      await this.durable.createIntent(intent, validated.quoteId);
      await this.durable.createTransaction(record); persisted = true;
      await this.durable.appendEvent(transactionId, 'cross_chain_sponsorship_reserved', 'sponsorship_reservation', { quoteId: validated.quoteId, messageHash: validated.messageHash, amountLamports: validated.expectedSponsorMaxLamports }, `${transactionId}:reserved`);
      const sponsorSignedTransaction = await sponsorSignValidatedRelayTransaction(validated, this.relayer, this.authorizationSigner);
      await this.temporary.saveCrossChainAttempt({ transactionId, validated, sponsorSignedTransaction }, ttlSeconds);
      await this.durable.updateTransaction(transactionId, { status: 'awaiting_user_signature', crossChainStatus: 'awaiting_signature', updatedAt: new Date().toISOString() });
      await this.durable.updateIntentStatus(intent.intentId, 'awaiting_user_signature');
      await this.durable.appendEvent(transactionId, 'cross_chain_payer_signed', 'relayer', { quoteId: validated.quoteId, messageHash: validated.messageHash, payer: validated.depositFeePayer }, `${transactionId}:payer_signed`);
      return { transactionId, sponsorSignedTransaction };
    } catch (error) {
      const normalized = asGaslessError(error, 'cross_chain_prepare');
      const failure = koraFailure(error);
      if (failure) log('warn', 'cross_chain_kora_prepare_rejected', { category: failure.category, reason: failure.reason, payerSignatureReturned: failure.payerSignatureReturned, deterministicPreSignRejection: failure.deterministicPreSignRejection });
      if (reserved) await this.risk.releaseTransactionExposure(exposure).catch(() => undefined);
      if (persisted) await this.durable.updateTransaction(transactionId, { status: 'failed', crossChainStatus: 'failed', failedAt: new Date().toISOString(), errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined);
      await this.durable.appendEvent(transactionId, 'cross_chain_prepare_failed', normalized.stage, { code: normalized.code, reservationReleased: reserved }, `${transactionId}:failed`).catch(() => undefined);
      throw normalized;
    }
  }

  async submitSigned(input: { transactionId: string; walletAddress: string; signedTransaction: string; rpc: SolanaRpc }) {
    const record = await this.requireRecord(input.transactionId);
    if (record.walletAddress !== input.walletAddress || record.status !== 'awaiting_user_signature') throw new GaslessError('MESSAGE_MISMATCH', 'cross_chain_submit', 'The signed transaction does not match an active GASLESS bridge attempt.');
    const attempt = await this.temporary.getCrossChainAttempt(input.transactionId);
    if (!attempt || attempt.transactionId !== input.transactionId || attempt.validated.quoteId !== record.quoteId || attempt.validated.messageHash !== record.preparedMessageHash) throw new GaslessError('QUOTE_EXPIRED', 'cross_chain_submit', 'The cross-chain signing attempt expired. Request a fresh quote.');
    const fullySigned = validateUserSignedRelayTransaction(attempt.sponsorSignedTransaction, input.signedTransaction, attempt.validated);
    const transaction = VersionedTransaction.deserialize(Buffer.from(fullySigned, 'base64'));
    const canonicalSignature = bs58.encode(transaction.signatures[0]);
    const lockValue = crypto.randomUUID();
    if (!await this.temporary.acquireReplayLock(`cross-chain-submit:${input.transactionId}`, lockValue, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'cross_chain_submit', 'This cross-chain transaction was already submitted.');
    let broadcastAttempted = false;
    try {
      const now = new Date().toISOString();
      await this.durable.updateTransaction(input.transactionId, { status: 'user_signed', updatedAt: now });
      await this.durable.updateIntentStatus(record.intentId, 'user_signed');
      await this.durable.appendEvent(input.transactionId, 'cross_chain_user_signed', 'user_signature', { messageHash: attempt.validated.messageHash }, `${input.transactionId}:user_signed`);
      await assertFinalSimulation(input.rpc, fullySigned, attempt.validated);
      await this.durable.updateTransaction(input.transactionId, { status: 'relaying', signature: canonicalSignature, updatedAt: new Date().toISOString() });
      await this.durable.updateIntentStatus(record.intentId, 'relaying');
      await this.durable.appendEvent(input.transactionId, 'cross_chain_final_simulation_passed', 'final_signed_simulation', { messageHash: attempt.validated.messageHash, sponsorLamports: attempt.validated.expectedSponsorMaxLamports }, `${input.transactionId}:simulation`);
      const heights = await input.rpc.getBlockHeightsAcrossProviders();
      const readableHeights = heights.flatMap((observation) => observation.value === undefined ? [] : [observation.value]);
      if (!readableHeights.length) throw new GaslessError('RPC_ERROR', 'cross_chain_broadcast', 'Solana Mainnet is temporarily unavailable.', true);
      const blockHeight = Math.max(...readableHeights);
      if (attempt.validated.lastValidBlockHeight - blockHeight < 20) throw new GaslessError('QUOTE_EXPIRED', 'cross_chain_broadcast', 'This bridge preparation expired. Request a fresh quote.');
      const observations = await input.rpc.broadcastRawTransactionAcrossProviders(fullySigned);
      const accepted = observations.some((observation) => observation.category === 'accepted' || observation.category === 'already_processed');
      const ambiguous = observations.some((observation) => observation.category === 'timeout' || observation.category === 'rpc_error');
      broadcastAttempted = accepted || ambiguous;
      for (const observation of observations) {
        if (observation.returnedSignature && observation.returnedSignature !== canonicalSignature) throw new GaslessError('MESSAGE_MISMATCH', 'cross_chain_broadcast', 'Solana returned an unexpected transaction signature.');
        await this.durable.appendEvent(input.transactionId, 'cross_chain_broadcast_observed', 'submitted', { signature: canonicalSignature, provider: observation.provider, category: observation.category, blockHeight, remainingBlocks: attempt.validated.lastValidBlockHeight - blockHeight }, `${input.transactionId}:broadcast:${observation.provider}`);
      }
      if (!accepted && !ambiguous) throw new GaslessError('RPC_ERROR', 'cross_chain_broadcast', 'Solana Mainnet rejected the transaction.', true);
      const submittedAt = new Date().toISOString();
      await this.durable.updateTransaction(input.transactionId, { status: 'submitted', crossChainStatus: 'submitted', signature: canonicalSignature, submittedAt, updatedAt: submittedAt });
      await this.durable.updateIntentStatus(record.intentId, 'submitted');
      await this.durable.appendEvent(input.transactionId, 'cross_chain_submitted', 'submitted', { signature: canonicalSignature, providers: observations.map((observation) => ({ provider: observation.provider, category: observation.category })), messageHash: attempt.validated.messageHash }, `${input.transactionId}:submitted`);
      const confirmation = await confirmSource(input.rpc, canonicalSignature, attempt.validated.lastValidBlockHeight);
      if (confirmation === 'chain_error') {
        await this.durable.updateTransaction(input.transactionId, { status: 'failed', crossChainStatus: 'failed', failedAt: new Date().toISOString(), errorCode: 'CHAIN_EXECUTION_FAILED', errorStage: 'cross_chain_source', updatedAt: new Date().toISOString() });
        await this.release(record);
        throw new GaslessError('CHAIN_EXECUTION_FAILED', 'cross_chain_source', 'The source transaction failed on Solana.');
      }
      if (confirmation === 'expired') throw new GaslessError('QUOTE_EXPIRED', 'cross_chain_source', 'The source transaction expired before confirmation. Request a fresh quote.');
      let sponsorCostLamports: string | undefined;
      if (confirmation === 'confirmed') {
        const chain = await input.rpc.getTransaction(canonicalSignature);
        if (chain?.meta.err === null) sponsorCostLamports = String(chain.meta.fee);
        await this.durable.updateTransaction(input.transactionId, { status: 'submitted', crossChainStatus: 'source_confirmed', networkFeeLamports: sponsorCostLamports, updatedAt: new Date().toISOString() });
        await this.durable.appendEvent(input.transactionId, 'cross_chain_source_confirmed', 'source_confirmation', { signature: canonicalSignature, sponsorCostLamports }, `${input.transactionId}:source_confirmed`);
      }
      return { transactionId: input.transactionId, quoteId: record.quoteId, signature: canonicalSignature, sourceStatus: confirmation === 'confirmed' ? 'confirmed' as const : 'pending' as const, sponsorCostLamports };
    } catch (error) {
      const normalized = asGaslessError(error, 'cross_chain_submit');
      if (!broadcastAttempted || normalized.code === 'CHAIN_EXECUTION_FAILED') {
        await this.release(record).catch(() => undefined);
        await this.durable.updateTransaction(input.transactionId, { status: 'failed', crossChainStatus: 'failed', failedAt: new Date().toISOString(), errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined);
      } else await this.durable.updateTransaction(input.transactionId, { status: 'submitted', crossChainStatus: 'submitted', signature: canonicalSignature, errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined);
      await this.durable.appendEvent(input.transactionId, 'cross_chain_submit_failed', normalized.stage, { code: normalized.code, broadcastAttempted }, `${input.transactionId}:submit_failed:${normalized.code}`).catch(() => undefined);
      throw normalized;
    }
  }

  async abortSignOnly(transactionId: string, reason = 'sign_only_proof_complete') {
    const record = await this.requireRecord(transactionId);
    const result = await this.release(record);
    if (record.status !== 'failed') await this.durable.updateTransaction(transactionId, { status: 'failed', crossChainStatus: 'failed', failedAt: new Date().toISOString(), errorCode: 'ACTION_DISABLED', errorStage: reason, updatedAt: new Date().toISOString() });
    await this.durable.appendEvent(transactionId, 'cross_chain_sponsorship_released', 'sponsorship_release', { reason, result }, `${transactionId}:released`);
    return result;
  }

  async expire(transactionId: string, now = Date.now()) {
    const record = await this.requireRecord(transactionId);
    if (!record.quoteExpiresAt || Date.parse(record.quoteExpiresAt) > now) throw new GaslessError('INVALID_REQUEST', 'cross_chain_expiry', 'The cross-chain signing attempt has not expired.');
    const result = await this.release(record);
    await this.durable.updateTransaction(transactionId, { status: 'expired', crossChainStatus: 'failed', failedAt: new Date(now).toISOString(), errorCode: 'QUOTE_EXPIRED', errorStage: 'cross_chain_expiry', updatedAt: new Date(now).toISOString() });
    await this.durable.appendEvent(transactionId, 'cross_chain_expired', 'cross_chain_expiry', { result }, `${transactionId}:expired`);
    return result;
  }

  async reconcile(transactionId: string, walletAddress?: string): Promise<{ transactionId: string; quoteId: string; status: CrossChainStatus; signature?: string; relayRequestId?: string; sponsorCostLamports?: string }> {
    const record = await this.requireRecord(transactionId);
    if (walletAddress && record.walletAddress !== walletAddress) throw new GaslessError('QUOTE_NOT_FOUND', 'cross_chain_record', 'The cross-chain transaction record was not found.');
    if (record.status === 'failed' || record.status === 'expired' || Boolean(record.failedAt && record.errorCode)) {
      if (record.status !== 'failed' || record.crossChainStatus !== 'failed') await this.durable.updateTransaction(transactionId, { status: 'failed', crossChainStatus: 'failed', updatedAt: new Date().toISOString() });
      return { transactionId, quoteId: record.quoteId, status: 'failed', signature: record.signature, relayRequestId: record.relayRequestId, sponsorCostLamports: record.networkFeeLamports };
    }
    if (!record.relayRequestId) throw new GaslessError('DATABASE_ERROR', 'cross_chain_reconciliation', 'The Relay request binding is missing.');
    const result = await this.relay.status(record.relayRequestId);
    if (result.originChainId !== undefined && result.originChainId !== 792703809 || result.destinationChainId !== undefined && result.destinationChainId !== ROBINHOOD_CHAIN_ID) throw new GaslessError('RECONCILIATION_FAILED', 'cross_chain_reconciliation', 'Relay returned an unexpected route identity.');
    const normalized = normalizeRelayStatus(result.status);
    const status = normalized === 'unknown_retryable' && record.crossChainStatus === 'source_confirmed' ? 'source_confirmed' : normalized;
    const terminal = status === 'completed' || status === 'failed' || status === 'refunded';
    const durableStatus: TransactionStatus = status === 'completed' || status === 'refunded' ? 'reconciled' : status === 'failed' ? 'failed' : status === 'awaiting_signature' ? 'awaiting_user_signature' : 'submitted';
    if (record.crossChainStatus !== status || record.status !== durableStatus) await this.durable.updateTransaction(transactionId, { status: durableStatus, crossChainStatus: status, confirmedAt: status === 'completed' ? new Date().toISOString() : undefined, failedAt: status === 'failed' ? new Date().toISOString() : undefined, updatedAt: new Date().toISOString() });
    await this.durable.appendEvent(transactionId, 'cross_chain_reconciled', 'cross_chain_reconciliation', { status }, `${transactionId}:relay:${status}`);
    if (terminal) await this.release(record);
    return { transactionId, quoteId: record.quoteId, status, signature: record.signature, relayRequestId: record.relayRequestId, sponsorCostLamports: record.networkFeeLamports };
  }

  private async release(record: DurableTransactionRecord) {
    return this.risk.releaseTransactionExposure({ network: record.network, walletAddress: record.walletAddress, action: 'CROSS_CHAIN', transactionId: record.id, amountLamports: Number(record.sponsoredCostLamports) });
  }

  private async requireRecord(transactionId: string) {
    const record = await this.durable.getTransaction(transactionId);
    if (!record || record.actionType !== 'CROSS_CHAIN') throw new GaslessError('QUOTE_NOT_FOUND', 'cross_chain_record', 'The cross-chain transaction record was not found.');
    return record;
  }
}

async function confirmSource(rpc: SolanaRpc, signature: string, lastValidBlockHeight: number) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const statuses = await rpc.getSignatureStatusesAcrossProviders(signature);
    if (statuses.some((observation) => observation.value?.err)) return 'chain_error' as const;
    if (statuses.some((observation) => observation.value?.confirmationStatus === 'confirmed' || observation.value?.confirmationStatus === 'finalized')) return 'confirmed' as const;
    const heights = await rpc.getBlockHeightsAcrossProviders();
    const allStatusesAbsent = statuses.length > 0 && statuses.every((observation) => observation.errorCategory === undefined && observation.value === null);
    const allProvidersExpired = heights.length > 0 && heights.every((observation) => observation.errorCategory === undefined && observation.value !== undefined && observation.value > lastValidBlockHeight);
    if (allStatusesAbsent && allProvidersExpired) return 'expired' as const;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return 'pending' as const;
}

async function assertFinalSimulation(rpc: SolanaRpc, fullySigned: string, validated: ValidatedRelayTransaction) {
  const addresses = finalSimulationAccounts(validated);
  const before = await Promise.all(addresses.map((address) => rpc.getAccountInfo(address)));
  const simulation = await rpc.simulateTransactionWithAccounts(fullySigned, true, addresses);
  assertRelaySimulation(simulation, validated);
  const after = simulation.accounts ?? [];
  if (after.length !== addresses.length || before.some((account) => !account) || after.some((account) => !account)) throw new GaslessError('SIMULATION_FAILED', 'relay_simulation_accounts', 'The final cross-chain simulation could not verify every bounded account change.');
  const account = (address: string, values: typeof before | typeof after) => values[addresses.indexOf(address)]!;
  const payerDelta = account(validated.depositFeePayer, after).lamports - account(validated.depositFeePayer, before).lamports;
  if (payerDelta !== -validated.expectedSponsorMaxLamports) throw new GaslessError('SIMULATION_FAILED', 'relay_simulation_sponsor', 'The final cross-chain simulation exceeded the approved sponsor cost.');
  const amount = BigInt(validated.inputAmountRaw);
  const sourceDelta = validated.inputAsset === 'SOL'
    ? BigInt(account(validated.expectedSourceAccount, after).lamports - account(validated.expectedSourceAccount, before).lamports)
    : tokenAmount(account(validated.expectedSourceAccount, after).data[0]) - tokenAmount(account(validated.expectedSourceAccount, before).data[0]);
  const vaultDelta = validated.inputAsset === 'SOL'
    ? BigInt(account(validated.expectedVaultAccount, after).lamports - account(validated.expectedVaultAccount, before).lamports)
    : tokenAmount(account(validated.expectedVaultAccount, after).data[0]) - tokenAmount(account(validated.expectedVaultAccount, before).data[0]);
  if (sourceDelta !== -amount || vaultDelta !== amount) throw new GaslessError('SIMULATION_FAILED', 'relay_simulation_value', 'The final cross-chain simulation produced an unexpected value movement.');
}

export function finalSimulationAccounts(validated: Pick<ValidatedRelayTransaction, 'depositFeePayer' | 'expectedSourceAccount' | 'expectedVaultAccount'>) {
  return [...new Set([validated.depositFeePayer, validated.expectedSourceAccount, validated.expectedVaultAccount])];
}

function tokenAmount(data: string) {
  const value = Buffer.from(data, 'base64');
  if (value.length !== 165) throw new GaslessError('SIMULATION_FAILED', 'relay_simulation_accounts', 'The final cross-chain token state is invalid.');
  return value.readBigUInt64LE(64);
}
