import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { discoverBurnAccounts, inspectBurnAccount } from '../../chains/solana/burn/accounts.js';
import { calculateBurnFee, prepareBurnTransaction, validateSignedBurn } from '../../chains/solana/transactions/burn.js';
import { versionedMessageHash, versionedSignerSignatureIsValid } from '../../chains/solana/transactions/clean.js';
import type { BurnAccount, BurnDiscoveryResult, DurableTransactionRecord, ReconciliationResult, SolanaNetwork, TransactionIntent, TransactionQuote } from '../../shared/transactions/types.js';
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
import { broadcastAndConfirmClean, confirmCleanSignature, observeCleanSignature, recordCleanConfirmationObservation, type CleanConfirmation } from '../clean/submission.js';

interface BurnPolicy { feeDestination?: string; feeBps: number; minimumUserPayoutLamports: number; maximumNetworkFeeLamports: number; relayerLowBalanceThresholdLamports: number; recoverAllowedMints?: string[] }

export class BurnEngine {
  constructor(private readonly temporary: TemporaryStore, private readonly durable: DurableStore, private readonly rpc: SolanaRpc, private readonly relayer: RelayerProvider, private readonly controls: EmergencyControlService, private readonly quoteTtlSeconds: number, private readonly policy: BurnPolicy, private readonly risk?: Pick<OperationalRiskService, 'releaseTransactionExposure'>) {}

  async discover(walletAddress: string): Promise<BurnDiscoveryResult> {
    try { new PublicKey(walletAddress); } catch { throw new GaslessError('SESSION_ERROR', 'burn_discovery', 'Connect a valid Solana wallet.'); }
    const discovery = await discoverBurnAccounts(this.rpc, walletAddress);
    const recoverable = new Set(this.policy.recoverAllowedMints ?? []);
    const mark = (account: BurnAccount) => ({ ...account, recoverValueAvailable: recoverable.has(account.mint) });
    const accounts = discovery.accounts.map(mark);
    return { ...discovery, accounts, eligibleAccounts: accounts.filter((account) => account.eligible), skippedAccounts: accounts.filter((account) => !account.eligible) };
  }

