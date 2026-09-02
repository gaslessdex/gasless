import { EmergencyControlService } from './controls/service.js';
import type { ServerConfig } from './config/env.js';
import { GaslessError } from './errors.js';
import { KoraRelayerProvider, LocalDevnetRelayerProvider, type RelayerProvider } from './relayer/provider.js';
import { SessionService } from './session/service.js';
import { SolanaRpc } from './solana/rpc.js';
import { MemoryDurableStore, SupabaseDurableStore, type DurableStore } from './storage/durable.js';
import { MemoryTemporaryStore, UpstashTemporaryStore, type TemporaryStore } from './storage/temporary.js';
import { ServerTokenRegistry } from './token-registry/service.js';
import { TransactionEngine } from './transactions/engine.js';
import { ClaimEngine } from './claim/engine.js';
import { BurnEngine } from './burn/engine.js';
import { RecoverEngine } from './recover/engine.js';
import { RecoverAuthorizationSigner } from './recover/authorization.js';
import { JupiterService } from './jupiter/service.js';
import { SendEngine } from './send/engine.js';
import { SwapEngine } from './swap/engine.js';
import { OperationalRiskService } from './risk/operational.js';
import { JupiterPriceProvider, RegistryPriceProvider } from './pricing/service.js';
import { SupabaseDynamicTokenStore } from './token-registry/dynamic.js';

