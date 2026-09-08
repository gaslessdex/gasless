import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { DurableTransactionRecord, ReconciliationResult, SendQuoteDetails, SolanaNetwork, TransactionIntent, TransactionQuote } from '../../shared/transactions/types.js';
import { deriveAssociatedTokenAddress, discoverSendTokens, inspectSendTokenAccount, validateDestinationAccount } from '../../chains/solana/send/accounts.js';
import { prepareSendTransaction, validateSignedSend } from '../../chains/solana/transactions/send.js';
import { versionedMessageHash, versionedSignerSignatureIsValid } from '../../chains/solana/transactions/clean.js';
import { EmergencyControlService } from '../controls/service.js';
import { GaslessError, asGaslessError } from '../errors.js';
import { log } from '../observability/logger.js';
import type { RelayerProvider } from '../relayer/provider.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { DurableStore } from '../storage/durable.js';
import type { TemporaryStore } from '../storage/temporary.js';
import type { TokenRegistry, TokenRegistryEntry } from '../token-registry/service.js';
import { WRAPPED_SOL_MINT, type PriceProvider } from '../pricing/service.js';
import type { OperationalRiskService } from '../risk/operational.js';
import { SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN, signingDeadlineHasMargin, swapSigningDeadline } from '../../chains/solana/swap/validity.js';
import { createSendSigningWindow, SEND_POST_SIGNATURE_BLOCK_MARGIN } from '../../chains/solana/send/validity.js';
import { currentScaledUiMultiplier, effectiveRawTokenUsdPriceMicros, isSupportedXStockMintProfile, parseToken2022Mint, tokenUiAmountToRaw } from '../../chains/solana/token-2022/accounts.js';
import { LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../../chains/solana/token-registry/types.js';
import { broadcastAndConfirmClean, confirmCleanSignature, observeCleanSignature, recordCleanConfirmationObservation, type CleanConfirmation } from '../clean/submission.js';

interface SendPolicy { reimbursementWallet?: string; serviceFeeWallet?: string; serviceFeeBps: number; serviceFeeCapUsdMicros: number; priceMaxAgeSeconds: number; maximumSponsoredCostLamports: number; relayerLowBalanceThresholdLamports: number }

const MUTATION_DIAGNOSTIC_KEYS = new Set([
  'schemaVersion', 'prepared', 'returned', 'differences', 'messageSha256', 'messageLength', 'transactionVersion', 'recentBlockhash', 'requiredSignatureCount',
  'staticAccountKeyCount', 'lookupTableCount', 'instructionCount', 'signerPublicKeys', 'signatureSlotsPopulated', 'instructions', 'index', 'programId', 'type',
  'accountIndexes', 'accountCount', 'dataLength', 'units', 'microLamports', 'amount', 'decimals', 'kind', 'preparedIndex', 'returnedIndex', 'publicKeys',
]);

function sanitizeMutationValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 128);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizeMutationValue(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => MUTATION_DIAGNOSTIC_KEYS.has(key)).map(([key, item]) => [key, sanitizeMutationValue(item, depth + 1)]).filter(([, item]) => item !== undefined));
}

function safeMutationDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 'wallet-mutation-v1') return undefined;
  const sanitized = sanitizeMutationValue(value);
  return sanitized && JSON.stringify(sanitized).length <= 32_000 ? sanitized : undefined;
}

function parseAmount(value: string, decimals: number, multiplier = 1) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new GaslessError('INVALID_REQUEST', 'send_amount', 'Enter an amount greater than zero.');
  const [, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new GaslessError('INVALID_REQUEST', 'send_amount', `This token supports up to ${decimals} decimal places.`);
  let raw: bigint;
  try { raw = multiplier === 1 ? BigInt(value.replace('.', '').padEnd(value.indexOf('.') < 0 ? value.length + decimals : value.indexOf('.') + decimals, '0')) : tokenUiAmountToRaw(value, decimals, multiplier); }
  catch { throw new GaslessError('INVALID_REQUEST', 'send_amount', 'Enter an amount greater than the smallest supported unit.'); }
  if (raw <= 0n) throw new GaslessError('INVALID_REQUEST', 'send_amount', 'Enter an amount greater than zero.');
  return raw;
}

export class SendEngine {
  constructor(private readonly temporary: TemporaryStore, private readonly durable: DurableStore, private readonly rpc: SolanaRpc, private readonly relayer: RelayerProvider, private readonly controls: EmergencyControlService, private readonly registry: TokenRegistry, private readonly quoteTtlSeconds: number, private readonly policy: SendPolicy, private readonly prices?: PriceProvider, private readonly risk?: OperationalRiskService) {}

  async listTokens() { return (await this.activeEntries()).map(({ mint, symbol, name, image, decimals }) => ({ mint, symbol, name, image, decimals })); }
  async discover(walletAddress: string, network: SolanaNetwork = 'devnet') { await this.controls.assertExecutionAllowed('SEND', network); return { ...await discoverSendTokens(this.rpc, walletAddress, await this.activeEntries()), network }; }

