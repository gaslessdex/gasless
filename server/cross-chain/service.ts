import { PublicKey } from '@solana/web3.js';
import { assertRelaySimulation, validateRelayTransaction } from '../../chains/solana/relay/validator.js';
import type { CrossChainPreparedTransaction, CrossChainQuote, CrossChainStatus, CrossChainSubmissionResult } from '../../shared/cross-chain/types.js';
import { GaslessError } from '../errors.js';
import type { RelayerProvider } from '../relayer/provider.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { TemporaryStore } from '../storage/temporary.js';
import { RelayClient, type RelayQuoteResponse } from '../relay/client.js';
import type { CrossChainSponsorshipLifecycle } from './lifecycle.js';
import { CROSS_CHAIN_INPUTS, CROSS_CHAIN_OUTPUTS, ROBINHOOD_CHAIN_ID, SOLANA_RELAY_CHAIN_ID, inputAsset, normalizeRelayStatus, outputAsset, parseCrossChainAmount } from './registry.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type CrossChainPolicy = {
  enabled: boolean;
  publicExecution: boolean;
  executionWallets: string[];
  appFeeRecipient?: string;
  appFeeBps: number;
  quoteTtlSeconds: number;
  maximumInputUsd?: number;
  maximumSponsoredCostLamports: number;
};

export class CrossChainService {
  private readonly executionWallets: Set<string>;

  constructor(
    private readonly temporary: TemporaryStore,
    private readonly relay: RelayClient,
    private readonly relayer: RelayerProvider,
    private readonly rpc: SolanaRpc,
    private readonly lifecycle: CrossChainSponsorshipLifecycle,
    private readonly policy: CrossChainPolicy,
  ) { this.executionWallets = new Set(policy.executionWallets); }

