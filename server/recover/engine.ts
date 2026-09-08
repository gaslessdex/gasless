import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { discoverRecoverAccounts, readRecoverWrappedSol } from '../../chains/solana/recover/accounts.js';
import { calculateRecoverFees, prepareRecoverTransaction, validateSignedRecover } from '../../chains/solana/transactions/recover.js';
import type { DurableTransactionRecord, ReconciliationResult, RecoverAccount, RecoverDiscoveryResult, SolanaNetwork, TransactionIntent, TransactionQuote } from '../../shared/transactions/types.js';
import type { EmergencyControlService } from '../controls/service.js';
import { GaslessError, asGaslessError } from '../errors.js';
import { APPROVED_DEX_FAMILIES, RAYDIUM_CLMM_DEX, type ApprovedDexFamily, type JupiterBuild, type JupiterQuote, type JupiterRouter, routeDexFamily, routeFingerprint, wrappedSolAccount } from '../jupiter/service.js';
import { log } from '../observability/logger.js';
import type { RelayerProvider } from '../relayer/provider.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { DurableStore } from '../storage/durable.js';
import type { TemporaryStore } from '../storage/temporary.js';
import type { OperationalRiskService } from '../risk/operational.js';
import type { TokenRegistry } from '../token-registry/service.js';
import { createSendSigningWindow, SEND_POST_SIGNATURE_BLOCK_MARGIN } from '../../chains/solana/send/validity.js';
import { versionedMessageHash, versionedSignerSignatureIsValid } from '../../chains/solana/transactions/clean.js';
import { broadcastAndConfirmClean, confirmCleanSignature, observeCleanSignature, recordCleanConfirmationObservation, type CleanConfirmation } from '../clean/submission.js';
import type { RecoverAuthorizationSigner } from './authorization.js';

interface RecoverPolicy { feeDestination?: string; swapFeeBps: number; rentFeeBps: number; slippageBps: number; maxPriceImpactBps: number; minimumUserPayoutLamports: number; maximumNetworkFeeLamports: number; maximumSponsoredCostLamports: number; relayerLowBalanceThresholdLamports: number; blockhashSlotsToExpiry: number; preWalletMinimumBlockMargin: number; attemptTtlSeconds: number }

type RecoverRisk = Pick<OperationalRiskService, 'reserveTransactionExposure' | 'releaseTransactionExposure'>;

export class RecoverEngine {
  constructor(private readonly temporary: TemporaryStore, private readonly durable: DurableStore, private readonly rpc: SolanaRpc, private readonly relayer: RelayerProvider, private readonly controls: EmergencyControlService, private readonly registry: TokenRegistry, private readonly jupiter: JupiterRouter, private readonly quoteTtlSeconds: number, private readonly policy: RecoverPolicy, private readonly risk?: RecoverRisk, private readonly authorizationSigner?: RecoverAuthorizationSigner) {}

  async discover(walletAddress: string): Promise<RecoverDiscoveryResult> {
    try { new PublicKey(walletAddress); } catch { throw new GaslessError('SESSION_ERROR', 'recover_discovery', 'Connect a valid Solana wallet.'); }
    return discoverRecoverAccounts(this.rpc, this.registry, walletAddress);
  }