  async reconcileStatus(quoteId: string, walletAddress: string, network: SolanaNetwork) {
    const record = await this.durable.getTransactionByQuoteId(quoteId);
    if (!record || record.actionType !== 'SEND') return { status: 'not_submitted' as const };
    if (record.walletAddress !== walletAddress || record.network !== network) throw new GaslessError('SESSION_ERROR', 'send_reconciliation', 'This Send belongs to a different wallet or network.');
    if (record.status === 'reconciled') return { status: 'confirmed' as const, transactionId: record.id, signature: record.signature };
    if (record.status === 'failed') return { status: 'failed' as const, transactionId: record.id, signature: record.signature };
    if (record.status !== 'submitted' || !record.signature) return { status: 'not_submitted' as const, transactionId: record.id };
    const quote = await this.temporary.getQuote(quoteId);
    if (!quote?.send?.prepared) return { status: 'pending' as const, transactionId: record.id, signature: record.signature };
    const confirmation = await observeCleanSignature(this.rpc, record.signature, record.lastValidBlockHeight ?? quote.send.prepared.lastValidBlockHeight);
    if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'send', transactionId: record.id, signedMessageHash: record.preparedMessageHash, confirmation });
    const reconciliation = await this.finishSubmitted(quote, confirmation);
    return { status: reconciliation.status, transactionId: record.id, signature: record.signature, reconciliation };
  }

  async createQuote(input: { walletAddress: string; network: SolanaNetwork; mint: string; recipient: string; amount?: string; max?: boolean; clientRequestId: string; requestId: string }) {
    await this.controls.assertExecutionAllowed('SEND', input.network);
    if (!await this.temporary.consumeRateLimit(`send-quote:${input.walletAddress}`, 10, 60)) throw new GaslessError('RATE_LIMITED', 'send_quote', 'Too many Send requests. Wait a minute and try again.', true);
    if (!await this.temporary.acquireReplayLock(`send-request:${input.walletAddress}:${input.clientRequestId}`, input.requestId, this.quoteTtlSeconds)) throw new GaslessError('REPLAY_DETECTED', 'send_quote', 'This Send request was already received.');
    const evaluated = await this.registry.evaluate('SEND', input.mint); if (evaluated.decision === 'blocked') throw new GaslessError('TOKEN_PAUSED', 'send_token', 'This token is temporarily unavailable for this action.'); if (evaluated.decision !== 'supported' || !evaluated.entry) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_token', "Gasless Send isn't available for this token yet.");
    const entry = await this.liveEntry(await this.priced(evaluated.entry)); this.assertEntry(entry); const feePayer = await this.relayer.getFeePayerPublicKey(); const recipient = this.validateRecipient(input.recipient, input.walletAddress, feePayer);
    const sourceAddress = deriveAssociatedTokenAddress(input.walletAddress, entry.mint, entry.tokenProgram); const source = inspectSendTokenAccount(sourceAddress, await this.rpc.getAccountInfo(sourceAddress), input.walletAddress, entry);
    if (!source) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_source', 'This token account is not eligible for Gasless Send.');
    const destinationAccount = deriveAssociatedTokenAddress(recipient, entry.mint, entry.tokenProgram); const destinationInfo = await this.rpc.getAccountInfo(destinationAccount);
    try { if (destinationInfo) validateDestinationAccount(destinationInfo, recipient, entry.mint, destinationAccount, entry.tokenProgram, entry.token2022Profile?.tokenAccountSize); } catch { throw new GaslessError('INVALID_REQUEST', 'send_recipient', 'This address cannot safely receive Gasless Send.'); }
    await this.validateWalletAddressType(recipient, entry);
    const reimbursementDestination = deriveAssociatedTokenAddress(this.policy.reimbursementWallet!, entry.mint, entry.tokenProgram); const serviceFeeDestination = deriveAssociatedTokenAddress(this.policy.serviceFeeWallet!, entry.mint, entry.tokenProgram);
    if (sourceAddress === reimbursementDestination || sourceAddress === serviceFeeDestination) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_source', 'This wallet cannot use the GASLESS settlement accounts as its Send source.');
    for (const [address, owner] of [[reimbursementDestination, this.policy.reimbursementWallet!], [serviceFeeDestination, this.policy.serviceFeeWallet!]] as const) { try { validateDestinationAccount(await this.rpc.getAccountInfo(address), owner, entry.mint, address, entry.tokenProgram, entry.token2022Profile?.tokenAccountSize); } catch { throw new GaslessError('CONFIGURATION_ERROR', 'send_configuration', 'GASLESS Send settlement accounts are not configured for this token.'); } }
    const multiplier = entry.token2022Profile?.scaledUiAmount?.currentMultiplier ?? 1;
    const max = input.max === true; const amountRaw = max ? 0n : parseAmount(input.amount ?? '', entry.decimals, multiplier);
    const now = Date.now(); const intent: TransactionIntent = { intentId: crypto.randomUUID(), walletAddress: input.walletAddress, actionType: 'SEND', network: input.network, requestId: input.requestId, clientRequestId: input.clientRequestId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.quoteTtlSeconds * 1000).toISOString(), metadata: { mint: entry.mint, recipient, max: String(max) } };
    const send: SendQuoteDetails = { schemaVersion: 'send-v1', token: source, recipientWallet: recipient, destinationAccount, recipientAtaExists: Boolean(destinationInfo), max, recipientAmountRaw: amountRaw.toString(), sponsorReimbursementRaw: '0', serviceFeeRaw: '0', totalDebitRaw: '0', reimbursementDestination, serviceFeeDestination, pricing: { tokenUsdPriceMicros: entry.usdPriceMicros!, solUsdPriceMicros: entry.solUsdPriceMicros!, observedAt: entry.priceUpdatedAt! }, status: 'created' };
    const quote: TransactionQuote = { quoteId: crypto.randomUUID(), intent, status: 'created', createdAt: intent.createdAt, expiresAt: intent.expiresAt, send };
    const ataRent = send.recipientAtaExists ? 0n : BigInt(await this.rpc.getMinimumBalanceForRentExemption(entry.token2022Profile?.tokenAccountSize ?? 165));
    const preview = await prepareSendTransaction({ quote, send, feePayer, rpc: this.rpc, ataRentLamports: ataRent, tokenUsdPriceMicros: effectiveRawTokenUsdPriceMicros(BigInt(entry.usdPriceMicros!), multiplier), solUsdPriceMicros: BigInt(entry.solUsdPriceMicros!), reimbursementBufferBps: entry.reimbursementBufferBps ?? 0, serviceFeeBps: this.policy.serviceFeeBps, serviceFeeCapUsdMicros: BigInt(this.policy.serviceFeeCapUsdMicros), maximumSponsoredCostLamports: BigInt(this.policy.maximumSponsoredCostLamports) });
    Object.assign(send, { recipientAmountRaw: preview.recipientAmount.toString(), sponsorReimbursementRaw: preview.reimbursement.toString(), serviceFeeRaw: preview.serviceFee.toString(), totalDebitRaw: preview.total.toString(), networkFeeLamports: preview.networkFeeLamports.toString(), ataCreationLamports: ataRent.toString(), sponsoredCostLamports: preview.sponsoredCostLamports.toString(), expectedRelayer: feePayer });
    await this.temporary.saveQuote(quote, this.quoteTtlSeconds); await this.durable.createIntent(intent, quote.quoteId);
    log('info', 'send_quote_created', { requestId: input.requestId, quoteId: quote.quoteId, walletAddress: input.walletAddress, mint: entry.mint, recipientAtaExists: send.recipientAtaExists }); return quote;
  }

  async prepare(quoteId: string, walletAddress: string, requestId: string, requestReceivedAt = Date.now(), deferSigningWindow = false) {
    const quoteLookupStarted = Date.now(); const quote = await this.requireQuote(quoteId, walletAddress); const quoteLookupMs = Date.now() - quoteLookupStarted; const send = quote.send!;
    if (send.prepared) { if (!signingDeadlineHasMargin(send.prepared.walletSigningExpiresAt)) throw this.refreshRequired(); return quote; }
    if (!swapSigningDeadline(quote.expiresAt)) throw this.refreshRequired();

    const controlsStarted = Date.now(); await this.controls.assertExecutionAllowed('SEND', quote.intent.network); const controlsMs = Date.now() - controlsStarted;
    let tokenRegistryMs = 0; let sourceAccountMs = 0; let recipientAccountMs = 0; let treasuryAccountMs = 0; let payerMs = 0; let rentMs = 0;
    const timed = async <T>(work: () => Promise<T>, record: (durationMs: number) => void) => { const started = Date.now(); try { return await work(); } finally { record(Date.now() - started); } };
    const reimbursementAccountPromise = timed(() => this.rpc.getAccountInfo(send.reimbursementDestination), (duration) => { treasuryAccountMs = Math.max(treasuryAccountMs, duration); });
    const [evaluated, currentSource, currentDestination, reimbursementAccount, serviceFeeAccount, feePayer, rent] = await Promise.all([
      timed(() => this.registry.evaluate('SEND', send.token.mint), (duration) => { tokenRegistryMs = duration; }),
      timed(() => this.rpc.getAccountInfo(send.token.sourceAccount), (duration) => { sourceAccountMs = duration; }),
      timed(() => this.rpc.getAccountInfo(send.destinationAccount), (duration) => { recipientAccountMs = duration; }),
      reimbursementAccountPromise,
      send.serviceFeeDestination === send.reimbursementDestination ? reimbursementAccountPromise : timed(() => this.rpc.getAccountInfo(send.serviceFeeDestination), (duration) => { treasuryAccountMs = Math.max(treasuryAccountMs, duration); }),
      timed(() => this.relayer.getFeePayerPublicKey(), (duration) => { payerMs = duration; }),
      timed(() => send.recipientAtaExists ? Promise.resolve(0) : this.rpc.getMinimumBalanceForRentExemption(send.token.tokenAccountSize ?? 165), (duration) => { rentMs = duration; }),
    ]);
    if (evaluated.decision === 'blocked') throw new GaslessError('TOKEN_PAUSED', 'send_token', 'This token is temporarily unavailable for this action.');
    if (evaluated.decision !== 'supported' || !evaluated.entry) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_token', "Gasless Send isn't available for this token yet.");
    const pricingStarted = Date.now(); if (!send.pricing) throw this.refreshRequired(); const entry = await this.liveEntry({ ...evaluated.entry, usdPriceMicros: send.pricing.tokenUsdPriceMicros, solUsdPriceMicros: send.pricing.solUsdPriceMicros, priceUpdatedAt: send.pricing.observedAt }); const pricingCompletedAt = new Date().toISOString(); const pricingMs = Date.now() - pricingStarted; this.assertEntry(entry);
    const multiplier = entry.token2022Profile?.scaledUiAmount?.currentMultiplier ?? 1;
    if ((send.token.uiMultiplier ?? 1) !== multiplier || (send.token.tokenAccountSize ?? 165) !== (entry.token2022Profile?.tokenAccountSize ?? 165)) throw this.refreshRequired();
    const source = inspectSendTokenAccount(send.token.sourceAccount, currentSource, walletAddress, entry);
    if (!source || BigInt(source.balanceRaw) < BigInt(send.totalDebitRaw) || (send.max && source.balanceRaw !== send.token.balanceRaw)) throw new GaslessError('QUOTE_EXPIRED', 'send_source', 'Your USDC balance changed. Review the updated Send costs.');
    if (Boolean(currentDestination) !== send.recipientAtaExists) throw new GaslessError('QUOTE_EXPIRED', 'send_recipient', 'The recipient account changed. Refresh the Send preview.');
    try { if (currentDestination) validateDestinationAccount(currentDestination, send.recipientWallet, send.token.mint, send.destinationAccount, entry.tokenProgram, entry.token2022Profile?.tokenAccountSize); }
    catch { throw new GaslessError('INVALID_REQUEST', 'send_recipient', 'The recipient account state changed. Review the Send again.'); }
    try {
      validateDestinationAccount(reimbursementAccount, this.policy.reimbursementWallet!, send.token.mint, send.reimbursementDestination, entry.tokenProgram, entry.token2022Profile?.tokenAccountSize);
      validateDestinationAccount(serviceFeeAccount, this.policy.serviceFeeWallet!, send.token.mint, send.serviceFeeDestination, entry.tokenProgram, entry.token2022Profile?.tokenAccountSize);
    } catch { throw new GaslessError('CONFIGURATION_ERROR', 'send_configuration', 'GASLESS Send settlement accounts are not configured for this token.'); }
    const stateChecksCompletedAt = new Date().toISOString();
    const ataRent = BigInt(rent);
    const buildStarted = Date.now(); const result = await prepareSendTransaction({ quote, send, feePayer, rpc: this.rpc, ataRentLamports: ataRent, tokenUsdPriceMicros: effectiveRawTokenUsdPriceMicros(BigInt(entry.usdPriceMicros!), multiplier), solUsdPriceMicros: BigInt(entry.solUsdPriceMicros!), reimbursementBufferBps: entry.reimbursementBufferBps ?? 0, serviceFeeBps: this.policy.serviceFeeBps, serviceFeeCapUsdMicros: BigInt(this.policy.serviceFeeCapUsdMicros), maximumSponsoredCostLamports: BigInt(this.policy.maximumSponsoredCostLamports) }); const transactionBuildAndSimulationMs = Date.now() - buildStarted;
    if (send.recipientAmountRaw !== result.recipientAmount.toString() || send.sponsorReimbursementRaw !== result.reimbursement.toString() || send.serviceFeeRaw !== result.serviceFee.toString() || send.totalDebitRaw !== result.total.toString() || send.networkFeeLamports !== result.networkFeeLamports.toString() || send.sponsoredCostLamports !== result.sponsoredCostLamports.toString() || send.ataCreationLamports !== ataRent.toString()) throw this.refreshRequired();
    const heightStarted = Date.now(); const currentBlockHeight = await this.rpc.getBlockHeight(); const initialBlockHeightMs = Date.now() - heightStarted;
    if (result.prepared.lastValidBlockHeight - currentBlockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'send_blockhash_margin', 'Send blockhash safety is too low. Review the Send again.');
    result.prepared.preparationTimeline = { requestReceivedAt: new Date(requestReceivedAt).toISOString(), stateChecksCompletedAt, pricingCompletedAt, blockhashFetchedAt: result.timings.blockhashFetchedAt, transactionBuiltAt: result.timings.transactionBuiltAt, simulationCompletedAt: result.timings.simulationCompletedAt, economicsValidatedAt: new Date().toISOString() };
    result.prepared.preparationTimings = { requestReceivedAt: new Date(requestReceivedAt).toISOString(), quoteLookupMs, controlsMs, tokenRegistryMs, accountStateMs: Math.max(sourceAccountMs, recipientAccountMs, treasuryAccountMs), sourceAccountMs, recipientAccountMs, treasuryAccountMs, pricingMs, payerAndRentMs: Math.max(payerMs, rentMs), payerMs, rentMs, blockhashMs: result.timings.blockhashMs, transactionConstructionMs: result.timings.transactionConstructionMs, feeCalculationMs: result.timings.feeCalculationMs, simulationMs: result.timings.simulationMs, transactionBuildAndSimulationMs, initialBlockHeightMs, durablePersistenceMs: 0 };
    Object.assign(send, { recipientAmountRaw: result.recipientAmount.toString(), sponsorReimbursementRaw: result.reimbursement.toString(), serviceFeeRaw: result.serviceFee.toString(), totalDebitRaw: result.total.toString(), networkFeeLamports: result.networkFeeLamports.toString(), ataCreationLamports: ataRent.toString(), sponsoredCostLamports: result.sponsoredCostLamports.toString(), expectedRelayer: feePayer, prepared: result.prepared, status: 'awaiting_user_signature' }); quote.status = 'awaiting_user_signature';
    const now = new Date().toISOString(); const record: DurableTransactionRecord = { id: result.prepared.transactionId, intentId: quote.intent.intentId, quoteId, walletAddress, actionType: 'SEND', network: quote.intent.network, status: quote.status, preparedMessageHash: result.prepared.preparedMessageHash, recentBlockhash: result.prepared.recentBlockhash, lastValidBlockHeight: result.prepared.lastValidBlockHeight, relayerAddress: feePayer, mint: send.token.mint, tokenAccount: send.token.sourceAccount, tokenDecimals: send.token.decimals, recipientWallet: send.recipientWallet, destinationAccount: send.destinationAccount, recipientAtaCreated: !send.recipientAtaExists, recipientAmountRaw: send.recipientAmountRaw, sponsorReimbursementRaw: send.sponsorReimbursementRaw, serviceFeeRaw: send.serviceFeeRaw, totalDebitRaw: send.totalDebitRaw, sponsoredCostLamports: send.sponsoredCostLamports, networkFeeLamports: send.networkFeeLamports, ataCreationLamports: send.ataCreationLamports, reimbursementDestination: send.reimbursementDestination, serviceFeeDestination: send.serviceFeeDestination, createdAt: now, updatedAt: now };
    const durableStarted = Date.now(); await this.durable.createTransaction(record); await this.durable.appendEvent(record.id, 'send_attempted', 'prepared', { simulation: 'passed', recipientAtaCreated: record.recipientAtaCreated }, `${record.id}:prepared`); await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status); result.prepared.preparationTimings.durablePersistenceMs = Date.now() - durableStarted; result.prepared.preparationTimeline.durablePreparationCompletedAt = new Date().toISOString();
    log('info', 'send_prepared', { requestId, quoteId, transactionId: record.id, walletAddress, mint: send.token.mint, recipientAmountRaw: send.recipientAmountRaw, sponsoredCostLamports: send.sponsoredCostLamports, preparationTimings: result.prepared.preparationTimings }); return deferSigningWindow ? quote : this.activateSigningWindow(quote, requestId, 0);
  }

  async activateSigningWindow(quote: TransactionQuote, requestId: string, reservationMs: number) {
    const send = quote.send; const prepared = send?.prepared;
    if (!send || !prepared) throw new GaslessError('INVALID_REQUEST', 'send_prepare', 'The Send preparation was not completed.');
    if (signingDeadlineHasMargin(prepared.walletSigningExpiresAt)) return quote;
    prepared.preparationTimings = { ...prepared.preparationTimings!, reservationMs };
    prepared.preparationTimeline = { ...prepared.preparationTimeline!, reservationCompletedAt: new Date().toISOString() };
    try {
      const heightStarted = Date.now(); const currentBlockHeight = await this.rpc.getBlockHeight(); const finalBlockHeightMs = Date.now() - heightStarted;
      const window = createSendSigningWindow(prepared.lastValidBlockHeight, currentBlockHeight);
      if (!window) throw new GaslessError('QUOTE_EXPIRED', 'send_blockhash_margin', 'Send blockhash safety is too low. Review the Send again.');
      Object.assign(prepared, { walletSigningReadyAt: window.readyAt, walletSigningExpiresAt: window.walletSigningExpiresAt, walletSigningWindowMs: window.walletSigningWindowMs, preparedBlockHeight: window.preparedBlockHeight });
      prepared.preparationTimeline.signingDeadlineCreatedAt = window.readyAt;
      quote.expiresAt = window.quoteExpiresAt; quote.intent.expiresAt = window.quoteExpiresAt;
      const activationStarted = Date.now(); await this.persistQuote(quote); const activationPersistenceMs = Date.now() - activationStarted;
      Object.assign(prepared.preparationTimings!, { finalBlockHeightMs, activationPersistenceMs, totalServerMs: Date.now() - Date.parse(prepared.preparationTimings!.requestReceivedAt) });
      log('info', 'send_wallet_window_started', { requestId, quoteId: quote.quoteId, transactionId: prepared.transactionId, walletSigningReadyAt: prepared.walletSigningReadyAt, walletSigningExpiresAt: prepared.walletSigningExpiresAt, walletSigningWindowMs: prepared.walletSigningWindowMs, preparedBlockHeight: prepared.preparedBlockHeight, lastValidBlockHeight: prepared.lastValidBlockHeight, blockHeightMargin: prepared.lastValidBlockHeight - prepared.preparedBlockHeight!, preparationTimings: prepared.preparationTimings });
      return quote;
    } catch (error) {
      await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('DATABASE_ERROR', 'send_prepare', 'Send preparation could not be completed.', true));
      throw error;
    }
  }

  async abortBeforeWallet(quote: TransactionQuote, error: unknown) {
    await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('SPONSOR_LIMIT_EXCEEDED', 'sponsorship_policy', 'Sponsored transactions are temporarily unavailable.', true));
  }

  async currentWalletGateBlockHeight(quoteId: string, walletAddress: string) {
    const quote = await this.requireQuote(quoteId, walletAddress);
    try {
      if (!quote.send?.prepared || !signingDeadlineHasMargin(quote.send.prepared.walletSigningExpiresAt)) throw this.refreshRequired();
      await this.controls.assertExecutionAllowed('SEND', quote.intent.network);
      const blockHeight = await this.rpc.getBlockHeight();
      if (quote.send.prepared.lastValidBlockHeight - blockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'send_blockhash_margin', 'Send blockhash safety is too low. Review the Send again.');
      return blockHeight;
    } catch (error) {
      await this.failBeforeWallet(quote, error instanceof GaslessError ? error : new GaslessError('RPC_ERROR', 'send_wallet_gate', 'Send safety could not be verified.', true));
      throw error;
    }
  }

  async currentWalletApprovalBlockHeight(quoteId: string, walletAddress: string) {
    await this.requireWalletQuote(quoteId, walletAddress);
    return this.rpc.getBlockHeight();
  }

  async recordWalletEvent(quoteId: string, walletAddress: string, event: string, metadata: Record<string, unknown> = {}) {
    const quote = await this.requireWalletQuote(quoteId, walletAddress); const prepared = quote.send!.prepared!;
    const allowed = new Set(['invoked', 'returned', 'failed', 'expired']); if (!allowed.has(event)) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'Unknown wallet event.');
    const blockHeight = await this.rpc.getBlockHeight(); const recordedAt = new Date().toISOString();
    const safeMetadata: Record<string, unknown> = Object.fromEntries(Object.entries(metadata).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 240) : value]));
    const mutationDiagnostics = safeMutationDiagnostics(metadata.mutationDiagnostics); if (mutationDiagnostics) safeMetadata.mutationDiagnostics = mutationDiagnostics;
    await this.durable.appendEvent(prepared.transactionId, `send_wallet_${event}`, 'wallet_signing', { quoteId, intentId: quote.intent.intentId, ...safeMetadata, recordedAt, blockHeight, remainingBlocks: prepared.lastValidBlockHeight - blockHeight }, `${prepared.transactionId}:wallet:${event}`);
    return { recordedAt, blockHeight, remainingBlocks: prepared.lastValidBlockHeight - blockHeight };
  }

  async abortWalletApproval(quoteId: string, walletAddress: string, reason: string, userSignatureReturned: boolean) {
    const quote = await this.requireWalletQuote(quoteId, walletAddress); const prepared = quote.send!.prepared!;
    const allowed = new Set(['USER_EXPLICITLY_CANCELLED', 'WALLET_SIGNING_TIMEOUT', 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', 'WALLET_PROVIDER_ERROR', 'POST_SIGN_VERIFICATION_FAILED', 'WALLET_ACCOUNT_CHANGED', 'APP_ABORTED_SIGNING_FLOW', 'SESSION_DISCONNECTED', 'UNKNOWN_WALLET_FAILURE']);
    if (!allowed.has(reason)) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'Unknown wallet failure.');
    const blockHeight = await this.rpc.getBlockHeight(); const remainingBlocks = prepared.lastValidBlockHeight - blockHeight;
    if (reason === 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN' && !userSignatureReturned && remainingBlocks >= 0) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The wallet attempt is not yet provably expired.');
    if (reason === 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN' && userSignatureReturned && remainingBlocks >= SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The signed transaction still has a safe submission margin.');
    await this.failAfterWallet(quote, reason, userSignatureReturned, blockHeight); return { status: 'failed' as const };
  }

  async abortWalletGate(quoteId: string, walletAddress: string, reason: string) {
    const quote = await this.requireQuote(quoteId, walletAddress);
    const error = reason === 'blockhash_margin'
      ? new GaslessError('QUOTE_EXPIRED', 'send_blockhash_margin', 'Send blockhash safety is too low. Review the Send again.')
      : new GaslessError('QUOTE_EXPIRED', 'send_wallet_gate', 'Send preparation expired before wallet approval.');
    await this.failBeforeWallet(quote, error);
  }

  async submit(input: { quoteId: string; walletAddress: string; signedTransaction: string; clientRequestId: string; requestId: string }) {
    const quote = await this.requireQuote(input.quoteId, input.walletAddress, true, true); const send = quote.send!; if (!send.prepared) throw new GaslessError('INVALID_REQUEST', 'send_submit', 'Prepare this Send before submitting it.');
    if (send.status === 'reconciled' && send.signature && send.reconciliation) { await this.releaseSuccessfulExposure(quote); return { transactionId: send.prepared.transactionId, signature: send.signature, reconciliation: send.reconciliation, alreadyCompleted: true }; }
    if (send.status === 'submitted' && send.signature) return this.resumeSubmitted(quote);
    await this.controls.assertExecutionAllowed('SEND', quote.intent.network); if (!await this.temporary.consumeRateLimit(`send-submit:${input.walletAddress}`, 5, 60)) throw new GaslessError('RATE_LIMITED', 'send_submit', 'Too many Send attempts. Wait a minute and try again.', true);
    const replayKeys = [`send-submission:${input.quoteId}`, `message:${send.prepared.preparedMessageHash}`, `send-submit-request:${input.walletAddress}:${input.clientRequestId}`]; const acquired: string[] = []; let crossed = false; let signature: string | undefined;
    try {
      for (const key of replayKeys) { if (!await this.temporary.acquireReplayLock(key, input.requestId, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Send was already submitted.'); acquired.push(key); }
      const signedReturnBlockHeight = await this.rpc.getBlockHeight(); if (send.prepared.lastValidBlockHeight - signedReturnBlockHeight < SEND_POST_SIGNATURE_BLOCK_MARGIN) throw new GaslessError('QUOTE_EXPIRED', 'wallet_signing', 'Transaction expired while awaiting wallet approval. Nothing was sent.');
      const validated = await validateSignedSend(input.signedTransaction, send.prepared, this.rpc);
      if (validated.messageHash !== send.prepared.preparedMessageHash) { const finalMessageKey = `message:${validated.messageHash}`; if (!await this.temporary.acquireReplayLock(finalMessageKey, input.requestId, 86_400)) throw new GaslessError('REPLAY_DETECTED', 'replay', 'This Send was already submitted.'); acquired.push(finalMessageKey); }
      await this.recheck(send, input.walletAddress); await this.controls.assertExecutionAllowed('SEND', quote.intent.network);
      const transaction = VersionedTransaction.deserialize(Buffer.from(validated.serializedTransaction, 'base64')); const predictedFee = await this.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
      if (predictedFee === null || String(predictedFee) !== send.networkFeeLamports || BigInt(send.sponsoredCostLamports!) > BigInt(this.policy.maximumSponsoredCostLamports)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The sponsored Send cost no longer matches the preview.');
      if (await this.rpc.getBalance(send.prepared.expectedFeePayer) < Number(BigInt(send.sponsoredCostLamports!)) + this.policy.relayerLowBalanceThresholdLamports) throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_boundary', 'Gasless Send is temporarily unavailable. Your tokens have not moved.');
      crossed = true; send.status = 'relaying'; quote.status = 'relaying'; await this.persistQuote(quote); await this.durable.updateTransaction(send.prepared.transactionId, { status: 'relaying', updatedAt: new Date().toISOString() });
      const fullySigned = await this.relayer.signTransaction(validated.serializedTransaction);
      const fullySignedTransaction = VersionedTransaction.deserialize(Buffer.from(fullySigned, 'base64'));
      if (versionedMessageHash(fullySignedTransaction) !== validated.messageHash || fullySignedTransaction.message.recentBlockhash !== send.prepared.recentBlockhash) throw new GaslessError('MESSAGE_MISMATCH', 'relayer_boundary', 'The signed Send changed after approval. Nothing was submitted.');
      if (!versionedSignerSignatureIsValid(fullySignedTransaction, 0, send.prepared.expectedFeePayer)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer_boundary', 'The Send payer signature is invalid. Nothing was submitted.');
      const simulation = await this.rpc.simulateTransaction(fullySigned, true); if (simulation.err !== null) throw new GaslessError('SIMULATION_FAILED', 'final_signed_simulation', 'This Send no longer passes GASLESS safety checks. Your tokens have not moved.');
      signature = bs58.encode(fullySignedTransaction.signatures[0]); send.signature = signature; send.status = 'submitted'; quote.status = 'submitted'; const submittedAt = new Date().toISOString(); await this.durable.updateTransaction(send.prepared.transactionId, { status: 'submitted', signature, submittedAt, updatedAt: submittedAt }); await this.durable.appendEvent(send.prepared.transactionId, 'send_submitted', 'submitted', { signature, recentBlockhash: send.prepared.recentBlockhash, lastValidBlockHeight: send.prepared.lastValidBlockHeight, signedMessageHash: validated.messageHash }, `${send.prepared.transactionId}:submitted`); await this.persistQuote(quote);
      const confirmation = await broadcastAndConfirmClean({ rpc: this.rpc, durable: this.durable, eventPrefix: 'send', prepared: send.prepared, fullySigned, canonicalSignature: signature, signedMessageHash: validated.messageHash });
      const reconciliation = await this.finishSubmitted(quote, confirmation);
      if (reconciliation.status !== 'confirmed') throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Send was submitted and is still being verified.', true);
      return { transactionId: send.prepared.transactionId, signature, confirmation, reconciliation, alreadyCompleted: false };
    } catch (error) {
      const normalized = asGaslessError(error, 'send_submit', input.requestId); if (!crossed) for (const key of acquired) await this.temporary.releaseReplayLockIfSafe(key, input.requestId);
      if (!signature) { send.status = crossed ? 'failed' : 'awaiting_user_signature'; quote.status = send.status; await this.persistQuote(quote).catch(() => undefined); await this.durable.updateTransaction(send.prepared.transactionId, { status: send.status, failedAt: crossed ? new Date().toISOString() : undefined, errorCode: normalized.code, errorStage: normalized.stage, updatedAt: new Date().toISOString() }).catch(() => undefined); }
      await this.durable.appendEvent(send.prepared.transactionId, 'send_failed', normalized.stage, { code: normalized.code }, `${send.prepared.transactionId}:failed:${normalized.code}`).catch(() => undefined); log('error', 'send_rejected', { requestId: input.requestId, quoteId: input.quoteId, code: normalized.code, stage: normalized.stage }); throw normalized;
    }
  }

  private validateRecipient(value: string, sender: string, feePayer: string) { let key: PublicKey; try { key = new PublicKey(value); } catch { throw new GaslessError('INVALID_REQUEST', 'send_recipient', 'Enter a valid Solana wallet address.'); } if (!PublicKey.isOnCurve(key.toBytes()) || key.toBase58() === sender || [feePayer, this.policy.reimbursementWallet, this.policy.serviceFeeWallet].includes(key.toBase58())) throw new GaslessError('INVALID_REQUEST', 'send_recipient', key.toBase58() === sender ? 'Sending to your own wallet is not supported.' : 'Enter a valid Solana wallet address.'); return key.toBase58(); }
  private async activeEntries() { const entries = await this.registry.list('SEND'); const token2022 = entries.filter((entry) => entry.tokenProgram === TOKEN_2022_PROGRAM); const accounts = token2022.length ? await this.rpc.getMultipleAccounts(token2022.map((entry) => entry.mint)) : []; const byMint = new Map(token2022.map((entry, index) => [entry.mint, accounts[index] ?? null])); return entries.map((entry) => { try { const current = entry.tokenProgram === TOKEN_2022_PROGRAM ? this.liveEntryFromAccount(entry, byMint.get(entry.mint) ?? null) : entry; this.assertIdentity(current); return current; } catch { return null; } }).filter((entry): entry is TokenRegistryEntry => Boolean(entry)); }
  private async validateWalletAddressType(recipient: string, entry: TokenRegistryEntry) { const info = await this.rpc.getAccountInfo(recipient); if (info && (info.owner === entry.tokenProgram || recipient === entry.mint)) throw new GaslessError('INVALID_REQUEST', 'send_recipient', 'Enter a recipient wallet address, not a token account.'); }
  private assertIdentity(entry: TokenRegistryEntry) { new PublicKey(entry.mint); new PublicKey(entry.tokenProgram); if (!this.policy.reimbursementWallet || !this.policy.serviceFeeWallet) throw new Error(); new PublicKey(this.policy.reimbursementWallet); new PublicKey(this.policy.serviceFeeWallet); const legacy = !entry.extensions.length && entry.tokenProgram === LEGACY_TOKEN_PROGRAM; const xstock = entry.tokenProgram === TOKEN_2022_PROGRAM && entry.token2022Profile?.transferHook?.programId === null && entry.token2022Profile.defaultAccountState === 'INITIALIZED' && entry.token2022Profile.pausable?.paused === false && entry.token2022Profile.tokenAccountSize === 179; if ((!legacy && !xstock) || !Number.isInteger(entry.decimals) || entry.decimals < 1 || entry.decimals > 9) throw new Error(); }
  private assertEntry(entry: TokenRegistryEntry) { try { this.assertIdentity(entry); const priceTime = Date.parse(entry.priceUpdatedAt ?? ''); const age = Date.now() - priceTime; if (BigInt(entry.usdPriceMicros ?? '0') <= 0n || BigInt(entry.solUsdPriceMicros ?? '0') <= 0n || !Number.isFinite(priceTime) || age < -30_000 || age > this.policy.priceMaxAgeSeconds * 1000 || !Number.isSafeInteger(this.policy.maximumSponsoredCostLamports) || this.policy.maximumSponsoredCostLamports <= 0) throw new Error(); } catch { throw new GaslessError('TOKEN_UNSUPPORTED', 'send_price', "We can't calculate a safe gasless fee for this token right now."); } }
  private async priced(entry: TokenRegistryEntry) { if (!this.prices) return entry; const prices = await this.prices.getUsdPrices([entry.mint]); await this.prices.assertExecutablePriceConfidence?.(entry.mint, entry.decimals, prices, entry.token2022Profile?.scaledUiAmount?.currentMultiplier ?? 1); return { ...entry, usdPriceMicros: prices[entry.mint]?.usdPriceMicros, solUsdPriceMicros: prices[WRAPPED_SOL_MINT]?.usdPriceMicros, priceUpdatedAt: [prices[entry.mint]?.observedAt, prices[WRAPPED_SOL_MINT]?.observedAt].sort()[0] }; }
  private async recheck(send: SendQuoteDetails, wallet: string) { const { entry: configured, decision } = await this.registry.evaluate('SEND', send.token.mint); if (decision !== 'supported' || !configured) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_token', 'This token is temporarily unavailable.'); const entry = await this.liveEntry(configured); this.assertIdentity(entry); if ((send.token.uiMultiplier ?? 1) !== (entry.token2022Profile?.scaledUiAmount?.currentMultiplier ?? 1)) throw new GaslessError('QUOTE_EXPIRED', 'send_mint', 'This token changed. Review the updated Send amount.'); const source = inspectSendTokenAccount(send.token.sourceAccount, await this.rpc.getAccountInfo(send.token.sourceAccount), wallet, entry); if (!source || BigInt(source.balanceRaw) < BigInt(send.totalDebitRaw)) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_balance', `You need a little more ${send.token.symbol} to cover the amount, GASLESS fee, and sponsored network cost.`); const destination = await this.rpc.getAccountInfo(send.destinationAccount); if (Boolean(destination) !== send.recipientAtaExists) throw new GaslessError('MESSAGE_MISMATCH', 'send_state_recheck', 'The recipient token account changed. Refresh the Send preview.'); if (destination) { try { validateDestinationAccount(destination, send.recipientWallet, send.token.mint, send.destinationAccount, entry.tokenProgram, entry.token2022Profile?.tokenAccountSize); } catch { throw new GaslessError('MESSAGE_MISMATCH', 'send_state_recheck', 'The recipient token account changed. Refresh the Send preview.'); } } }
  private async liveEntry(entry: TokenRegistryEntry) { if (entry.tokenProgram !== TOKEN_2022_PROGRAM) return entry; return this.liveEntryFromAccount(entry, await this.rpc.getAccountInfo(entry.mint)); }
  private liveEntryFromAccount(entry: TokenRegistryEntry, account: Awaited<ReturnType<SolanaRpc['getAccountInfo']>>) { if (!account) throw new Error('Token-2022 mint missing'); const profile = parseToken2022Mint(entry.mint, account); if (!entry.token2022Profile || !isSupportedXStockMintProfile(profile)) throw new Error('Unsupported Token-2022 profile'); const currentMultiplier = currentScaledUiMultiplier(profile); return { ...entry, token2022Profile: { ...entry.token2022Profile, mintAccountSize: profile.accountSize, tokenAccountSize: profile.tokenAccountSize, transferHook: profile.transferHook ? { ...profile.transferHook, extraAccountMetaList: null } : null, metadataPointer: profile.metadataPointer, permanentDelegate: profile.permanentDelegate, defaultAccountState: profile.defaultAccountState, pausable: profile.pausable, confidentialTransferMint: profile.confidentialTransferMint, scaledUiAmount: profile.scaledUiAmount ? { ...profile.scaledUiAmount, currentMultiplier } : null } }; }
  private async resumeSubmitted(quote: TransactionQuote, alreadyCompleted = true) { const send = quote.send!; const confirmation = await confirmCleanSignature(this.rpc, send.signature!, send.prepared!.lastValidBlockHeight); if (confirmation.outcome !== 'timeout_unknown') await recordCleanConfirmationObservation({ durable: this.durable, eventPrefix: 'send', transactionId: send.prepared!.transactionId, signedMessageHash: send.prepared!.preparedMessageHash, confirmation }); const reconciliation = await this.finishSubmitted(quote, confirmation); if (reconciliation.status !== 'confirmed') throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'This Send was submitted and is still being verified.', true); return { transactionId: send.prepared!.transactionId, signature: send.signature!, confirmation, reconciliation, alreadyCompleted }; }
  private async finishSubmitted(quote: TransactionQuote, confirmation: CleanConfirmation) { const send = quote.send!; let reconciliation: ReconciliationResult; if (confirmation.outcome === 'expired' || confirmation.outcome === 'confirmed_chain_error') { const now = new Date().toISOString(); reconciliation = { transactionId: send.prepared!.transactionId, signature: confirmation.signature, status: 'failed', reconciledAt: now }; await this.durable.updateTransaction(send.prepared!.transactionId, { status: 'failed', failedAt: now, errorCode: 'RECONCILIATION_FAILED', errorStage: confirmation.outcome, updatedAt: now }); await this.releaseTerminalExposure(quote, confirmation.outcome); } else reconciliation = await this.reconcile(quote, confirmation); send.reconciliation = reconciliation; send.status = reconciliation.status === 'confirmed' ? 'reconciled' : reconciliation.status === 'failed' ? 'failed' : 'submitted'; quote.status = send.status; await this.persistQuote(quote); await this.durable.updateIntentStatus(quote.intent.intentId, quote.status); return reconciliation; }
  private async reconcile(quote: TransactionQuote, confirmation: { signature: string; outcome: string }): Promise<ReconciliationResult> { const send = quote.send!; const transactionId = send.prepared!.transactionId; const now = new Date().toISOString(); if (confirmation.outcome !== 'confirmed_success') return { transactionId, signature: confirmation.signature, status: confirmation.outcome === 'confirmed_chain_error' ? 'failed' : 'pending', reconciledAt: now }; const chain = await this.rpc.getTransaction(confirmation.signature); if (!chain || chain.meta.err !== null) return { transactionId, signature: confirmation.signature, status: chain ? 'failed' : 'pending', reconciledAt: now }; const keys = chain.transaction.message.accountKeys.map(String); const amount = (items: NonNullable<typeof chain.meta.postTokenBalances>, address: string) => items.find((item) => item.accountIndex === keys.indexOf(address) && item.mint === send.token.mint)?.uiTokenAmount.amount; const delta = (address: string) => BigInt(amount(chain.meta.postTokenBalances ?? [], address) ?? '0') - BigInt(amount(chain.meta.preTokenBalances ?? [], address) ?? '0'); const expected = new Map<string, bigint>(); for (const [address, value] of [[send.destinationAccount, BigInt(send.recipientAmountRaw)], [send.reimbursementDestination, BigInt(send.sponsorReimbursementRaw)], [send.serviceFeeDestination, BigInt(send.serviceFeeRaw)]] as const) expected.set(address, (expected.get(address) ?? 0n) + value); const tokenMatches = delta(send.token.sourceAccount) === -BigInt(send.totalDebitRaw) && [...expected].every(([address, value]) => delta(address) === value); const payerIndex = keys.indexOf(send.prepared!.expectedFeePayer); const payerDelta = payerIndex < 0 ? 0n : BigInt(chain.meta.postBalances[payerIndex]) - BigInt(chain.meta.preBalances[payerIndex]); const sponsor = BigInt(send.sponsoredCostLamports!); const status = tokenMatches && BigInt(chain.meta.fee) === BigInt(send.networkFeeLamports!) && payerDelta === -sponsor ? 'confirmed' : 'failed'; const result: ReconciliationResult = { transactionId, signature: confirmation.signature, status, networkFeeLamports: String(chain.meta.fee), reconciledAt: now }; await this.durable.updateTransaction(transactionId, { status: status === 'confirmed' ? 'reconciled' : 'failed', confirmedAt: status === 'confirmed' ? now : undefined, failedAt: status === 'failed' ? now : undefined, errorCode: status === 'failed' ? 'RECONCILIATION_FAILED' : undefined, errorStage: status === 'failed' ? 'send_economics' : undefined, updatedAt: now }); if (status === 'confirmed') { const record = await this.durable.getTransaction(transactionId); if (!record) throw new GaslessError('RECONCILIATION_FAILED', 'reconciliation', 'Send accounting record was not found.'); await this.durable.recordSendAccounting(record, String(chain.meta.fee)); await this.releaseSuccessfulExposure(quote); } return result; }
  private async releaseSuccessfulExposure(quote: TransactionQuote) { const send = quote.send; const prepared = send?.prepared; if (!this.risk || !send || !prepared) return; const id = prepared.transactionId; try { await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, reason: 'reconciled_success' }, `${id}:success_sponsorship_release_authorized`); const release = await this.risk.releaseQuoteExposure(quote); await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, result: release }, `${id}:success_sponsorship_released`); } catch { log('error', 'sponsorship_release_failed', { transactionId: id, quoteId: quote.quoteId, reason: 'reconciled_success' }); } }
  private async releaseTerminalExposure(quote: TransactionQuote, reason: string) { const send = quote.send; const prepared = send?.prepared; if (!this.risk || !send || !prepared) return; const id = prepared.transactionId; try { await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, reason }, `${id}:terminal_sponsorship_release_authorized`); const release = await this.risk.releaseQuoteExposure(quote); await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, result: release, reason }, `${id}:terminal_sponsorship_released`); } catch { log('error', 'sponsorship_release_failed', { transactionId: id, quoteId: quote.quoteId, reason }); } }
  private async failBeforeWallet(quote: TransactionQuote, error: GaslessError) { const send = quote.send; const prepared = send?.prepared; if (!send || !prepared) return; const id = prepared.transactionId; const now = new Date().toISOString(); try { if (this.risk) { await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, reason: 'pre_wallet_preparation_failure', userSignatureReturned: false, payerSignatureReturned: false, broadcastAttempted: false }, `${id}:pre_wallet_release_authorized`); const result = await this.risk.releaseQuoteExposure(quote); await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, result, reason: 'pre_wallet_preparation_failure' }, `${id}:pre_wallet_released`); } send.status = 'failed'; quote.status = 'failed'; await this.durable.updateTransaction(id, { status: 'failed', failedAt: now, errorCode: error.code, errorStage: error.stage, updatedAt: now }); await this.durable.updateIntentStatus(quote.intent.intentId, 'failed'); await this.durable.appendEvent(id, 'send_failed', error.stage, { code: error.code, reason: 'pre_wallet_preparation_failure', walletInvocationReached: false, payerSignatureReturned: false, broadcastAttempted: false }, `${id}:failed:pre_wallet_preparation`); await this.persistQuote(quote); } catch { log('error', 'send_pre_wallet_cleanup_failed', { transactionId: id, quoteId: quote.quoteId, code: error.code, stage: error.stage }); } }
  private async failAfterWallet(quote: TransactionQuote, code: string, userSignatureReturned: boolean, blockHeight: number) { const send = quote.send!; const prepared = send.prepared!; const id = prepared.transactionId; const now = new Date().toISOString(); if (this.risk) { await this.durable.appendEvent(id, 'sponsorship_release_authorized', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, reason: code, walletInvocationReached: true, userSignatureReturned, payerSignatureReturned: false, broadcastAttempted: false, blockHeight }, `${id}:wallet_failure_release_authorized`); const result = await this.risk.releaseQuoteExposure(quote); await this.durable.appendEvent(id, 'sponsorship_reservation_released', 'sponsorship_release', { quoteId: quote.quoteId, amountLamports: send.sponsoredCostLamports, reason: code, result }, `${id}:wallet_failure_released`); } send.status = 'failed'; quote.status = 'failed'; await this.durable.updateTransaction(id, { status: 'failed', failedAt: now, errorCode: code, errorStage: 'wallet_signing', updatedAt: now }); await this.durable.updateIntentStatus(quote.intent.intentId, 'failed'); await this.durable.appendEvent(id, 'send_failed', 'wallet_signing', { code, walletInvocationReached: true, userSignatureReturned, payerSignatureReturned: false, broadcastAttempted: false, blockHeight }, `${id}:failed:wallet_failure`); await this.persistQuote(quote); }
  private refreshRequired() { return new GaslessError('QUOTE_EXPIRED', 'send_pre_sign', 'Send costs refreshed. Review the updated amounts before continuing.'); }
  private async requireQuote(id: string, wallet: string, allowFinished = false, allowExpired = false) { const quote = await this.temporary.getQuote(id); if (!quote?.send) throw new GaslessError('QUOTE_NOT_FOUND', 'send_quote', 'This Send preview was not found.'); if (quote.intent.walletAddress !== wallet) throw new GaslessError('SESSION_ERROR', 'send_quote', 'This Send preview belongs to a different wallet.'); if (!allowExpired && Date.parse(quote.expiresAt) <= Date.now() && !['submitted', 'reconciled'].includes(quote.send.status)) throw new GaslessError('QUOTE_EXPIRED', 'send_quote', 'Your Send quote expired. Refresh the costs and review them again.'); if (!allowFinished && ['failed', 'reconciled'].includes(quote.status)) throw new GaslessError('QUOTE_ALREADY_USED', 'send_quote', 'This Send preview has already finished.'); return quote; }
  private async requireWalletQuote(id: string, wallet: string) { const quote = await this.requireQuote(id, wallet, false, true); if (!quote.send?.prepared) throw new GaslessError('INVALID_REQUEST', 'wallet_signing', 'The Send wallet attempt was not prepared.'); return quote; }
  private persistQuote(quote: TransactionQuote) { const ttl = ['submitted', 'reconciled'].includes(quote.status) ? 86_400 : quote.send?.prepared ? 300 : Math.max(1, Math.ceil((Date.parse(quote.expiresAt) - Date.now()) / 1000)); return this.temporary.saveQuote(quote, ttl); }
}