  async createQuote(input: { walletAddress: string; recipient: string; inputAsset: unknown; outputAsset: unknown; amount: string }) {
    if (!this.policy.enabled) throw new GaslessError('ACTION_DISABLED', 'cross_chain', 'Cross-chain transfers are temporarily paused.');
    let walletAddress: string;
    try { walletAddress = new PublicKey(input.walletAddress).toBase58(); } catch { throw new GaslessError('INVALID_REQUEST', 'cross_chain_wallet', 'Connect a valid Solana wallet.'); }
    if (!EVM_ADDRESS.test(input.recipient)) throw new GaslessError('INVALID_REQUEST', 'cross_chain_recipient', 'Enter a valid 0x wallet address.');
    const source = inputAsset(input.inputAsset); const destination = outputAsset(input.outputAsset);
    const sourceToken = CROSS_CHAIN_INPUTS[source]; const destinationToken = CROSS_CHAIN_OUTPUTS[destination];
    const amount = parseCrossChainAmount(input.amount, sourceToken.decimals);
    if (!Number.isInteger(this.policy.appFeeBps) || this.policy.appFeeBps < 0 || this.policy.appFeeBps > 10_000) throw new GaslessError('CONFIGURATION_ERROR', 'cross_chain_fee', 'Cross-chain fee configuration is invalid.');
    if (this.policy.appFeeBps > 0 && !this.policy.appFeeRecipient) throw new GaslessError('CONFIGURATION_ERROR', 'cross_chain_fee', 'The cross-chain fee recipient is not configured.');
    if (this.policy.appFeeRecipient && !EVM_ADDRESS.test(this.policy.appFeeRecipient)) throw new GaslessError('CONFIGURATION_ERROR', 'cross_chain_fee', 'The cross-chain fee recipient is invalid.');
    const payer = await this.relayer.getFeePayerPublicKey();
    if (payer === walletAddress) throw new GaslessError('INVALID_REQUEST', 'cross_chain_sponsor', 'This wallet cannot use the configured GASLESS sponsor.');
    const provider = await this.relay.quote({ user: walletAddress, recipient: input.recipient, originChainId: SOLANA_RELAY_CHAIN_ID, destinationChainId: ROBINHOOD_CHAIN_ID, originCurrency: sourceToken.address, destinationCurrency: destinationToken.address, amount, tradeType: 'EXACT_INPUT', depositFeePayer: payer, ttl: this.policy.quoteTtlSeconds, ...(this.policy.appFeeBps > 0 ? { appFees: [{ recipient: this.policy.appFeeRecipient, fee: String(this.policy.appFeeBps) }] } : {}) });
    validateProviderQuote(provider, { walletAddress, recipient: input.recipient, sourceAddress: sourceToken.address, destinationAddress: destinationToken.address, amount });
    const providerRequestId = provider.requestId ?? provider.steps?.find((step) => step.requestId)?.requestId;
    if (!providerRequestId) throw new GaslessError('RELAY_UNAVAILABLE', 'relay_quote', 'Relay returned an incomplete quote. Try again shortly.', true);
    const comparableUsd = Number(provider.details?.currencyIn?.amountUsd);
    if (this.policy.maximumInputUsd !== undefined && Number.isFinite(comparableUsd) && comparableUsd > this.policy.maximumInputUsd) throw new GaslessError('INVALID_REQUEST', 'cross_chain_amount', 'This amount is above the current cross-chain limit.');
    const out = provider.details!.currencyOut!; const app = cost(provider.fees?.app, source); const route = cost(provider.fees?.relayer, source);
    const providerDeadline = provider.protocol?.v2?.orderData?.output.deadline;
    const expiresAtMs = Math.min(Date.now() + this.policy.quoteTtlSeconds * 1000, Number.isSafeInteger(providerDeadline) ? providerDeadline! * 1000 : Number.MAX_SAFE_INTEGER);
    const quote: CrossChainQuote = { quoteId: crypto.randomUUID(), provider: 'Relay', sourceNetwork: 'solana', destinationNetwork: 'robinhood', inputAsset: source, outputAsset: destination, inputAmount: provider.details!.currencyIn!.amountFormatted!, estimatedOutput: out.amountFormatted!, minimumOutput: formatRaw(out.minimumAmount, destinationToken.decimals), routeCost: route, appFee: app ?? { amount: '0', amountUsd: '0', symbol: source }, estimatedDurationSeconds: safeDuration(provider.details?.timeEstimate), expiresAt: new Date(expiresAtMs).toISOString(), recipient: input.recipient.toLowerCase(), executionReady: this.policy.publicExecution || this.executionWallets.has(walletAddress) };
    await this.temporary.saveCrossChainQuote({ quote, walletAddress, providerRequestId, inputAmountRaw: amount, providerQuote: provider }, this.policy.quoteTtlSeconds);
    return quote;
  }

  async prepare(quoteId: string, walletAddress: string): Promise<CrossChainPreparedTransaction> {
    this.assertExecutionWallet(walletAddress);
    const stored = await this.requireQuote(quoteId, walletAddress);
    if (!stored.providerQuote) throw new GaslessError('QUOTE_EXPIRED', 'cross_chain_prepare', 'Request a fresh cross-chain quote before signing.');
    const payer = await this.relayer.getFeePayerPublicKey();
    const source = CROSS_CHAIN_INPUTS[stored.quote.inputAsset]; const destination = CROSS_CHAIN_OUTPUTS[stored.quote.outputAsset];
    const validated = await validateRelayTransaction(stored.providerQuote, {
      wallet: walletAddress, quoteId, relayRequestId: stored.providerRequestId,
      inputAsset: stored.quote.inputAsset, inputMint: source.address, inputAmountRaw: stored.inputAmountRaw,
      destinationAsset: stored.quote.outputAsset, destinationMint: destination.address, recipient: stored.quote.recipient,
      depositFeePayer: payer, expiresAt: stored.quote.expiresAt, maximumSponsoredCostLamports: this.policy.maximumSponsoredCostLamports,
    }, this.rpc);
    const simulation = await this.rpc.simulateTransaction(validated.serializedTransaction, false);
    assertRelaySimulation(simulation, validated);
    const prepared = await this.lifecycle.prepareSignOnly(validated);
    return { transactionId: prepared.transactionId, quoteId, serializedTransaction: prepared.sponsorSignedTransaction, messageHash: validated.messageHash, expectedFeePayer: payer, recentBlockhash: validated.recentBlockhash, lastValidBlockHeight: validated.lastValidBlockHeight, expiresAt: validated.expiresAt };
  }