  async createQuote(input: { walletAddress: string; network: SolanaNetwork; tokenAccount: string; clientRequestId: string; requestId: string }) {
    await this.controls.assertExecutionAllowed('CLEAN_RECOVER', input.network);
    if (!await this.temporary.consumeRateLimit(`recover-quote:${input.walletAddress}`, 10, 60)) throw new GaslessError('RATE_LIMITED', 'recover_quote', 'Too many Recover Value requests. Wait a minute and try again.', true);
    let selected: PublicKey; try { selected = new PublicKey(input.tokenAccount); } catch { throw new GaslessError('INVALID_REQUEST', 'recover_quote', 'Select a valid token to recover.'); }
    const lock = `recover-request:${input.walletAddress}:${input.clientRequestId}`;
    if (!await this.temporary.acquireReplayLock(lock, input.requestId, this.quoteTtlSeconds)) throw new GaslessError('REPLAY_DETECTED', 'recover_quote', 'This Recover Value request was already received.');
    this.assertPolicy();
    const discovery = await this.discover(input.walletAddress);
    const account = discovery.eligibleAccounts.find((item) => item.address === selected.toBase58());
    if (!account) throw new GaslessError('TOKEN_UNSUPPORTED', 'recover_quote', 'This asset is not available for Recover Value. Scan again or choose another token.');
    const feePayer = await this.relayer.getFeePayerPublicKey();
    if (input.walletAddress === this.policy.feeDestination || feePayer === this.policy.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'recover_configuration', 'Recover Value settlement accounts must be separate.');
    const wrappedSolState = await readRecoverWrappedSol(this.rpc, input.walletAddress).catch(() => { throw new GaslessError('TOKEN_UNSUPPORTED', 'recover_wsol_state', 'The canonical wrapped SOL account is not safe for Recover Value.'); });
    const registry = await this.registry.evaluate('CLEAN_RECOVER', account.mint);
    const families = registry.entry?.approvedDexFamilies?.filter((family): family is ApprovedDexFamily => APPROVED_DEX_FAMILIES.includes(family)) ?? [RAYDIUM_CLMM_DEX];
    if (!families.length) throw new GaslessError('TOKEN_UNSUPPORTED', 'recover_route_policy', 'This token has no approved Recover Value route family.');
    const { family, quote: preview } = await this.quoteRoute(account, families);
    const fees = calculateRecoverFees(BigInt(preview.otherAmountThreshold), BigInt(account.recoverableLamports), this.policy.swapFeeBps, this.policy.rentFeeBps);
    const previewMinimumPayout = BigInt(preview.otherAmountThreshold) + BigInt(account.recoverableLamports) - fees.swapFee - fees.rentFee - BigInt(this.policy.maximumNetworkFeeLamports);
    if (previewMinimumPayout < BigInt(this.policy.minimumUserPayoutLamports)) throw new GaslessError('TOKEN_UNSUPPORTED', 'recover_economics', 'This route cannot safely meet the minimum Recover Value payout.');
    const now = Date.now(); const quoteId = crypto.randomUUID();
    const intent: TransactionIntent = { intentId: crypto.randomUUID(), walletAddress: input.walletAddress, actionType: 'CLEAN_RECOVER', network: input.network, requestId: input.requestId, clientRequestId: input.clientRequestId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.quoteTtlSeconds * 1000).toISOString(), metadata: { schemaVersion: 'recover-v1', tokenAccount: account.address, mint: account.mint } };
    const quote: TransactionQuote = { quoteId, intent, status: 'created', createdAt: intent.createdAt, expiresAt: intent.expiresAt, recover: { schemaVersion: 'recover-v1', account, outputMint: preview.outputMint, slippageBps: preview.slippageBps, routeLabel: family, routeFamily: family, routeFingerprint: '', wrappedSolState, estimatedSwapOutputLamports: preview.outAmount, minimumSwapOutputLamports: preview.otherAmountThreshold, swapServiceFeeBps: this.policy.swapFeeBps, swapServiceFeeLamports: fees.swapFee.toString(), rentServiceFeeBps: this.policy.rentFeeBps, rentServiceFeeLamports: fees.rentFee.toString(), feeDestination: this.policy.feeDestination!, networkFeeLamports: String(this.policy.maximumNetworkFeeLamports), temporaryAccountRentLamports: wrappedSolState.exists ? '0' : String(await this.rpc.getMinimumBalanceForRentExemption(165)), minimumUserPayoutLamports: previewMinimumPayout.toString(), status: 'created', route: null } };
    await this.temporary.saveQuote(quote, this.quoteTtlSeconds);
    log('info', 'recover_preview_created', { requestId: input.requestId, quoteId: quote.quoteId, walletAddress: input.walletAddress, tokenAccount: account.address, mint: account.mint, tokenAmountRaw: account.tokenAmountRaw, minimumSwapOutputLamports: preview.otherAmountThreshold, executablePrepared: false });
    return quote;
  }

  async prepare(quoteId: string, walletAddress: string, requestId: string, deferSigningWindow = false) {
    const quote = await this.requireQuote(quoteId, walletAddress); await this.controls.assertExecutionAllowed('CLEAN_RECOVER', quote.intent.network); const recover = quote.recover;
    if (!recover) throw new GaslessError('INVALID_REQUEST', 'recover_prepare', 'This is not a Recover Value quote.');
    if (recover.prepared) return quote;
    await this.recheckAccount(recover.account, walletAddress);
    const feePayer = await this.relayer.getFeePayerPublicKey();
    // The explicit Approve click is the only trigger for the final route, blockhash,
    // executable message, simulation, durable attempt, and reservation lifecycle.
    const build = await this.buildRoute(recover.account, walletAddress, feePayer, recover.routeFamily ?? RAYDIUM_CLMM_DEX);
    const freshFees = calculateRecoverFees(BigInt(build.otherAmountThreshold), BigInt(recover.account.recoverableLamports), this.policy.swapFeeBps, this.policy.rentFeeBps);
    Object.assign(recover, { route: build, routeLabel: build.routePlan.map((step) => step.swapInfo?.label).filter(Boolean).join(' → ') || 'Jupiter', routeFingerprint: routeFingerprint(build), estimatedSwapOutputLamports: build.outAmount, minimumSwapOutputLamports: build.otherAmountThreshold, swapServiceFeeLamports: freshFees.swapFee.toString(), rentServiceFeeLamports: freshFees.rentFee.toString() });
    const currentWrapped = await readRecoverWrappedSol(this.rpc, walletAddress).catch(() => { throw new GaslessError('MESSAGE_MISMATCH', 'recover_wsol_recheck', 'The wrapped SOL account changed after the preview.'); });
    if (currentWrapped.stateFingerprint !== recover.wrappedSolState.stateFingerprint) throw new GaslessError('MESSAGE_MISMATCH', 'recover_wsol_recheck', 'The wrapped SOL account changed after the preview.');
    const wrappedAccountExists = currentWrapped.exists;
    if (!wrappedAccountExists && build.setupInstructions.length !== 1) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'Jupiter did not provide the required temporary SOL account setup.');
    const temporaryAccountRentLamports = wrappedAccountExists ? 0n : BigInt(await this.rpc.getMinimumBalanceForRentExemption(165));
    const result = await prepareRecoverTransaction({ quote, account: recover.account, build, swapFeeLamports: BigInt(recover.swapServiceFeeLamports), rentFeeLamports: BigInt(recover.rentServiceFeeLamports), temporaryAccountRentLamports, includeSetup: !wrappedAccountExists, minimumUserPayoutLamports: BigInt(this.policy.minimumUserPayoutLamports), feePayer, feeDestination: recover.feeDestination, rpc: this.rpc });
    const preparedBlockHeight = await this.rpc.getBlockHeight();
    if (result.prepared.lastValidBlockHeight - preparedBlockHeight < this.policy.preWalletMinimumBlockMargin) throw new GaslessError('QUOTE_EXPIRED', 'recover_blockhash_margin', 'Recover Value preparation is no longer fresh. Review the recovery again.');
    result.prepared.preparedBlockHeight = preparedBlockHeight;
    if (result.sponsoredCostLamports > BigInt(this.policy.maximumSponsoredCostLamports)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'recover_sponsor_cost', 'This route exceeds the Recover Value sponsorship limit.');
    Object.assign(recover, { expectedRelayer: feePayer, prepared: result.prepared, sponsoredCostLamports: result.sponsoredCostLamports.toString(), networkFeeLamports: result.networkFeeLamports.toString(), temporaryAccountRentLamports: temporaryAccountRentLamports.toString(), minimumUserPayoutLamports: result.minimumUserPayout.toString(), status: 'awaiting_user_signature' }); quote.status = 'awaiting_user_signature';
    const now = new Date().toISOString(); const record: DurableTransactionRecord = { id: result.prepared.transactionId, intentId: quote.intent.intentId, quoteId, walletAddress, actionType: 'CLEAN_RECOVER', network: quote.intent.network, status: 'awaiting_user_signature', preparedMessageHash: result.prepared.preparedMessageHash, recentBlockhash: result.prepared.recentBlockhash, lastValidBlockHeight: result.prepared.lastValidBlockHeight, accountAddresses: [recover.account.address, wrappedSolAccount(walletAddress)], grossRecoveredLamports: recover.account.recoverableLamports, gaslessFeeLamports: (BigInt(recover.swapServiceFeeLamports) + BigInt(recover.rentServiceFeeLamports)).toString(), sponsoredCostLamports: recover.sponsoredCostLamports, netUserLamports: recover.minimumUserPayoutLamports, relayerAddress: feePayer, feeDestination: recover.feeDestination, mint: recover.account.mint, tokenAccount: recover.account.address, tokenAmountRaw: recover.account.tokenAmountRaw, tokenDecimals: recover.account.decimals, estimatedSwapOutputLamports: recover.estimatedSwapOutputLamports, minimumSwapOutputLamports: recover.minimumSwapOutputLamports, swapServiceFeeLamports: recover.swapServiceFeeLamports, rentServiceFeeLamports: recover.rentServiceFeeLamports, networkFeeLamports: recover.networkFeeLamports, temporaryAccountRentLamports: recover.temporaryAccountRentLamports, createdAt: now, updatedAt: now };
    await this.durable.createIntent(quote.intent, quote.quoteId); await this.durable.createTransaction(record); await this.durable.appendEvent(record.id, 'recover_attempted', 'prepared', { simulation: 'passed', routeFingerprint: recover.routeFingerprint, walletInvocationReached: false }, `${record.id}:prepared`); await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
    log('info', 'recover_prepared', { requestId, quoteId, walletAddress, sponsoredCostLamports: record.sponsoredCostLamports, minimumUserPayoutLamports: record.netUserLamports }); return deferSigningWindow ? quote : this.activateSigningWindow(quote, requestId);
  }

  async reconcileStatus(quoteId: string, walletAddress: string, network: SolanaNetwork) {
    const record = await this.durable.getTransactionByQuoteId(quoteId);
    if (!record || record.actionType !== 'CLEAN_RECOVER') return { status: 'not_submitted' as const };
    if (record.walletAddress !== walletAddress || record.network !== network) throw new GaslessError('SESSION_ERROR', 'recover_reconciliation', 'This Recover Value transaction belongs to a different wallet or network.');
    if (record.status === 'reconciled') return { status: 'confirmed' as const, transactionId: record.id, signature: record.signature };
    if (record.status === 'failed') return { status: 'failed' as const, transactionId: record.id, signature: record.signature };
    if (record.status !== 'submitted' || !record.signature) {
      if (record.lastValidBlockHeight !== undefined) {
        const heights = await this.rpc.getBlockHeightsAcrossProviders(); const deterministicallyExpired = heights.length > 0 && heights.every((observation) => observation.errorCategory === undefined && observation.value !== undefined && observation.value > record.lastValidBlockHeight!);
        if (deterministicallyExpired) { await this.failDurableSubmission(record, 'failed_expired'); return { status: 'failed' as const, transactionId: record.id }; }
      }
      return { status: 'not_submitted' as const, transactionId: record.id };
    }
    const confirmation = await observeCleanSignature(this.rpc, record.signature, record.lastValidBlockHeight);
    if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'recover', transactionId: record.id, signedMessageHash: record.preparedMessageHash, confirmation });
    if (confirmation.outcome === 'confirmed_success') {
      const reconciliation = await this.reconcileDurableSubmission(record);
      return { status: reconciliation.status, transactionId: record.id, signature: record.signature, reconciliation };
    }
    if (confirmation.outcome === 'confirmed_chain_error' || confirmation.outcome === 'expired') {
      await this.failDurableSubmission(record, confirmation.outcome === 'expired' ? 'failed_expired' : 'failed_chain');
      return { status: 'failed' as const, transactionId: record.id, signature: record.signature };
    }
    return { status: 'pending' as const, transactionId: record.id, signature: record.signature, blockHeight: confirmation.blockHeight };
  }

  async activateSigningWindow(quote: TransactionQuote, requestId: string) {
    const prepared = quote.recover?.prepared;
    if (!prepared) throw new GaslessError('INVALID_REQUEST', 'recover_prepare', 'Recover Value preparation was incomplete.');
    try {
      await this.recheckAccount(quote.recover!.account, quote.intent.walletAddress); await this.recheckWrappedSol(quote);
      const blockHeight = await this.rpc.getBlockHeight(); const window = createSendSigningWindow(prepared.lastValidBlockHeight, blockHeight);
      if (!window || prepared.lastValidBlockHeight - blockHeight < this.policy.preWalletMinimumBlockMargin) throw new GaslessError('QUOTE_EXPIRED', 'recover_blockhash_margin', 'Recover Value preparation is no longer fresh. Review the recovery again.');
      Object.assign(prepared, { walletSigningReadyAt: window.readyAt, walletSigningExpiresAt: window.walletSigningExpiresAt, walletSigningWindowMs: window.walletSigningWindowMs, preparedBlockHeight: window.preparedBlockHeight });
      quote.expiresAt = window.quoteExpiresAt; quote.intent.expiresAt = window.quoteExpiresAt; await this.persistQuote(quote);
      log('info', 'recover_wallet_window_started', { requestId, quoteId: quote.quoteId, transactionId: prepared.transactionId, preparedBlockHeight: blockHeight, lastValidBlockHeight: prepared.lastValidBlockHeight, remainingBlocks: prepared.lastValidBlockHeight - blockHeight, minimumRemainingBlocks: this.policy.preWalletMinimumBlockMargin }); return quote;
    } catch (error) { await this.abortBeforeWallet(quote, error); throw error; }
  }

  async abortBeforeWallet(quote: TransactionQuote, error: unknown) { await this.failUnsigned(quote, error instanceof GaslessError ? error.code : 'SPONSOR_LIMIT_EXCEEDED', error instanceof GaslessError ? error.stage : 'sponsorship_policy'); }
  async preWalletQuote(quoteId: string, walletAddress: string) { const quote = await this.requireQuote(quoteId, walletAddress, true, true); if (quote.status !== 'awaiting_user_signature' || quote.recover?.status !== 'awaiting_user_signature' || !quote.recover.prepared) throw new GaslessError('QUOTE_ALREADY_USED', 'recover_pre_wallet', 'This Recover Value preparation is no longer available.'); return quote; }
  async currentWalletGateBlockHeight(quoteId: string, walletAddress: string) { const quote = await this.preWalletQuote(quoteId, walletAddress); await this.controls.assertExecutionAllowed('CLEAN_RECOVER', quote.intent.network); await this.recheckAccount(quote.recover!.account, walletAddress); await this.recheckWrappedSol(quote); const height = await this.rpc.getBlockHeight(); const prepared = quote.recover!.prepared!; if (prepared.lastValidBlockHeight - height < this.policy.preWalletMinimumBlockMargin) { await this.failUnsigned(quote, 'QUOTE_EXPIRED', 'recover_pre_wallet'); throw new GaslessError('QUOTE_EXPIRED', 'recover_pre_wallet', 'Transaction expired before approval. Try again.'); } return height; }
  async currentWalletApprovalBlockHeight(quoteId: string, walletAddress: string) { await this.requireQuote(quoteId, walletAddress, true); return this.rpc.getBlockHeight(); }
  async recordWalletEvent(quoteId: string, walletAddress: string, event: string, metadata: Record<string, unknown> = {}) { const quote = await this.requireQuote(quoteId, walletAddress, true); const prepared = quote.recover?.prepared; if (!prepared || !new Set(['invoked','returned','failed','expired']).has(event)) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'Unknown Recover Value wallet event.'); const height = await this.rpc.getBlockHeight(); const safe = Object.fromEntries(Object.entries(metadata).filter(([, value]) => ['string','number','boolean'].includes(typeof value))); await this.durable.appendEvent(prepared.transactionId, `recover_wallet_${event}`, 'wallet_signing', { ...safe, blockHeight: height, remainingBlocks: prepared.lastValidBlockHeight - height }, `${prepared.transactionId}:wallet:${event}`); }
  async abortWalletApproval(quoteId: string, walletAddress: string, reason: string, userSignatureReturned: boolean) { const quote = await this.temporary.getQuote(quoteId); const record = await this.durable.getTransactionByQuoteId(quoteId); const lastValid = quote?.recover?.prepared?.lastValidBlockHeight ?? record?.lastValidBlockHeight; if (userSignatureReturned && lastValid !== undefined && lastValid - await this.rpc.getBlockHeight() >= SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The signed recovery still has a safe submission margin.'); await this.terminalizeUnsigned(quoteId, walletAddress, reason, 'wallet_signing', userSignatureReturned, quote ?? undefined); return { status: 'failed' as const }; }
  async abortWalletGate(quoteId: string, walletAddress: string, reason: string) { await this.terminalizeUnsigned(quoteId, walletAddress, reason, 'wallet_signing'); }

  async submit(input: { quoteId: string; walletAddress: string; signedTransaction: string; clientRequestId: string; requestId: string }) {
    const quote = await this.requireQuote(input.quoteId, input.walletAddress, true); const recover = quote.recover;
    if (!recover?.prepared) throw new GaslessError('INVALID_REQUEST', 'recover_submit', 'Prepare this Recover Value transaction before submitting it.');
    if (recover.status === 'failed') throw new GaslessError('QUOTE_ALREADY_USED', 'recover_submit', 'This Recover Value attempt has already finished. Review a new recovery.');
    if (recover.status === 'reconciled' && recover.signature && recover.reconciliation) return { transactionId: recover.prepared.transactionId, signature: recover.signature, reconciliation: recover.reconciliation, alreadyCompleted: true };
    if (recover.status === 'submitted' && recover.signature) return this.resumeSubmitted(quote, input.walletAddress);
    await this.controls.assertExecutionAllowed('CLEAN_RECOVER', quote.intent.network);
    if (!await this.temporary.consumeRateLimit(`recover-submit:${input.walletAddress}`, 5, 60)) throw new GaslessError('RATE_LIMITED', 'recover_submit', 'Too many Recover Value submission attempts. Wait a minute and try again.', true);
    const replayKeys = [`recover-submission:${input.quoteId}`, `message:${recover.prepared.preparedMessageHash}`, `recover-submit-request:${input.walletAddress}:${input.clientRequestId}`]; const acquired: string[] = []; let crossed = false; let koraSigningReturned = false; let submissionSignature: string | undefined;
    try {
      for (const key of replayKeys) { if (!await this.temporary.acquireReplayLock(key, input.requestId, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Recover Value transaction was already submitted.'); acquired.push(key); }
      const signedReturnBlockHeight = await this.rpc.getBlockHeight();
      if (recover.prepared.lastValidBlockHeight - signedReturnBlockHeight < SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'wallet_signing', 'Recover Value preparation expired while awaiting wallet approval. Nothing was submitted.');
      const validated = await validateSignedRecover(input.signedTransaction, recover.prepared, this.rpc);
      if (validated.messageHash !== recover.prepared.preparedMessageHash) { const finalMessageKey = `message:${validated.messageHash}`; if (!await this.temporary.acquireReplayLock(finalMessageKey, input.requestId, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Recover Value transaction was already submitted.'); acquired.push(finalMessageKey); }
      await this.durable.appendEvent(recover.prepared.transactionId, 'recover_user_signed', 'wallet_signing', { preparedMessageHash: recover.prepared.preparedMessageHash, walletReturnedMessageHash: validated.messageHash, userSignatureReturned: true, payerSignatureReturned: false }, `${recover.prepared.transactionId}:user_signed`);
      await this.recheckAccount(recover.account, input.walletAddress); const currentWrapped = await readRecoverWrappedSol(this.rpc, input.walletAddress).catch(() => { throw new GaslessError('MESSAGE_MISMATCH', 'recover_wsol_recheck', 'The wrapped SOL account changed after approval.'); }); if (currentWrapped.stateFingerprint !== recover.wrappedSolState.stateFingerprint) throw new GaslessError('MESSAGE_MISMATCH', 'recover_wsol_recheck', 'The wrapped SOL account changed after approval.'); await this.controls.assertExecutionAllowed('CLEAN_RECOVER', quote.intent.network);
      if (routeFingerprint(recover.route as JupiterBuild) !== recover.routeFingerprint) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route changed after authorization.');
      const transaction = VersionedTransaction.deserialize(Buffer.from(validated.serializedTransaction, 'base64')); const predictedFee = await this.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
      if (predictedFee === null || String(predictedFee) !== recover.networkFeeLamports || predictedFee > this.policy.maximumNetworkFeeLamports) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The Recover Value network cost no longer matches the preview.');
      if (await this.rpc.getBalance(recover.prepared.expectedFeePayer) < Number(BigInt(recover.sponsoredCostLamports!)) + this.policy.relayerLowBalanceThresholdLamports) throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_boundary', 'GASLESS sponsorship is temporarily unavailable.');
      crossed = true; recover.status = 'relaying'; await this.persistQuote(quote); await this.durable.updateTransaction(recover.prepared.transactionId, { status: 'relaying', updatedAt: new Date().toISOString() });
      const recoverAuthorization = this.authorizationSigner?.authorize(quote, validated.serializedTransaction);
      const koraSigningStartedAt = new Date().toISOString(); const fullySigned = await this.relayer.signTransaction(validated.serializedTransaction, recoverAuthorization ? { recoverAuthorization } : undefined); koraSigningReturned = true; const koraSigningReturnedAt = new Date().toISOString();
      const signedTransaction = VersionedTransaction.deserialize(Buffer.from(fullySigned, 'base64'));
      if (versionedMessageHash(signedTransaction) !== validated.messageHash || signedTransaction.message.recentBlockhash !== recover.prepared.recentBlockhash) throw new GaslessError('MESSAGE_MISMATCH', 'relayer_boundary', 'The signed Recover Value transaction changed after approval. Nothing was submitted.');
      if (!versionedSignerSignatureIsValid(signedTransaction, 0, recover.prepared.expectedFeePayer)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The Recover Value payer signature is invalid. Nothing was submitted.');
      const simulation = await this.rpc.simulateTransaction(fullySigned, true);
      if (simulation.err !== null) throw new GaslessError('SIMULATION_FAILED', 'final_signed_simulation', "This Recover Value transaction couldn't be safely completed. Nothing was submitted.");
      await this.durable.appendEvent(recover.prepared.transactionId, 'recover_fully_signed', 'relayer', { koraSigningStartedAt, koraSigningReturnedAt, preparedMessageHash: recover.prepared.preparedMessageHash, walletReturnedMessageHash: validated.messageHash, koraSignedMessageHash: validated.messageHash, submittedMessageHash: validated.messageHash, userSignatureReturned: true, payerSignatureReturned: true, finalSimulation: 'passed' }, `${recover.prepared.transactionId}:fully_signed`);
      const canonicalSignature = bs58.encode(signedTransaction.signatures[0]);
      submissionSignature = canonicalSignature; recover.signature = canonicalSignature; recover.status = 'submitted'; quote.status = 'submitted'; const submittedAt = new Date().toISOString();
      await this.durable.updateTransaction(recover.prepared.transactionId, { status: 'submitted', signature: canonicalSignature, submittedAt, updatedAt: submittedAt }); await this.durable.appendEvent(recover.prepared.transactionId, 'recover_submitted', 'submitted', { signature: canonicalSignature, recentBlockhash: recover.prepared.recentBlockhash, lastValidBlockHeight: recover.prepared.lastValidBlockHeight, signedMessageHash: validated.messageHash }, `${recover.prepared.transactionId}:submitted`); await this.persistQuote(quote);
      const confirmation = await broadcastAndConfirmClean({ rpc: this.rpc, durable: this.durable, eventPrefix: 'recover', prepared: recover.prepared, fullySigned, canonicalSignature, signedMessageHash: validated.messageHash });
      const reconciliation = confirmation.outcome === 'expired' || confirmation.outcome === 'confirmed_chain_error'
        ? await this.failSubmittedRecover(recover, canonicalSignature, confirmation.outcome === 'expired' ? 'failed_expired' : 'failed_chain')
        : await this.reconcile(recover, input.walletAddress, confirmation);
      recover.reconciliation = reconciliation; recover.status = reconciliation.status === 'confirmed' ? 'reconciled' : reconciliation.status === 'failed' ? 'failed' : 'submitted'; quote.status = recover.status;
      await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
      if (reconciliation.status !== 'confirmed') throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Recover Value transaction was submitted and is still being verified.', true);
      await this.releaseSuccessfulExposure(quote);
      return { transactionId: recover.prepared.transactionId, signature: canonicalSignature, confirmation, reconciliation, alreadyCompleted: false };
    } catch (error) {
      const normalized = asGaslessError(error, 'recover_submit', input.requestId); if (!crossed) for (const key of acquired) await this.temporary.releaseReplayLockIfSafe(key, input.requestId);
      if (!submissionSignature && !crossed && normalized.code !== 'REPLAY_DETECTED') await this.failUnsigned(quote, normalized.code, normalized.stage, true).catch(() => undefined);
      if (!submissionSignature && crossed && koraSigningReturned) { await this.releaseDeterministicNoBroadcastExposure(quote, normalized.code).catch(() => undefined); recover.status = 'failed'; quote.status = 'failed'; await this.persistQuote(quote).catch(() => undefined); await this.durable.updateTransaction(recover.prepared.transactionId, { status: 'failed', failedAt: new Date().toISOString(), errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined); }
      await this.durable.appendEvent(recover.prepared.transactionId, 'recover_failed', normalized.stage, { code: normalized.code }, `${recover.prepared.transactionId}:failed:${normalized.code}`).catch(() => undefined); log('error', 'recover_rejected', { requestId: input.requestId, quoteId: input.quoteId, code: normalized.code, stage: normalized.stage }); throw normalized;
    }
  }

  private async resumeSubmitted(quote: TransactionQuote, walletAddress: string, alreadyCompleted = true) {
    const recover = quote.recover!; const confirmation = await confirmCleanSignature(this.rpc, recover.signature!, recover.prepared!.lastValidBlockHeight);
    if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'recover', transactionId: recover.prepared!.transactionId, signedMessageHash: recover.prepared!.preparedMessageHash, confirmation });
    const reconciliation = confirmation.outcome === 'expired' || confirmation.outcome === 'confirmed_chain_error'
      ? await this.failSubmittedRecover(recover, recover.signature!, confirmation.outcome === 'expired' ? 'failed_expired' : 'failed_chain')
      : await this.reconcile(recover, walletAddress, confirmation);
    recover.reconciliation = reconciliation; recover.status = reconciliation.status === 'confirmed' ? 'reconciled' : reconciliation.status === 'failed' ? 'failed' : 'submitted'; quote.status = recover.status;
    await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status);
    if (reconciliation.status !== 'confirmed') throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Recover Value transaction was submitted and is still being verified.', true);
    await this.releaseSuccessfulExposure(quote);
    return { transactionId: recover.prepared!.transactionId, signature: recover.signature!, confirmation, reconciliation, alreadyCompleted };
  }
  private async recheckAccount(expected: RecoverAccount, walletAddress: string) { const [account, mint] = await this.rpc.getMultipleAccounts([expected.address, expected.mint]); if (!account) throw new GaslessError('MESSAGE_MISMATCH', 'recover_state_recheck', 'This token account changed after the preview. Scan again.'); const discovered = await discoverRecoverAccounts(this.rpc, this.registry, walletAddress); const current = discovered.eligibleAccounts.find((item) => item.address === expected.address); if (!current || current.stateFingerprint !== expected.stateFingerprint || !mint) throw new GaslessError('MESSAGE_MISMATCH', 'recover_state_recheck', 'This token account changed after the preview. Scan again.'); }
  private async recheckWrappedSol(quote: TransactionQuote) { const expected = quote.recover?.wrappedSolState; if (!expected) throw new GaslessError('MESSAGE_MISMATCH', 'recover_wsol_recheck', 'The wrapped SOL state is missing.'); const current = await readRecoverWrappedSol(this.rpc, quote.intent.walletAddress).catch(() => undefined); if (!current || current.stateFingerprint !== expected.stateFingerprint) throw new GaslessError('MESSAGE_MISMATCH', 'recover_wsol_recheck', 'The wrapped SOL account changed after the preview.'); }
  private async reconcile(recover: NonNullable<TransactionQuote['recover']>, walletAddress: string, confirmation: CleanConfirmation): Promise<ReconciliationResult> {
    const now = new Date().toISOString(); const transactionId = recover.prepared!.transactionId;
    if (confirmation.outcome !== 'confirmed_success') return { transactionId, signature: confirmation.signature, status: 'pending', reconciledAt: now };
    const [chain, source, wrapped] = await Promise.all([this.rpc.getTransactionAcrossProviders(confirmation.signature), this.rpc.getAccountInfo(recover.account.address), this.rpc.getAccountInfo(recover.wrappedSolState.address)]);
    if (!chain || chain.meta.err !== null) return { transactionId, signature: confirmation.signature, status: chain ? 'failed' : 'pending', reconciledAt: now };
    const keys = chain.transaction.message.accountKeys; const delta = (address: string) => { const index = keys.indexOf(address); return index < 0 ? undefined : BigInt(chain.meta.postBalances[index]) - BigInt(chain.meta.preBalances[index]); };
    const network = BigInt(recover.networkFeeLamports!); const temporaryRent = BigInt(recover.temporaryAccountRentLamports!); const sponsored = network + temporaryRent; const settlement = BigInt(recover.swapServiceFeeLamports) + BigInt(recover.rentServiceFeeLamports) + sponsored;
    const userDelta = delta(walletAddress); const matches = BigInt(chain.meta.fee) === network && userDelta !== undefined && userDelta >= BigInt(recover.minimumUserPayoutLamports!) && delta(recover.feeDestination) === settlement && delta(recover.prepared!.expectedFeePayer) === -sponsored;
    const status = source === null && wrapped === null && matches ? 'confirmed' : 'failed'; const result: ReconciliationResult = { transactionId, signature: confirmation.signature, status, networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
    await this.durable.updateTransaction(transactionId, { status: status === 'confirmed' ? 'reconciled' : 'failed', confirmedAt: status === 'confirmed' ? now : undefined, failedAt: status === 'failed' ? now : undefined, errorCode: status === 'failed' ? 'RECONCILIATION_FAILED' : undefined, errorStage: status === 'failed' ? 'recover_economics' : undefined, updatedAt: now });
    if (status === 'confirmed') { const record = await this.durable.getTransaction(transactionId); if (!record) throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'Recover Value accounting record was not found.'); await this.durable.recordRecoverAccounting(record, String(chain.meta.fee), String(userDelta)); }
    return result;
  }

  private async reconcileDurableSubmission(record: DurableTransactionRecord): Promise<ReconciliationResult> {
    const now = new Date().toISOString(); const chain = await this.rpc.getTransactionAcrossProviders(record.signature!);
    if (!chain) return { transactionId: record.id, signature: record.signature, status: 'pending', reconciledAt: now };
    if (chain.meta.err !== null) { await this.failDurableSubmission(record, 'failed_chain'); return { transactionId: record.id, signature: record.signature, status: 'failed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now }; }
    const required = [record.networkFeeLamports, record.temporaryAccountRentLamports, record.netUserLamports, record.swapServiceFeeLamports, record.rentServiceFeeLamports, record.relayerAddress, record.feeDestination, record.tokenAccount, record.accountAddresses?.[1]];
    if (required.some((value) => value === undefined)) throw new GaslessError('CONFIGURATION_ERROR', 'recover_reconciliation', 'Durable Recover Value reconciliation data is incomplete.');
    const keys = chain.transaction.message.accountKeys; const delta = (address: string) => { const index = keys.indexOf(address); return index < 0 ? undefined : BigInt(chain.meta.postBalances[index]) - BigInt(chain.meta.preBalances[index]); };
    const network = BigInt(record.networkFeeLamports!); const setup = BigInt(record.temporaryAccountRentLamports!); const sponsored = network + setup; const settlement = BigInt(record.swapServiceFeeLamports!) + BigInt(record.rentServiceFeeLamports!) + sponsored; const userDelta = delta(record.walletAddress);
    const [source, wrapped] = await Promise.all([this.rpc.getAccountInfo(record.tokenAccount!), this.rpc.getAccountInfo(record.accountAddresses![1])]);
    const valid = BigInt(chain.meta.fee) === network && userDelta !== undefined && userDelta >= BigInt(record.netUserLamports!) && delta(record.feeDestination!) === settlement && delta(record.relayerAddress!) === -sponsored && source === null && wrapped === null;
    if (!valid) { await this.failDurableSubmission(record, 'recover_economics'); return { transactionId: record.id, signature: record.signature, status: 'failed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now }; }
    const reconciled = { ...record, status: 'reconciled' as const, confirmedAt: now, updatedAt: now };
    await this.durable.recordRecoverAccounting(reconciled, String(chain.meta.fee), String(userDelta)); await this.releaseDurableExposure(reconciled, 'reconciled_success');
    await this.durable.updateTransaction(record.id, { status: 'reconciled', confirmedAt: now, updatedAt: now }); await this.durable.updateIntentStatus(record.intentId, 'reconciled');
    return { transactionId: record.id, signature: record.signature, status: 'confirmed', networkFeeLamports: String(chain.meta.fee), reconciledAt: now };
  }

  private async failSubmittedRecover(recover: NonNullable<TransactionQuote['recover']>, signature: string, reason: string): Promise<ReconciliationResult> {
    const record = await this.durable.getTransaction(recover.prepared!.transactionId); if (record && record.status !== 'failed') await this.failDurableSubmission(record, reason);
    return { transactionId: recover.prepared!.transactionId, signature, status: 'failed', reconciledAt: new Date().toISOString() };
  }

  private async failDurableSubmission(record: DurableTransactionRecord, reason: string) {
    const now = new Date().toISOString(); await this.durable.appendEvent(record.id, 'recover_terminal_failure_proven', reason, { signature: record.signature, reason }, `${record.id}:terminal_failure:${reason}`); await this.releaseDurableExposure(record, reason);
    await this.durable.updateTransaction(record.id, { status: 'failed', failedAt: now, errorCode: 'CHAIN_EXECUTION_FAILED', errorStage: reason, updatedAt: now }); await this.durable.updateIntentStatus(record.intentId, 'failed');
  }

  private async releaseDurableExposure(record: DurableTransactionRecord, reason: string) {
    if (!this.risk || record.sponsoredCostLamports === undefined) return;
    await this.durable.appendEvent(record.id, 'sponsorship_release_authorized', 'sponsorship_release', { intentId: record.intentId, quoteId: record.quoteId, action: 'CLEAN_RECOVER', network: record.network, amountLamports: record.sponsoredCostLamports, reason }, `${record.id}:${reason}:release_authorized`);
    const result = await this.risk.releaseTransactionExposure({ network: record.network, walletAddress: record.walletAddress, action: 'CLEAN_RECOVER', transactionId: record.id, amountLamports: Number(record.sponsoredCostLamports) });
    await this.durable.appendEvent(record.id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason }, `${record.id}:${reason}:released`);
  }

  private async releaseSuccessfulExposure(quote: TransactionQuote) { const recover = quote.recover; if (!recover?.prepared) return; const record = await this.durable.getTransaction(recover.prepared.transactionId); if (record) await this.releaseDurableExposure(record, 'reconciled_success'); }
  private async releaseDeterministicNoBroadcastExposure(quote: TransactionQuote, reason: string) { const recover = quote.recover; if (!recover?.prepared) return; const record = await this.durable.getTransaction(recover.prepared.transactionId); if (record) await this.releaseDurableExposure(record, `no_broadcast_${reason}`); }
  private assertPolicy() { if (!this.policy.feeDestination) throw new GaslessError('CONFIGURATION_ERROR', 'recover_configuration', 'Recover Value fee settlement is not configured.'); new PublicKey(this.policy.feeDestination); for (const value of [this.policy.swapFeeBps, this.policy.rentFeeBps, this.policy.slippageBps, this.policy.maxPriceImpactBps, this.policy.minimumUserPayoutLamports, this.policy.maximumSponsoredCostLamports, this.policy.blockhashSlotsToExpiry, this.policy.preWalletMinimumBlockMargin, this.policy.attemptTtlSeconds]) if (!Number.isSafeInteger(value) || value < 0) throw new GaslessError('CONFIGURATION_ERROR', 'recover_configuration', 'Recover Value policy is invalid.'); if (this.policy.blockhashSlotsToExpiry < 100 || this.policy.blockhashSlotsToExpiry > 300 || this.policy.preWalletMinimumBlockMargin < 100 || this.policy.preWalletMinimumBlockMargin >= this.policy.blockhashSlotsToExpiry || this.policy.attemptTtlSeconds < this.quoteTtlSeconds) throw new GaslessError('CONFIGURATION_ERROR', 'recover_configuration', 'Recover Value blockhash policy is invalid.'); }
  private async failUnsigned(quote: TransactionQuote, code: string, stage: string, userSignatureReturned = false) { await this.terminalizeUnsigned(quote.quoteId, quote.intent.walletAddress, code, stage, userSignatureReturned, quote); }
  private async terminalizeUnsigned(quoteId: string, walletAddress: string, code: string, stage: string, userSignatureReturned = false, cachedQuote?: TransactionQuote) {
    const quote = cachedQuote ?? await this.temporary.getQuote(quoteId) ?? undefined; const record = await this.durable.getTransactionByQuoteId(quoteId);
    if (!record || record.actionType !== 'CLEAN_RECOVER') throw new GaslessError('QUOTE_NOT_FOUND', 'recover_cleanup', 'This Recover Value preparation was not found.');
    if (record.walletAddress !== walletAddress) throw new GaslessError('SESSION_ERROR', 'recover_cleanup', 'This Recover Value preparation belongs to a different wallet.');
    if (record.signature || !['created','prepared','simulated','awaiting_user_signature','failed'].includes(record.status)) throw new GaslessError('INVALID_REQUEST', 'recover_cleanup', 'A signed or terminal Recover Value transaction cannot use unsigned cleanup.');
    if (this.risk && record.sponsoredCostLamports !== undefined) {
      await this.durable.appendEvent(record.id, 'sponsorship_release_authorized', 'sponsorship_release', { action: 'CLEAN_RECOVER', reason: code, userSignatureReturned, payerSignatureReturned: false, broadcastAttempted: false }, `${record.id}:unsigned_release_authorized`);
      const result = await this.risk.releaseTransactionExposure({ network: record.network, walletAddress, action: 'CLEAN_RECOVER', transactionId: record.id, amountLamports: Number(record.sponsoredCostLamports) });
      await this.durable.appendEvent(record.id, 'sponsorship_reservation_released', 'sponsorship_release', { result, reason: code }, `${record.id}:unsigned_released`);
    }
    if (record.status !== 'failed') { const now = new Date().toISOString(); await this.durable.updateTransaction(record.id, { status: 'failed', failedAt: now, errorCode: code, errorStage: stage, updatedAt: now }); await this.durable.updateIntentStatus(record.intentId, 'failed'); await this.durable.appendEvent(record.id, 'recover_unsigned_terminal', stage, { code, userSignatureReturned, payerSignatureReturned: false, broadcastAttempted: false }, `${record.id}:unsigned_terminal`); }
    if (quote?.recover) { quote.status = 'failed'; quote.recover.status = 'failed'; await this.persistQuote(quote); }
  }
  private async quoteRoute(account: RecoverAccount, families: readonly ApprovedDexFamily[]) {
    const candidates = await Promise.allSettled(families.map(async (family) => ({ family, quote: await this.jupiter.quote({ inputMint: account.mint, amount: account.tokenAmountRaw, slippageBps: this.policy.slippageBps, dexes: [family], maxPriceImpactBps: this.policy.maxPriceImpactBps }) })));
    const valid = candidates.flatMap((candidate) => candidate.status === 'fulfilled' ? [candidate.value] : []).sort((left, right) => BigInt(right.quote.otherAmountThreshold) > BigInt(left.quote.otherAmountThreshold) ? 1 : BigInt(right.quote.otherAmountThreshold) < BigInt(left.quote.otherAmountThreshold) ? -1 : 0);
    if (!valid.length) throw new GaslessError('TOKEN_UNSUPPORTED', 'recover_route_policy', 'No approved Recover Value route is available for this token right now.');
    return valid[0] as { family: ApprovedDexFamily; quote: JupiterQuote };
  }
  private async buildRoute(account: RecoverAccount, walletAddress: string, feePayer: string, family: ApprovedDexFamily) { const build = await this.jupiter.build({ inputMint: account.mint, amount: account.tokenAmountRaw, taker: walletAddress, payer: feePayer, slippageBps: this.policy.slippageBps, dexes: [family], blockhashSlotsToExpiry: this.policy.blockhashSlotsToExpiry }); this.jupiter.validate(build, { inputMint: account.mint, amount: account.tokenAmountRaw, taker: walletAddress, payer: feePayer, slippageBps: this.policy.slippageBps, maxPriceImpactBps: this.policy.maxPriceImpactBps, dexes: [family] }, await this.rpc.getBlockHeight()); if (routeDexFamily(build) !== family) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'recover_route_policy', 'The executable route changed DEX family after review.'); return build; }
  private async requireQuote(id: string, wallet: string, allowFinished = false, allowExpired = false) { const quote = await this.temporary.getQuote(id); if (!quote?.recover) throw new GaslessError('QUOTE_NOT_FOUND', 'recover_quote', 'This Recover Value preview was not found.'); if (quote.intent.walletAddress !== wallet) throw new GaslessError('SESSION_ERROR', 'recover_quote', 'This preview belongs to a different wallet.'); if (!allowExpired && Date.parse(quote.expiresAt) <= Date.now() && quote.recover.status !== 'submitted' && quote.recover.status !== 'reconciled') throw new GaslessError('QUOTE_EXPIRED', 'recover_quote', 'This Recover Value preview expired. Scan again.'); if (!allowFinished && ['failed', 'reconciled'].includes(quote.status)) throw new GaslessError('QUOTE_ALREADY_USED', 'recover_quote', 'This Recover Value preview has already finished.'); return quote; }
  private async persistQuote(quote: TransactionQuote) { const ttl = quote.status === 'submitted' || quote.status === 'reconciled' || quote.recover?.status === 'submitted' ? 86_400 : quote.recover?.prepared ? 300 : Math.max(1, Math.ceil((Date.parse(quote.expiresAt) - Date.now()) / 1000)); await this.temporary.saveQuote(quote, ttl); }
}