export function createServices(config: ServerConfig) {
  if (!config.rpcPrimaryUrl) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'A Solana RPC endpoint is required.');
  let temporary: TemporaryStore;
  if (config.redisUrl && config.redisToken) temporary = new UpstashTemporaryStore(config.redisUrl, config.redisToken);
  else if (config.allowMemoryStores) temporary = new MemoryTemporaryStore();
  else throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'Redis is required for quote and replay protection.');

  let durable: DurableStore;
  if (config.supabaseUrl && config.supabaseServiceRoleKey) durable = new SupabaseDurableStore(config.supabaseUrl, config.supabaseServiceRoleKey);
  else if (config.allowMemoryStores) durable = new MemoryDurableStore();
  else throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'Supabase is required for durable transaction records.');

  let relayer: RelayerProvider;
  if (config.relayerProvider === 'local-devnet') relayer = new LocalDevnetRelayerProvider(config.relayerSecretKey, config.relayerKeypairPath);
  else if (config.relayerProvider === 'kora') relayer = new KoraRelayerProvider(config.koraRpcUrl, config.koraAuthToken);
  else throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'The configured relayer provider is unsupported.');

  const rpc = new SolanaRpc(config.rpcPrimaryUrl, config.rpcFallbackUrl, config.network);
  const controls = new EmergencyControlService(durable);
  const dynamicTokens = config.supabaseUrl && config.supabaseServiceRoleKey ? new SupabaseDynamicTokenStore(config.supabaseUrl, config.supabaseServiceRoleKey) : undefined;
  const registry = new ServerTokenRegistry(config.recoverAllowedMints, config.sendTokens, config.swapTokens, config.tokenPausePolicy, dynamicTokens, config.network);
  const priceProvider = config.operatingMode === 'private-mainnet'
    ? new JupiterPriceProvider(config.jupiterPriceApiUrl, config.jupiterApiKey, rpc, Math.min(config.sendPriceMaxAgeSeconds, config.swapPriceMaxAgeSeconds))
    : new RegistryPriceProvider([...config.sendTokens, ...config.swapTokens, { mint: 'So11111111111111111111111111111111111111112', usdPriceMicros: config.sendTokens[0]?.solUsdPriceMicros ?? config.swapTokens.find((token) => token.solUsdPriceMicros)?.solUsdPriceMicros, priceUpdatedAt: config.sendTokens[0]?.priceUpdatedAt ?? config.swapTokens.find((token) => token.priceUpdatedAt)?.priceUpdatedAt }]);
  const risk = new OperationalRiskService(config, temporary, rpc, relayer, controls);
  const claim = new ClaimEngine(temporary, durable, rpc, relayer, controls, config.quoteTtlSeconds, {
    feeDestination: config.claimFeeDestination,
    feeBps: config.claimServiceFeeBps,
    minimumUserPayoutLamports: config.claimMinimumUserPayoutLamports,
    maximumAccountsPerBatch: config.claimMaxAccountsPerBatch,
    maximumNetworkFeeLamports: config.maximumSponsoredCostLamports,
    relayerLowBalanceThresholdLamports: config.relayerLowBalanceThresholdLamports,
  }, risk);
  const burn = new BurnEngine(temporary, durable, rpc, relayer, controls, config.quoteTtlSeconds, { feeDestination: config.burnFeeDestination, feeBps: config.burnServiceFeeBps, minimumUserPayoutLamports: config.burnMinimumUserPayoutLamports, maximumNetworkFeeLamports: config.maximumSponsoredCostLamports, relayerLowBalanceThresholdLamports: config.relayerLowBalanceThresholdLamports, recoverAllowedMints: config.recoverAllowedMints }, risk);
  const recoverAuthorizationSigner = config.recoverAuthorizationSecretKey ? new RecoverAuthorizationSigner(config.recoverAuthorizationSecretKey) : undefined;
  if (config.operatingMode === 'private-mainnet' && recoverAuthorizationSigner?.publicKey !== config.recoverAuthorizationPublicKey) throw new GaslessError('CONFIGURATION_ERROR', 'recover_authorization', 'The Recover authorization signing key does not match the configured verification key.');
  if (recoverAuthorizationSigner && [...config.pilotWalletAllowlist, config.recoverFeeDestination, config.koraExpectedPayer].includes(recoverAuthorizationSigner.publicKey)) throw new GaslessError('CONFIGURATION_ERROR', 'recover_authorization', 'The Recover authorization key must be separate from pilot, treasury, and Kora payer roles.');
  const recover = new RecoverEngine(temporary, durable, rpc, relayer, controls, registry, new JupiterService(config.jupiterApiUrl, config.jupiterApiKey), config.quoteTtlSeconds, { feeDestination: config.recoverFeeDestination, swapFeeBps: config.recoverSwapFeeBps, rentFeeBps: config.recoverRentFeeBps, slippageBps: config.recoverSlippageBps, maxPriceImpactBps: config.recoverMaxPriceImpactBps, minimumUserPayoutLamports: config.recoverMinimumUserPayoutLamports, maximumNetworkFeeLamports: config.maximumSponsoredCostLamports, maximumSponsoredCostLamports: config.recoverMaximumSponsoredCostLamports, relayerLowBalanceThresholdLamports: config.relayerLowBalanceThresholdLamports, blockhashSlotsToExpiry: config.recoverBlockhashSlotsToExpiry, preWalletMinimumBlockMargin: config.recoverPreWalletMinimumBlockMargin, attemptTtlSeconds: config.sponsorshipWindowSeconds }, risk, recoverAuthorizationSigner);
  const send = new SendEngine(temporary, durable, rpc, relayer, controls, registry, config.quoteTtlSeconds, { reimbursementWallet: config.sendReimbursementWallet, serviceFeeWallet: config.sendServiceFeeWallet, serviceFeeBps: config.sendServiceFeeBps, serviceFeeCapUsdMicros: config.sendServiceFeeCapUsdMicros, priceMaxAgeSeconds: config.sendPriceMaxAgeSeconds, maximumSponsoredCostLamports: config.sendMaximumSponsoredCostLamports, relayerLowBalanceThresholdLamports: config.relayerLowBalanceThresholdLamports }, priceProvider, risk);
  const swap = new SwapEngine(temporary, durable, rpc, relayer, controls, registry, new JupiterService(config.jupiterApiUrl, config.jupiterApiKey), config.quoteTtlSeconds, { reimbursementWallet: config.swapReimbursementWallet, serviceFeeWallet: config.swapServiceFeeWallet, serviceFeeBps: config.swapServiceFeeBps, defaultSlippageBps: config.swapDefaultSlippageBps, maximumSlippageBps: config.swapMaximumSlippageBps, maximumPriceImpactBps: config.swapMaximumPriceImpactBps, priceMaxAgeSeconds: config.swapPriceMaxAgeSeconds, maximumSponsoredCostLamports: config.swapMaximumSponsoredCostLamports, relayerLowBalanceThresholdLamports: config.relayerLowBalanceThresholdLamports }, priceProvider, risk);
  return { session: new SessionService(temporary, config.sessionTtlSeconds, config.network), engine: new TransactionEngine(temporary, durable, rpc, relayer, controls, registry, config.quoteTtlSeconds), claim, recover, burn, send, swap, risk, durable, temporary, rpc, relayer, registry, dynamicTokens };
}