  async submit(transactionId: string, walletAddress: string, signedTransaction: string): Promise<CrossChainSubmissionResult> {
    this.assertExecutionWallet(walletAddress);
    return this.lifecycle.submitSigned({ transactionId, walletAddress, signedTransaction, rpc: this.rpc });
  }

  async status(quoteId: string, walletAddress: string): Promise<{ quoteId: string; status: CrossChainStatus }> {
    const stored = await this.requireQuote(quoteId, walletAddress);
    const result = await this.relay.status(stored.providerRequestId);
    assertStatusRoute(result);
    return { quoteId, status: normalizeRelayStatus(result.status) };
  }

  async transactionStatus(transactionId: string, walletAddress: string) {
    this.assertExecutionWallet(walletAddress);
    return this.lifecycle.reconcile(transactionId, walletAddress);
  }

  private assertExecutionWallet(walletAddress: string) {
    let normalized: string;
    try { normalized = new PublicKey(walletAddress).toBase58(); } catch { throw new GaslessError('ACTION_DISABLED', 'cross_chain_execution', 'Cross-chain execution is unavailable.'); }
    if (!this.policy.publicExecution && !this.executionWallets.has(normalized)) throw new GaslessError('ACTION_DISABLED', 'cross_chain_execution', 'Cross-chain execution is unavailable for this wallet.');
  }

  private async requireQuote(quoteId: string, walletAddress: string) {
    const stored = await this.temporary.getCrossChainQuote(quoteId);
    if (!stored || stored.walletAddress !== walletAddress || Date.parse(stored.quote.expiresAt) <= Date.now()) throw new GaslessError('QUOTE_EXPIRED', 'cross_chain_status', 'That cross-chain quote expired. Request a fresh quote.');
    return stored;
  }
}

function validateProviderQuote(value: RelayQuoteResponse, expected: { walletAddress: string; recipient: string; sourceAddress: string; destinationAddress: string; amount: string }) {
  const input = value.details?.currencyIn; const output = value.details?.currencyOut;
  if (!input || !output || input.currency?.chainId !== SOLANA_RELAY_CHAIN_ID || output.currency?.chainId !== ROBINHOOD_CHAIN_ID || input.currency.address !== expected.sourceAddress || output.currency.address?.toLowerCase() !== expected.destinationAddress.toLowerCase() || input.amount !== expected.amount || value.details?.sender !== expected.walletAddress || value.details?.recipient?.toLowerCase() !== expected.recipient.toLowerCase() || !input.amountFormatted || !output.amountFormatted) throw new GaslessError('RELAY_UNAVAILABLE', 'relay_quote_validation', 'Relay returned an unexpected quote. Try again shortly.');
  const deposit = value.steps?.find((step) => step.kind === 'transaction' && step.requestId);
  if (!deposit?.items?.length || !deposit.items.every((item) => Array.isArray(item.data?.instructions))) throw new GaslessError('RELAY_UNAVAILABLE', 'relay_quote_validation', 'Relay returned an unsupported Solana quote format.');
}

function assertStatusRoute(result: { originChainId?: number; destinationChainId?: number }) {
  if (result.originChainId !== undefined && result.originChainId !== SOLANA_RELAY_CHAIN_ID || result.destinationChainId !== undefined && result.destinationChainId !== ROBINHOOD_CHAIN_ID) throw new GaslessError('RELAY_UNAVAILABLE', 'relay_status', 'Relay returned an unexpected route status.');
}

function cost(value: { amount?: string; amountFormatted?: string; amountUsd?: string; currency?: { symbol?: string } } | undefined, fallback: string) { if (!value) return undefined; return { amount: value.amountFormatted ?? value.amount ?? '0', amountUsd: value.amountUsd ?? '0', symbol: value.currency?.symbol ?? fallback }; }
function formatRaw(raw: string | undefined, decimals: number) { if (!raw) return undefined; const padded = raw.padStart(decimals + 1, '0'); const whole = padded.slice(0, -decimals); const fraction = padded.slice(-decimals).replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''}`; }
function safeDuration(value: number | undefined) { return Number.isFinite(value) && value! >= 0 ? value : undefined; }
