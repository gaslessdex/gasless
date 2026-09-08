import { PublicKey } from '@solana/web3.js';
import type { SolanaNetwork, TransactionAction, TransactionQuote } from '../../shared/transactions/types.js';
import type { ServerConfig } from '../config/env.js';
import type { EmergencyControlService } from '../controls/service.js';
import { GaslessError } from '../errors.js';
import type { RelayerProvider } from '../relayer/provider.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { TemporaryStore } from '../storage/temporary.js';

export type RequestStage = 'session' | 'discover' | 'quote' | 'prepare' | 'pre-wallet' | 'submit' | 'status' | 'build';

export class OperationalRiskService {
  private readonly allowedWallets: Set<string>;

  constructor(
    private readonly config: ServerConfig,
    private readonly temporary: TemporaryStore,
    private readonly rpc: SolanaRpc,
    private readonly relayer: RelayerProvider,
    private readonly controls: EmergencyControlService,
  ) {
    this.allowedWallets = new Set(config.pilotWalletAllowlist.map((wallet) => new PublicKey(wallet).toBase58()));
  }

  assertWalletAllowed(walletAddress: string, network: SolanaNetwork) {
    if (network === 'mainnet-beta' && this.config.operatingMode !== 'public-mainnet' && (this.config.operatingMode !== 'private-mainnet' || !this.allowedWallets.has(walletAddress))) {
      throw new GaslessError('WALLET_NOT_ALLOWED', 'private_mainnet_allowlist', 'This wallet is connected, but GASLESS Private Beta access is not enabled for it.');
    }
  }

  async enforceRequest(action: TransactionAction | 'SESSION', stage: RequestStage, walletAddress: string, network: SolanaNetwork, clientAddress: string) {
    this.assertWalletAllowed(walletAddress, network);
    if (action === 'DEVNET_PROOF' && network !== 'devnet') throw new GaslessError('UNSUPPORTED_NETWORK', 'devnet_proof', 'The developer proof route is available on Devnet only.');
    const readOnly = stage === 'discover' || (action === 'SWAP' && stage === 'quote') || (action === 'CROSS_CHAIN' && (stage === 'quote' || stage === 'status'));
    if (action !== 'SESSION' && !readOnly) await this.controls.assertExecutionAllowed(action, network);
    const route = `${action}:${stage}`;
    const keys = [`route:${route}:ip:${clientAddress}`, `route:${route}:wallet:${walletAddress}`];
    for (const key of keys) if (!await this.temporary.consumeRateLimit(key, this.config.routeRateLimit, this.config.routeRateWindowSeconds)) throw new GaslessError('RATE_LIMITED', 'rate_limit', 'Too many requests. Please wait a moment and try again.', true);
    if (network === 'mainnet-beta' && ['quote', 'prepare', 'pre-wallet'].includes(stage)) await this.assertRelayerHealthy();
  }

  async assertRelayerHealthy() {
    let balance: number;
    try { balance = await this.rpc.getBalance(await this.relayer.getFeePayerPublicKey()); }
    catch (error) { throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_health', 'GASLESS is temporarily unable to cover network costs.', true, undefined, { cause: error }); }
    if (balance < this.config.relayerLowBalanceThresholdLamports) throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_health', 'GASLESS is temporarily unable to cover network costs.', true);
    return balance < this.config.relayerWarningBalanceThresholdLamports ? 'warning' as const : 'healthy' as const;
  }

  async assertRelayerCanSponsor(amountLamports: number) {
    if (!Number.isSafeInteger(amountLamports) || amountLamports < 0) throw new GaslessError('CONFIGURATION_ERROR', 'relayer_health', 'The sponsored cost could not be safely determined.');
    let balance: number;
    try { balance = await this.rpc.getBalance(await this.relayer.getFeePayerPublicKey()); }
    catch (error) { throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_health', 'GASLESS is temporarily unable to cover network costs.', true, undefined, { cause: error }); }
    if (balance < amountLamports + this.config.relayerLowBalanceThresholdLamports) throw new GaslessError('RELAYER_INSUFFICIENT_FUNDS', 'relayer_health', 'GASLESS is temporarily unable to cover network costs.', true);
    return balance < amountLamports + this.config.relayerWarningBalanceThresholdLamports ? 'warning' as const : 'healthy' as const;
  }

  async reserveQuoteExposure(quote: TransactionQuote) {
    return this.reserveTransactionExposure({ network: quote.intent.network, walletAddress: quote.intent.walletAddress, action: quote.intent.actionType, transactionId: quote.quoteId, amountLamports: sponsorshipCost(quote) });
  }

  async reserveTransactionExposure(input: { network: SolanaNetwork; walletAddress: string; action: TransactionAction; transactionId: string; amountLamports: number }) {
    const amount = input.amountLamports;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new GaslessError('CONFIGURATION_ERROR', 'sponsorship_policy', 'The sponsored cost could not be safely determined.');
    if (amount > this.config.perTransactionSponsorshipCapLamports) throw limitError();
    const allowed = await this.temporary.reserveSponsorshipExposure(
      [`global:${input.network}`, `wallet:${input.network}:${input.walletAddress}`, `action:${input.network}:${input.action}:${input.walletAddress}`],
      amount,
      [this.config.globalSponsorshipCapLamports, this.config.walletSponsorshipCapLamports, this.config.walletSponsorshipCapLamports],
      this.config.sponsorshipWindowSeconds,
      input.transactionId,
    );
    if (!allowed) throw limitError();
  }

  async releaseQuoteExposure(quote: TransactionQuote) {
    return this.releaseTransactionExposure({ network: quote.intent.network, walletAddress: quote.intent.walletAddress, action: quote.intent.actionType, transactionId: quote.quoteId, amountLamports: sponsorshipCost(quote) });
  }

  async releaseTransactionExposure(input: { network: SolanaNetwork; walletAddress: string; action: TransactionAction; transactionId: string; amountLamports: number }) {
    return this.temporary.releaseSponsorshipExposure(
      [`global:${input.network}`, `wallet:${input.network}:${input.walletAddress}`, `action:${input.network}:${input.action}:${input.walletAddress}`],
      input.amountLamports,
      input.transactionId,
    );
  }
}

function sponsorshipCost(quote: TransactionQuote) {
  const raw = quote.claim?.sponsoredCostLamports ?? quote.burn?.sponsoredCostLamports ?? quote.recover?.sponsoredCostLamports ?? quote.send?.sponsoredCostLamports ?? quote.swap?.sponsoredCostLamports;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new GaslessError('CONFIGURATION_ERROR', 'sponsorship_policy', 'The sponsored cost could not be safely determined.');
  return value;
}

function limitError() { return new GaslessError('SPONSOR_LIMIT_EXCEEDED', 'sponsorship_policy', 'Sponsored transactions are temporarily unavailable. Please try again later.', true); }