  async reconcileStatus(quoteId: string, walletAddress: string, network: SolanaNetwork) {
    const record = await this.durable.getTransactionByQuoteId(quoteId);
    if (!record || record.actionType !== 'CLEAN_BURN') return { status: 'not_submitted' as const };
    if (record.walletAddress !== walletAddress || record.network !== network) throw new GaslessError('SESSION_ERROR', 'burn_reconciliation', 'This Burn belongs to a different wallet or network.');
    if (record.status === 'reconciled') return { status: 'confirmed' as const, transactionId: record.id, signature: record.signature };
    if (record.status === 'failed') return { status: 'failed' as const, transactionId: record.id, signature: record.signature };
    if (record.status !== 'submitted' || !record.signature) return { status: 'not_submitted' as const, transactionId: record.id };
    const confirmation = await observeCleanSignature(this.rpc, record.signature, record.lastValidBlockHeight);
    if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'burn', transactionId: record.id, signedMessageHash: record.preparedMessageHash, confirmation });
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
    return { status: 'pending' as const, transactionId: record.id, signature: record.signature, blockHeight: confirmation.blockHeight };
  }

  async createQuote(input: { walletAddress: string; network: SolanaNetwork; tokenAccount: string; clientRequestId: string; requestId: string }) {
    await this.controls.assertExecutionAllowed('CLEAN_BURN', input.network);
    if (!await this.temporary.consumeRateLimit(`burn-quote:${input.walletAddress}`, 10, 60)) throw new GaslessError('RATE_LIMITED', 'burn_quote', 'Too many Burn requests. Wait a minute and try again.', true);
    let selected: PublicKey; try { selected = new PublicKey(input.tokenAccount); } catch { throw new GaslessError('INVALID_REQUEST', 'burn_quote', 'Select a valid burnable token.'); }
    const lock = `burn-request:${input.walletAddress}:${input.clientRequestId}`;
    if (!await this.temporary.acquireReplayLock(lock, input.requestId, this.quoteTtlSeconds)) throw new GaslessError('REPLAY_DETECTED', 'burn_quote', 'This Burn request was already received.');
    this.assertPolicy();
    const discovery = await this.discover(input.walletAddress);
    const account = discovery.eligibleAccounts.find((item) => item.address === selected.toBase58());
    if (!account) throw new GaslessError('TOKEN_UNSUPPORTED', 'burn_quote', 'This asset is not available for Burn. Scan again or choose another token.');
    if (input.walletAddress === this.policy.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'burn_configuration', 'The Burn fee destination cannot be the connected wallet.');
    const fee = calculateBurnFee(BigInt(account.recoverableLamports), this.policy.feeBps);
    const now = Date.now();
    const intent: TransactionIntent = { intentId: crypto.randomUUID(), walletAddress: input.walletAddress, actionType: 'CLEAN_BURN', network: input.network, requestId: input.requestId, clientRequestId: input.clientRequestId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.quoteTtlSeconds * 1000).toISOString(), metadata: { schemaVersion: 'burn-v1', tokenAccount: account.address, mint: account.mint } };
    const quote: TransactionQuote = { quoteId: crypto.randomUUID(), intent, status: 'created', createdAt: intent.createdAt, expiresAt: intent.expiresAt, burn: { schemaVersion: 'burn-v1', account, feeBps: this.policy.feeBps, feeDestination: this.policy.feeDestination!, reclaimedRentLamports: account.recoverableLamports, gaslessFeeLamports: fee.toString(), status: 'created' } };
    await this.temporary.saveQuote(quote, this.quoteTtlSeconds); await this.durable.createIntent(intent, quote.quoteId);
    log('info', 'burn_quote_created', { requestId: input.requestId, quoteId: quote.quoteId, walletAddress: input.walletAddress, tokenAccount: account.address, mint: account.mint, tokenAmountRaw: account.tokenAmountRaw, reclaimedRentLamports: account.recoverableLamports, feeLamports: fee.toString() });
    return quote;
  }

  async prepare(quoteId: string, walletAddress: string, requestId: string, deferSigningWindow = false) {
    const quote = await this.requireQuote(quoteId, walletAddress); await this.controls.assertExecutionAllowed('CLEAN_BURN', quote.intent.network);
    if (!quote.burn) throw new GaslessError('INVALID_REQUEST', 'burn_prepare', 'This is not a Burn quote.');
    if (quote.burn.prepared) {
      if (!deferSigningWindow && !signingDeadlineHasMargin(quote.burn.prepared.walletSigningExpiresAt)) throw this.refreshRequired();
      return quote;
    }
    await this.recheckAccount(quote.burn.account, walletAddress);
    const feePayer = await this.relayer.getFeePayerPublicKey();
    if (feePayer === quote.burn.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'burn_prepare', 'The Burn fee destination must be separate from the GASLESS relayer.');
    const result = await prepareBurnTransaction({ quote, account: quote.burn.account, gaslessFeeLamports: BigInt(quote.burn.gaslessFeeLamports), minimumUserPayoutLamports: BigInt(this.policy.minimumUserPayoutLamports), feePayer, feeDestination: quote.burn.feeDestination, rpc: this.rpc });
    const currentBlockHeight = await this.rpc.getBlockHeight();
    if (result.prepared.lastValidBlockHeight - currentBlockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'burn_blockhash_margin', 'Burn preparation is no longer fresh. Review the Burn again.');
    result.prepared.preparedBlockHeight = currentBlockHeight;
    Object.assign(quote.burn, { expectedRelayer: feePayer, prepared: result.prepared, sponsoredCostLamports: result.sponsoredCostLamports.toString(), netUserLamports: result.netUserLamports.toString(), status: 'awaiting_user_signature' });
    quote.status = 'awaiting_user_signature';
    const now = new Date().toISOString();
    const record: DurableTransactionRecord = { id: result.prepared.transactionId, intentId: quote.intent.intentId, quoteId, walletAddress, actionType: 'CLEAN_BURN', network: quote.intent.network, status: 'awaiting_user_signature', preparedMessageHash: result.prepared.preparedMessageHash, recentBlockhash: result.prepared.recentBlockhash, lastValidBlockHeight: result.prepared.lastValidBlockHeight, batchIndex: 0, accountAddresses: [quote.burn.account.address], grossRecoveredLamports: quote.burn.reclaimedRentLamports, gaslessFeeLamports: quote.burn.gaslessFeeLamports, sponsoredCostLamports: quote.burn.sponsoredCostLamports, netUserLamports: quote.burn.netUserLamports, relayerAddress: feePayer, feeDestination: quote.burn.feeDestination, mint: quote.burn.account.mint, tokenAccount: quote.burn.account.address, tokenAmountRaw: quote.burn.account.tokenAmountRaw, tokenDecimals: quote.burn.account.decimals, mintSupplyRaw: quote.burn.account.mintSupplyRaw, createdAt: now, updatedAt: now };
    await this.durable.createTransaction(record); await this.durable.appendEvent(record.id, 'burn_attempted', 'prepared', { simulation: 'passed', provider: result.prepared.simulation.provider, recentBlockhash: result.prepared.recentBlockhash, lastValidBlockHeight: result.prepared.lastValidBlockHeight, preparedMessageHash: result.prepared.preparedMessageHash }, `${record.id}:prepared`); await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
    log('info', 'burn_prepared', { requestId, quoteId, walletAddress, tokenAccount: record.tokenAccount, sponsoredCostLamports: record.sponsoredCostLamports, netLamports: record.netUserLamports });
    return deferSigningWindow ? quote : this.activateSigningWindow(quote, requestId);
  }

  async activateSigningWindow(quote: TransactionQuote, requestId: string) {
    const prepared = quote.burn?.prepared;
    if (!prepared) throw new GaslessError('INVALID_REQUEST', 'burn_prepare', 'The Burn preparation was not completed.');
    if (signingDeadlineHasMargin(prepared.walletSigningExpiresAt)) return quote;
    try {
      await this.recheckAccount(quote.burn!.account, quote.intent.walletAddress);
      const currentBlockHeight = await this.rpc.getBlockHeight();
      const window = createSendSigningWindow(prepared.lastValidBlockHeight, currentBlockHeight);
      if (!window) throw new GaslessError('QUOTE_EXPIRED', 'burn_blockhash_margin', 'Burn preparation is no longer fresh. Review the Burn again.');
      Object.assign(prepared, { walletSigningReadyAt: window.readyAt, walletSigningExpiresAt: window.walletSigningExpiresAt, walletSigningWindowMs: window.walletSigningWindowMs, preparedBlockHeight: window.preparedBlockHeight });
      quote.expiresAt = window.quoteExpiresAt; quote.intent.expiresAt = window.quoteExpiresAt;
      await this.persistQuote(quote);
      log('info', 'burn_wallet_window_started', { requestId, quoteId: quote.quoteId, transactionId: prepared.transactionId, preparedBlockHeight: prepared.preparedBlockHeight, lastValidBlockHeight: prepared.lastValidBlockHeight });
      return quote;
    } catch (error) {
      await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('RPC_ERROR', 'burn_wallet_gate', 'Burn safety could not be verified.', true));
      throw error;
    }
  }

  async abortBeforeWallet(quote: TransactionQuote, error: unknown) {
    await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('SPONSOR_LIMIT_EXCEEDED', 'sponsorship_policy', 'Sponsored transactions are temporarily unavailable.', true));
  }

  async currentWalletGateBlockHeight(quoteId: string, walletAddress: string) {
    const quote = await this.requireQuote(quoteId, walletAddress);
    try {
      const prepared = quote.burn?.prepared;
      if (!prepared || !signingDeadlineHasMargin(prepared.walletSigningExpiresAt)) throw this.refreshRequired();
      await this.controls.assertExecutionAllowed('CLEAN_BURN', quote.intent.network);
      await this.recheckAccount(quote.burn!.account, walletAddress);
      const blockHeight = await this.rpc.getBlockHeight();
      if (prepared.lastValidBlockHeight - blockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'burn_blockhash_margin', 'Burn preparation is no longer fresh. Review the Burn again.');
      return blockHeight;
    } catch (error) {
      await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('RPC_ERROR', 'burn_wallet_gate', 'Burn safety could not be verified.', true));
      throw error;
    }
  }

  async currentWalletApprovalBlockHeight(quoteId: string, walletAddress: string) {
    await this.requireWalletQuote(quoteId, walletAddress);
    return this.rpc.getBlockHeight();
  }

  async recordWalletEvent(quoteId: string, walletAddress: string, event: string, metadata: Record<string, unknown> = {}) {
    const quote = await this.requireWalletQuote(quoteId, walletAddress); const prepared = quote.burn!.prepared!;
    if (!new Set(['invoked', 'returned', 'failed', 'expired']).has(event)) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'Unknown wallet event.');
    const blockHeight = await this.rpc.getBlockHeight();
    const safeMetadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 240) : value]));
    await this.durable.appendEvent(prepared.transactionId, `burn_wallet_${event}`, 'wallet_signing', { ...safeMetadata, blockHeight, remainingBlocks: prepared.lastValidBlockHeight - blockHeight }, `${prepared.transactionId}:wallet:${event}`);
  }

  async abortWalletApproval(quoteId: string, walletAddress: string, reason: string, userSignatureReturned: boolean) {
    const quote = await this.requireWalletQuote(quoteId, walletAddress, true); const prepared = quote.burn!.prepared!;
    if (quote.status === 'failed') return { status: 'failed' as const };
    const allowed = new Set(['USER_EXPLICITLY_CANCELLED', 'WALLET_SIGNING_TIMEOUT', 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', 'WALLET_PROVIDER_ERROR', 'WALLET_ACCOUNT_CHANGED', 'APP_ABORTED_SIGNING_FLOW', 'SESSION_DISCONNECTED', 'UNKNOWN_WALLET_FAILURE']);
    if (!allowed.has(reason)) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'Unknown wallet failure.');
    const blockHeight = await this.rpc.getBlockHeight(); const remainingBlocks = prepared.lastValidBlockHeight - blockHeight;
    if (reason === 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN' && !userSignatureReturned && remainingBlocks >= 0) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The wallet attempt is not yet provably expired.');
    if (userSignatureReturned && remainingBlocks >= SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The signed Burn still has a safe submission margin.');
    await this.failAfterWallet(quote, reason, userSignatureReturned, blockHeight);
    return { status: 'failed' as const };
  }

  async abortWalletGate(quoteId: string, walletAddress: string, reason: string) {
    const quote = await this.requireQuote(quoteId, walletAddress, true, true);
    if (quote.status === 'failed') return;
    const error = reason === 'blockhash_margin' ? new GaslessError('QUOTE_EXPIRED', 'burn_blockhash_margin', 'Burn preparation is no longer fresh. Review the Burn again.') : this.refreshRequired();
    await this.failBeforeWallet(quote, error);
  }

  async submit(input: { quoteId: string; walletAddress: string; signedTransaction: string; clientRequestId: string; requestId: string }) {
    const quote = await this.requireQuote(input.quoteId, input.walletAddress, true); const burn = quote.burn;
    if (!burn?.prepared) throw new GaslessError('INVALID_REQUEST', 'burn_submit', 'Prepare this Burn before submitting it.');
    if (burn.status === 'reconciled' && burn.signature && burn.reconciliation) return { transactionId: burn.prepared.transactionId, signature: burn.signature, reconciliation: burn.reconciliation, alreadyCompleted: true };
    if (burn.status === 'submitted' && burn.signature) {
      const confirmation = await confirmCleanSignature(this.rpc, burn.signature, burn.prepared.lastValidBlockHeight);
      if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'burn', transactionId: burn.prepared.transactionId, signedMessageHash: burn.prepared.preparedMessageHash, confirmation });
      const reconciliation = confirmation.outcome === 'expired'
        ? await this.expireSubmittedBurn(burn, burn.signature)
        : await this.reconcile(burn, input.walletAddress, confirmation);
      if (reconciliation.status === 'confirmed') {
        burn.status = 'reconciled'; burn.reconciliation = reconciliation; quote.status = 'reconciled';
        await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status); await this.releaseSuccessfulExposure(quote);
        return { transactionId: burn.prepared.transactionId, signature: burn.signature, confirmation, reconciliation, alreadyCompleted: true };
      }
      throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Burn was submitted but its final result could not be verified yet.', true);
    }
    await this.controls.assertExecutionAllowed('CLEAN_BURN', quote.intent.network);
    if (!await this.temporary.consumeRateLimit(`burn-submit:${input.walletAddress}`, 5, 60)) throw new GaslessError('RATE_LIMITED', 'burn_submit', 'Too many Burn submission attempts. Wait a minute and try again.', true);
    const replayKeys = [`burn-submission:${input.quoteId}`, `message:${burn.prepared.preparedMessageHash}`, `burn-submit-request:${input.walletAddress}:${input.clientRequestId}`]; const acquired: string[] = [];
    let crossed = false; let koraSigningReturned = false; let submissionSignature: string | undefined;
    try {
      for (const key of replayKeys) { if (!await this.temporary.acquireReplayLock(key, input.requestId, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Burn was already submitted.'); acquired.push(key); }
      const signedReturnBlockHeight = await this.rpc.getBlockHeight();
      if (burn.prepared.lastValidBlockHeight - signedReturnBlockHeight < SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'wallet_signing', 'Burn preparation expired while awaiting wallet approval. Nothing was submitted.');
      const validated = await validateSignedBurn(input.signedTransaction, burn.prepared, this.rpc);
      if (validated.messageHash !== burn.prepared.preparedMessageHash) { const finalMessageKey = `message:${validated.messageHash}`; if (!await this.temporary.acquireReplayLock(finalMessageKey, input.requestId, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Burn was already submitted.'); acquired.push(finalMessageKey); }
      await this.recheckAccount(burn.account, input.walletAddress); await this.controls.assertExecutionAllowed('CLEAN_BURN', quote.intent.network);
      const transaction = VersionedTransaction.deserialize(Buffer.from(validated.serializedTransaction, 'base64')); const predictedFee = await this.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
      if (predictedFee === null || String(predictedFee) !== burn.sponsoredCostLamports || predictedFee > this.policy.maximumNetworkFeeLamports) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The Burn network cost no longer matches the preview.');
      if (await this.rpc.getBalance(burn.prepared.expectedFeePayer) < predictedFee + this.policy.relayerLowBalanceThresholdLamports) throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_boundary', 'GASLESS sponsorship is temporarily unavailable.');
      crossed = true; burn.status = 'relaying'; await this.persistQuote(quote); await this.durable.updateTransaction(burn.prepared.transactionId, { status: 'relaying', updatedAt: new Date().toISOString() });
      const koraSigningStartedAt = new Date().toISOString();
      const fullySigned = await this.relayer.signTransaction(validated.serializedTransaction);
      koraSigningReturned = true;
      const koraSigningReturnedAt = new Date().toISOString();
      const signedTransaction = VersionedTransaction.deserialize(Buffer.from(fullySigned, 'base64'));
      if (versionedMessageHash(signedTransaction) !== validated.messageHash || signedTransaction.message.recentBlockhash !== burn.prepared.recentBlockhash) throw new GaslessError('MESSAGE_MISMATCH', 'relayer_boundary', 'The signed Burn changed after approval. Nothing was submitted.');
      if (!versionedSignerSignatureIsValid(signedTransaction, 0, burn.prepared.expectedFeePayer)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The Burn payer signature is invalid. Nothing was submitted.');
      const simulation = await this.rpc.simulateTransaction(fullySigned, true);
      if (simulation.err !== null) throw new GaslessError('SIMULATION_FAILED', 'final_signed_simulation', "This Burn couldn't be safely completed. Nothing was submitted.");
      await this.durable.appendEvent(burn.prepared.transactionId, 'burn_fully_signed', 'relayer', { koraSigningStartedAt, koraSigningReturnedAt, preparedMessageHash: burn.prepared.preparedMessageHash, walletReturnedMessageHash: validated.messageHash, koraSignedMessageHash: validated.messageHash, submittedMessageHash: validated.messageHash, userSignatureReturned: true, payerSignatureReturned: true, finalSimulation: 'passed' }, `${burn.prepared.transactionId}:fully_signed`);
      await this.durable.appendEvent(burn.prepared.transactionId, 'burn_submission_attempted', 'submitted', { preparedMessageHash: burn.prepared.preparedMessageHash }, `${burn.prepared.transactionId}:submission_attempted`);
      const canonicalSignature = bs58.encode(signedTransaction.signatures[0]);
      submissionSignature = canonicalSignature; burn.signature = canonicalSignature; burn.status = 'submitted'; quote.status = 'submitted';
      const submittedAt = new Date().toISOString();
      await this.durable.updateTransaction(burn.prepared.transactionId, { status: 'submitted', signature: canonicalSignature, submittedAt, updatedAt: submittedAt });
      await this.durable.appendEvent(burn.prepared.transactionId, 'burn_submitted', 'submitted', { signature: canonicalSignature, recentBlockhash: burn.prepared.recentBlockhash, lastValidBlockHeight: burn.prepared.lastValidBlockHeight, signedMessageHash: validated.messageHash }, `${burn.prepared.transactionId}:submitted`);
      await this.persistQuote(quote);
      const confirmation = await broadcastAndConfirmClean({ rpc: this.rpc, durable: this.durable, eventPrefix: 'burn', prepared: burn.prepared, fullySigned, canonicalSignature, signedMessageHash: validated.messageHash });
      const reconciliation = confirmation.outcome === 'expired' ? await this.expireSubmittedBurn(burn, canonicalSignature) : await this.reconcile(burn, input.walletAddress, confirmation);
      burn.reconciliation = reconciliation; burn.status = reconciliation.status === 'confirmed' ? 'reconciled' : reconciliation.status === 'failed' ? 'failed' : 'submitted'; quote.status = burn.status;
      await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
      if (reconciliation.status !== 'confirmed') throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Burn was submitted but its final result could not be verified yet.', true);
      await this.releaseSuccessfulExposure(quote);
      log('info', 'burn_reconciled', { requestId: input.requestId, quoteId: input.quoteId, transactionId: burn.prepared.transactionId, signature: canonicalSignature, status: reconciliation.status });
      return { transactionId: burn.prepared.transactionId, signature: canonicalSignature, confirmation, reconciliation, alreadyCompleted: false };
    } catch (error) {
      const normalized = asGaslessError(error, 'burn_submit', input.requestId);
      if (!crossed) for (const key of acquired) await this.temporary.releaseReplayLockIfSafe(key, input.requestId);
      if (!submissionSignature) {
        burn.status = crossed ? 'failed' : 'awaiting_user_signature'; quote.status = burn.status;
        if (crossed && koraSigningReturned) await this.releaseDeterministicNoBroadcastExposure(quote, normalized.code).catch(() => undefined);
        await this.persistQuote(quote).catch(() => undefined); await this.durable.updateTransaction(burn.prepared.transactionId, { status: burn.status, failedAt: crossed ? new Date().toISOString() : undefined, errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined);
      }
      await this.durable.appendEvent(burn.prepared.transactionId, 'burn_failed', normalized.stage, { code: normalized.code }, `${burn.prepared.transactionId}:failed:${normalized.code}`).catch(() => undefined); log(normalized.code === 'REPLAY_DETECTED' ? 'warn' : 'error', 'burn_rejected', { requestId: input.requestId, quoteId: input.quoteId, transactionId: burn.prepared.transactionId, code: normalized.code, stage: normalized.stage }); throw normalized;
    }
  }

  private async recheckAccount(expected: BurnAccount, walletAddress: string) {
    const [account, mint] = await this.rpc.getMultipleAccounts([expected.address, expected.mint]);
    if (!account) throw new GaslessError('MESSAGE_MISMATCH', 'burn_state_recheck', 'This token account changed after the preview. Scan again.');
    const current = inspectBurnAccount(expected.address, account, walletAddress, mint);
    if (!current.eligible || current.stateFingerprint !== expected.stateFingerprint) throw new GaslessError('MESSAGE_MISMATCH', 'burn_state_recheck', 'This token account changed after the preview. Scan again.');
  }

  private async reconcile(burn: NonNullable<TransactionQuote['burn']>, walletAddress: string, confirmation: CleanConfirmation): Promise<ReconciliationResult> {
    const now = new Date().toISOString(); const transactionId = burn.prepared!.transactionId;
    if (confirmation.outcome !== 'confirmed_success') return { transactionId, signature: confirmation.signature, status: confirmation.outcome === 'confirmed_chain_error' ? 'failed' : 'pending', reconciledAt: now };
    const [chain, closed] = await Promise.all([this.rpc.getTransactionAcrossProviders(confirmation.signature), this.rpc.getAccountInfo(burn.account.address)]);
    if (!chain || chain.meta.err !== null) return { transactionId, signature: confirmation.signature, status: chain ? 'failed' : 'pending', reconciledAt: now };
    const keys = chain.transaction.message.accountKeys; const delta = (address: string) => { const index = keys.indexOf(address); return index < 0 ? undefined : BigInt(chain.meta.postBalances[index]) - BigInt(chain.meta.preBalances[index]); };
    const network = BigInt(burn.sponsoredCostLamports!); const net = BigInt(burn.netUserLamports!); const settlement = BigInt(burn.gaslessFeeLamports) + network;
    const matches = BigInt(chain.meta.fee) === network && delta(walletAddress) === net && delta(burn.feeDestination) === settlement && delta(burn.prepared!.expectedFeePayer) === -network;
    // The confirmed exact message burned the authoritative full balance, and SPL account closure can only succeed at zero balance.
    // Do not compare current global mint supply: unrelated concurrent burns or mints would make that reconciliation racy.
    const status = closed === null && matches ? 'confirmed' : 'failed'; const result: ReconciliationResult = { transactionId, signature: confirmation.signature, status, networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
    await this.durable.updateTransaction(transactionId, { status: status === 'confirmed' ? 'reconciled' : 'failed', confirmedAt: status === 'confirmed' ? now : undefined, failedAt: status === 'failed' ? now : undefined, errorCode: status === 'failed' ? 'RECONCILIATION_FAILED' : undefined, errorStage: status === 'failed' ? 'burn_economics' : undefined, updatedAt: now });
    if (status === 'confirmed') { const record = await this.durable.getTransaction(transactionId); if (!record) throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'Burn accounting record was not found.'); await this.durable.recordBurnAccounting(record, String(chain.meta.fee)); }
    return result;
  }

  private async expireSubmittedBurn(burn: NonNullable<TransactionQuote['burn']>, signature: string): Promise<ReconciliationResult> {
    const record = await this.durable.getTransaction(burn.prepared!.transactionId);
    if (record && record.status !== 'failed') await this.failDurableSubmission(record, 'failed_expired');
    return { transactionId: burn.prepared!.transactionId, signature, status: 'failed', reconciledAt: new Date().toISOString() };
  }

  private async reconcileDurableSubmission(record: DurableTransactionRecord): Promise<ReconciliationResult> {
    const now = new Date().toISOString();
    const chain = await this.rpc.getTransactionAcrossProviders(record.signature!);
    if (!chain) return { transactionId: record.id, signature: record.signature, status: 'pending', reconciledAt: now };
    if (chain.meta.err !== null) { await this.failDurableSubmission(record, 'confirmed_chain_error'); return { transactionId: record.id, signature: record.signature, status: 'failed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now }; }
    const required = [record.sponsoredCostLamports, record.netUserLamports, record.gaslessFeeLamports, record.relayerAddress, record.feeDestination, record.tokenAccount];
    if (required.some((value) => value === undefined)) throw new GaslessError('CONFIGURATION_ERROR', 'burn_reconciliation', 'Durable Burn reconciliation data is incomplete.');
    const keys = chain.transaction.message.accountKeys; const delta = (address: string) => { const index = keys.indexOf(address); return index < 0 ? undefined : BigInt(chain.meta.postBalances[index]) - BigInt(chain.meta.preBalances[index]); };
    const network = BigInt(record.sponsoredCostLamports!); const net = BigInt(record.netUserLamports!); const settlement = BigInt(record.gaslessFeeLamports!) + network;
    const closed = await this.rpc.getAccountInfo(record.tokenAccount!);
    const valid = BigInt(chain.meta.fee) === network && delta(record.walletAddress) === net && delta(record.feeDestination!) === settlement && delta(record.relayerAddress!) === -network && closed === null;
    if (!valid) { await this.failDurableSubmission(record, 'burn_economics'); return { transactionId: record.id, signature: record.signature, status: 'failed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now }; }
    const reconciled = { ...record, status: 'reconciled' as const, confirmedAt: now, updatedAt: now };
    await this.durable.recordBurnAccounting(reconciled, String(chain.meta.fee));
    await this.releaseDurableExposure(reconciled, 'reconciled_success');
    await this.durable.updateTransaction(record.id, { status: 'reconciled', confirmedAt: now, updatedAt: now });
    await this.durable.updateIntentStatus(record.intentId, 'reconciled');
    return { transactionId: record.id, signature: record.signature, status: 'confirmed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
  }

  private async failDurableSubmission(record: DurableTransactionRecord, reason: string) {
    const now = new Date().toISOString();
    await this.durable.appendEvent(record.id, 'burn_terminal_failure_proven', reason, { signature: record.signature, reason }, `${record.id}:terminal_failure:${reason}`);
    await this.releaseDurableExposure(record, reason);
    await this.durable.updateTransaction(record.id, { status: 'failed', failedAt: now, errorCode: 'CHAIN_EXECUTION_FAILED', errorStage: reason, updatedAt: now });
    await this.durable.updateIntentStatus(record.intentId, 'failed');
  }

  private async releaseDurableExposure(record: DurableTransactionRecord, reason: string) {
    if (!this.risk || record.sponsoredCostLamports === undefined) return;
    await this.durable.appendEvent(record.id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: record.intentId, quoteId: record.quoteId, action: 'CLEAN_BURN', network: record.network, amountLamports: record.sponsoredCostLamports, reason }, `${record.id}:${reason}:release_authorized`);
    const result = await this.risk.releaseTransactionExposure({ network: record.network, walletAddress: record.walletAddress, action: 'CLEAN_BURN', transactionId: record.id, amountLamports: Number(record.sponsoredCostLamports) });
    await this.durable.appendEvent(record.id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason }, `${record.id}:${reason}:released`);
  }

  private async releaseSuccessfulExposure(quote: TransactionQuote) {
    const burn = quote.burn; if (!burn?.prepared) return; const id = burn.prepared.transactionId;
    try {
      await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: quote.intent.intentId, quoteId: quote.quoteId, action: 'CLEAN_BURN', network: quote.intent.network, amountLamports: burn.sponsoredCostLamports, reason: 'reconciled_success' }, `${id}:success_release_authorized`);
      const result = await this.releaseExposure(quote);
      await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason: 'reconciled_success' }, `${id}:success_released`);
    } catch { log('error', 'burn_sponsorship_release_failed', { transactionId: id, quoteId: quote.quoteId, reason: 'reconciled_success' }); }
  }

  private async releaseDeterministicNoBroadcastExposure(quote: TransactionQuote, reason: string) {
    const burn = quote.burn; if (!this.risk || !burn?.prepared) return; const id = burn.prepared.transactionId;
    await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: quote.intent.intentId, quoteId: quote.quoteId, action: 'CLEAN_BURN', network: quote.intent.network, amountLamports: burn.sponsoredCostLamports, reason, userSignatureReturned: true, payerSignatureReturned: true, broadcastAttempted: false }, `${id}:no_broadcast_release_authorized`);
    const result = await this.releaseExposure(quote);
    await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason }, `${id}:no_broadcast_released`);
  }

  private assertPolicy() { if (!this.policy.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'burn_configuration', 'Burn fee settlement is not configured.'); new PublicKey(this.policy.feeDestination); if (!Number.isInteger(this.policy.feeBps) || this.policy.feeBps < 0 || this.policy.feeBps > 10_000 || !Number.isSafeInteger(this.policy.minimumUserPayoutLamports) || this.policy.minimumUserPayoutLamports < 1 || !Number.isInteger(this.policy.maximumNetworkFeeLamports) || this.policy.maximumNetworkFeeLamports < 1 || !Number.isInteger(this.policy.relayerLowBalanceThresholdLamports) || this.policy.relayerLowBalanceThresholdLamports < 0) throw new GaslessError('CONFIGURATION_ERROR', 'burn_configuration', 'Burn policy is invalid.'); }
  private async requireQuote(id: string, wallet: string, allowFinished = false, allowExpired = false) { const quote = await this.temporary.getQuote(id); if (!quote?.burn) throw new GaslessError('QUOTE_NOT_FOUND', 'burn_quote', 'This Burn preview was not found.'); if (quote.intent.walletAddress !== wallet) throw new GaslessError('SESSION_ERROR', 'burn_quote', 'This Burn preview belongs to a different wallet.'); if (!allowExpired && Date.parse(quote.expiresAt) <= Date.now() && quote.burn.status !== 'submitted' && quote.burn.status !== 'reconciled') throw new GaslessError('QUOTE_EXPIRED', 'burn_quote', 'This Burn preview expired. Scan again.'); if (!allowFinished && ['failed','reconciled'].includes(quote.status)) throw new GaslessError('QUOTE_ALREADY_USED', 'burn_quote', 'This Burn preview has already finished.'); return quote; }
  private async requireWalletQuote(id: string, wallet: string, allowFinished = false) { const quote = await this.requireQuote(id, wallet, allowFinished, true); if (!quote.burn?.prepared) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The Burn wallet attempt was not prepared.'); return quote; }
  private persistQuote(quote: TransactionQuote) { const ttl = quote.status === 'reconciled' || quote.status === 'submitted' || quote.burn?.status === 'submitted' ? 86_400 : quote.burn?.prepared ? 300 : Math.max(1, Math.ceil((Date.parse(quote.expiresAt) - Date.now()) / 1_000)); return this.temporary.saveQuote(quote, ttl); }
  private async releaseExposure(quote: TransactionQuote) { const burn = quote.burn; if (this.risk && burn?.prepared) return this.risk.releaseTransactionExposure({ network: quote.intent.network, walletAddress: quote.intent.walletAddress, action: 'CLEAN_BURN', transactionId: burn.prepared.transactionId, amountLamports: Number(burn.sponsoredCostLamports) }); }
  private async failBeforeWallet(quote: TransactionQuote, error: GaslessError) { if (!quote.burn?.prepared) return; await this.failAfterWallet(quote, error.code, false, await this.rpc.getBlockHeight().catch(() => quote.burn!.prepared!.preparedBlockHeight ?? 0), error.stage); }
  private async failAfterWallet(quote: TransactionQuote, code: string, userSignatureReturned: boolean, blockHeight: number, stage = 'wallet_signing') {
    const burn = quote.burn!; const prepared = burn.prepared!; const id = prepared.transactionId; const now = new Date().toISOString();
    if (!userSignatureReturned && this.risk) {
      await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: quote.intent.intentId, quoteId: quote.quoteId, action: 'CLEAN_BURN', network: quote.intent.network, amountLamports: burn.sponsoredCostLamports, reason: code, userSignatureReturned: false, payerSignatureReturned: false, broadcastAttempted: false }, `${id}:unsigned_release_authorized`);
      const result = await this.releaseExposure(quote);
      await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason: code }, `${id}:unsigned_released`);
    }
    burn.status = 'failed'; quote.status = 'failed';
    await this.durable.updateTransaction(id, { status: 'failed', failedAt: now, errorCode: code, errorStage: stage, updatedAt: now });
    await this.durable.updateIntentStatus(quote.intent.intentId, 'failed');
    await this.durable.appendEvent(id, 'burn_failed', stage, { code, userSignatureReturned, reservationRetained: userSignatureReturned, payerSignatureReturned: false, broadcastAttempted: false, blockHeight }, `${id}:failed:${stage}`);
    await this.persistQuote(quote);
  }
  private refreshRequired() { return new GaslessError('QUOTE_EXPIRED', 'burn_pre_sign', 'Burn preparation expired. Review the Burn again.'); }
}
