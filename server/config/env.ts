import { GaslessError } from '../errors.js';
import { PublicKey } from '@solana/web3.js';
import { RECOVER_PRE_WALLET_MINIMUM_BLOCK_MARGIN } from '../../chains/solana/recover/validity.js';

export type ServerConfig = ReturnType<typeof loadServerConfig>;

function optional(name: string) { return process.env[name]?.trim() || undefined; }
function integer(name: string, fallback?: number) {
  const raw = optional(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value! < 0) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', `${name} must be a non-negative safe integer.`);
  return value!;
}
function json<T>(name: string, fallback: T): T {
  const value = optional(name);
  if (!value) return fallback;
  try { return JSON.parse(value) as T; }
  catch { throw new GaslessError('CONFIGURATION_ERROR', 'configuration', `${name} must contain valid JSON.`); }
}
function requireHttps(name: string, value: string | undefined) {
  try { if (!value || new URL(value).protocol !== 'https:') throw new Error(); }
  catch { throw new GaslessError('CONFIGURATION_ERROR', 'configuration', `${name} must be a valid HTTPS URL in private Mainnet.`); }
}

export function assertPrivateWalletRoles(pilotWallets: string[], settlementAddresses: Array<string | undefined>, payer?: string) {
  if (settlementAddresses.some((value) => !value) || new Set(settlementAddresses).size !== 1) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'Private Mainnet settlement destinations must use the single configured treasury wallet.');
  const treasury = settlementAddresses[0]!;
  if (pilotWallets.includes(treasury) || (payer && (payer === treasury || pilotWallets.includes(payer)))) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'Relayer, treasury, and pilot wallets must be distinct.');
}

export function assertExpectedKoraPayer(actual: string, expected: string | undefined) {
  if (!expected || actual !== expected) throw new GaslessError('CONFIGURATION_ERROR', 'kora_payer_identity', 'Kora returned an unexpected private-Mainnet payer.');
}

export function loadServerConfig() {
  const operatingMode = optional('GASLESS_OPERATING_MODE') ?? 'devnet';
  if (!['devnet', 'private-mainnet'].includes(operatingMode)) throw new GaslessError('UNSUPPORTED_NETWORK', 'configuration', 'GASLESS_OPERATING_MODE must be devnet or private-mainnet. Public Mainnet is not open.');
  const network = operatingMode === 'private-mainnet' ? 'mainnet-beta' as const : 'devnet' as const;
  const configuredNetwork = optional('GASLESS_NETWORK') ?? network;
  if (configuredNetwork !== network) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'GASLESS_NETWORK does not match GASLESS_OPERATING_MODE.');
  const rpcPrimaryUrl = optional('SOLANA_RPC_URL') ?? (network === 'devnet' && optional('HELIUS_API_KEY') ? `https://devnet.helius-rpc.com/?api-key=${optional('HELIUS_API_KEY')}` : undefined);
  if (operatingMode === 'private-mainnet') for (const [name, value] of [['SOLANA_RPC_URL', rpcPrimaryUrl], ['SOLANA_FALLBACK_RPC_URL', optional('SOLANA_FALLBACK_RPC_URL')], ['KORA_RPC_URL', optional('KORA_RPC_URL')], ['UPSTASH_REDIS_REST_URL', optional('UPSTASH_REDIS_REST_URL')], ['SUPABASE_URL', optional('SUPABASE_URL')], ['JUPITER_API_URL', optional('JUPITER_API_URL') ?? 'https://api.jup.ag/swap/v2'], ['JUPITER_PRICE_API_URL', optional('JUPITER_PRICE_API_URL') ?? 'https://api.jup.ag/price/v3']] as const) { if (name !== 'SOLANA_FALLBACK_RPC_URL' || value) requireHttps(name, value); }
  const pilotWalletAllowlist = (optional('PILOT_WALLET_ALLOWLIST') ?? '').split(',').map((wallet) => wallet.trim()).filter(Boolean);
  try { pilotWalletAllowlist.forEach((wallet) => new PublicKey(wallet)); } catch { throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'PILOT_WALLET_ALLOWLIST contains an invalid Solana address.'); }
  const koraExpectedPayer = optional('KORA_EXPECTED_PAYER');
  try { if (koraExpectedPayer) new PublicKey(koraExpectedPayer); } catch { throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'KORA_EXPECTED_PAYER must be a valid Solana address.'); }
  const recoverAuthorizationPublicKey = optional('RECOVER_AUTHORIZATION_PUBLIC_KEY');
  try { if (recoverAuthorizationPublicKey) new PublicKey(recoverAuthorizationPublicKey); } catch { throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'RECOVER_AUTHORIZATION_PUBLIC_KEY must be a valid Ed25519 public key.'); }
  const globalSponsorshipCapLamports = integer('GLOBAL_SPONSORSHIP_CAP_LAMPORTS', operatingMode === 'devnet' ? Number.MAX_SAFE_INTEGER : undefined);
  const walletSponsorshipCapLamports = integer('WALLET_SPONSORSHIP_CAP_LAMPORTS', operatingMode === 'devnet' ? Number.MAX_SAFE_INTEGER : undefined);
  const perTransactionSponsorshipCapLamports = integer('PER_TRANSACTION_SPONSORSHIP_CAP_LAMPORTS', operatingMode === 'devnet' ? Number.MAX_SAFE_INTEGER : undefined);
  const relayerLowBalanceThresholdLamports = integer('RELAYER_LOW_BALANCE_THRESHOLD_LAMPORTS', operatingMode === 'devnet' ? 100_000 : undefined);
  const relayerWarningBalanceThresholdLamports = integer('RELAYER_WARNING_BALANCE_THRESHOLD_LAMPORTS', relayerLowBalanceThresholdLamports);
  const sendPriceMaxAgeSeconds = integer('SEND_PRICE_MAX_AGE_SECONDS', 300);
  const swapPriceMaxAgeSeconds = integer('SWAP_PRICE_MAX_AGE_SECONDS', 300);
  if (operatingMode === 'private-mainnet' && (sendPriceMaxAgeSeconds < 1 || sendPriceMaxAgeSeconds > 300 || swapPriceMaxAgeSeconds < 1 || swapPriceMaxAgeSeconds > 300)) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'Private Mainnet price maximum age must be between 1 and 300 seconds.');
  if (relayerWarningBalanceThresholdLamports < relayerLowBalanceThresholdLamports) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'The relayer warning threshold must be at least the hard-pause threshold.');
  const settlementNames = ['CLAIM_FEE_DESTINATION', 'BURN_FEE_DESTINATION', 'RECOVER_FEE_DESTINATION', 'SEND_REIMBURSEMENT_WALLET', 'SEND_SERVICE_FEE_WALLET', 'SWAP_REIMBURSEMENT_WALLET', 'SWAP_SERVICE_FEE_WALLET'] as const;
  const settlementAddresses = settlementNames.map(optional);
  if (operatingMode === 'private-mainnet' && (!rpcPrimaryUrl || !pilotWalletAllowlist.length || !optional('UPSTASH_REDIS_REST_URL') || !optional('UPSTASH_REDIS_REST_TOKEN') || !optional('SUPABASE_URL') || !optional('SUPABASE_SERVICE_ROLE_KEY') || optional('RELAYER_PROVIDER') !== 'kora' || !optional('KORA_RPC_URL') || !optional('KORA_AUTH_TOKEN') || !koraExpectedPayer || !optional('RECOVER_AUTHORIZATION_SECRET_KEY') || !recoverAuthorizationPublicKey || !optional('JUPITER_API_KEY') || !optional('SENTRY_DSN') || settlementAddresses.some((value) => !value) || !optional('RECOVER_ALLOWED_MINTS') || !optional('SEND_TOKEN_REGISTRY_JSON') || optional('SEND_TOKEN_REGISTRY_JSON') === '[]' || !optional('SWAP_TOKEN_REGISTRY_JSON') || optional('SWAP_TOKEN_REGISTRY_JSON') === '[]' || !optional('SEND_MAXIMUM_SPONSORED_COST_LAMPORTS') || !optional('SWAP_MAXIMUM_SPONSORED_COST_LAMPORTS') || !optional('RECOVER_MAXIMUM_SPONSORED_COST_LAMPORTS') || !optional('MAXIMUM_SPONSORED_COST_LAMPORTS') || !optional('SWAP_MAXIMUM_PRICE_IMPACT_BPS') || !optional('RECOVER_MAX_PRICE_IMPACT_BPS'))) throw new GaslessError('CONFIGURATION_ERROR', 'configuration', 'Private Mainnet prerequisites are incomplete. RPC, allowlist, explicit limits, token policy, settlement destinations, Redis, Supabase, Jupiter pricing, Sentry, Recover authorization, and authenticated Kora are required.');
  if (operatingMode === 'private-mainnet') assertPrivateWalletRoles(pilotWalletAllowlist, settlementAddresses);
  return {
    operatingMode: operatingMode as 'devnet' | 'private-mainnet',
    network,
    port: Number(optional('GASLESS_API_PORT') ?? 8787),
    quoteTtlSeconds: Number(optional('GASLESS_QUOTE_TTL_SECONDS') ?? 120),
    sessionTtlSeconds: Number(optional('GASLESS_SESSION_TTL_SECONDS') ?? 900),
    rpcPrimaryUrl,
    rpcFallbackUrl: optional('SOLANA_FALLBACK_RPC_URL'),
    redisUrl: optional('UPSTASH_REDIS_REST_URL'),
    redisToken: optional('UPSTASH_REDIS_REST_TOKEN'),
    supabaseUrl: optional('SUPABASE_URL'),
    supabaseServiceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
    relayerProvider: optional('RELAYER_PROVIDER') ?? 'local-devnet',
    relayerSecretKey: optional('RELAYER_SECRET_KEY'),
    relayerKeypairPath: optional('RELAYER_KEYPAIR_PATH'),
    claimFeeDestination: optional('CLAIM_FEE_DESTINATION'),
    claimServiceFeeBps: Number(optional('CLAIM_SERVICE_FEE_BPS') ?? 300),
    claimMinimumUserPayoutLamports: Number(optional('CLAIM_MINIMUM_USER_PAYOUT_LAMPORTS') ?? 1_000_000),
    claimMaxAccountsPerBatch: Number(optional('CLAIM_MAX_ACCOUNTS_PER_BATCH') ?? 10),
    burnFeeDestination: optional('BURN_FEE_DESTINATION') ?? optional('CLAIM_FEE_DESTINATION'),
    burnServiceFeeBps: Number(optional('BURN_SERVICE_FEE_BPS') ?? 300),
    burnMinimumUserPayoutLamports: Number(optional('BURN_MINIMUM_USER_PAYOUT_LAMPORTS') ?? 1_000_000),
    recoverFeeDestination: optional('RECOVER_FEE_DESTINATION') ?? optional('CLAIM_FEE_DESTINATION'),
    recoverSwapFeeBps: Number(optional('RECOVER_SWAP_FEE_BPS') ?? 30),
    recoverRentFeeBps: Number(optional('RECOVER_RENT_FEE_BPS') ?? 300),
    recoverSlippageBps: Number(optional('RECOVER_SLIPPAGE_BPS') ?? 50),
    recoverMaxPriceImpactBps: optional('RECOVER_MAX_PRICE_IMPACT_BPS') === undefined ? Number.NaN : Number(optional('RECOVER_MAX_PRICE_IMPACT_BPS')),
    recoverMinimumUserPayoutLamports: Number(optional('RECOVER_MINIMUM_USER_PAYOUT_LAMPORTS') ?? 1_000_000),
    recoverMaximumSponsoredCostLamports: optional('RECOVER_MAXIMUM_SPONSORED_COST_LAMPORTS') === undefined ? Number.NaN : Number(optional('RECOVER_MAXIMUM_SPONSORED_COST_LAMPORTS')),
    recoverBlockhashSlotsToExpiry: integer('RECOVER_BLOCKHASH_SLOTS_TO_EXPIRY', 150),
    recoverPreWalletMinimumBlockMargin: integer('RECOVER_PRE_WALLET_MINIMUM_BLOCK_MARGIN', RECOVER_PRE_WALLET_MINIMUM_BLOCK_MARGIN),
    recoverAllowedMints: (optional('RECOVER_ALLOWED_MINTS') ?? '').split(',').map((mint) => mint.trim()).filter(Boolean),
    recoverAuthorizationSecretKey: optional('RECOVER_AUTHORIZATION_SECRET_KEY'),
    recoverAuthorizationPublicKey,
    sendTokens: json<Array<{ mint: string; symbol: string; decimals: number; tokenProgram: string; extensions?: string[]; usdPriceMicros?: string; solUsdPriceMicros?: string; priceUpdatedAt?: string; reimbursementBufferBps?: number }>>('SEND_TOKEN_REGISTRY_JSON', []).map((token) => ({ ...token, extensions: token.extensions ?? [], status: 'supported' as const, enabledActions: ['SEND' as const], feePaymentEnabled: true })),
    swapTokens: json<Array<{ mint: string; symbol: string; decimals: number; tokenProgram: string; extensions?: string[]; usdPriceMicros?: string; solUsdPriceMicros?: string; priceUpdatedAt?: string; reimbursementBufferBps?: number; swapInputEnabled: boolean; swapOutputEnabled: boolean }>>('SWAP_TOKEN_REGISTRY_JSON', []).map((token) => ({ ...token, extensions: token.extensions ?? [], status: 'supported' as const, enabledActions: ['SWAP' as const], feePaymentEnabled: token.swapInputEnabled })),
    sendReimbursementWallet: optional('SEND_REIMBURSEMENT_WALLET'),
    sendServiceFeeWallet: optional('SEND_SERVICE_FEE_WALLET'),
    sendServiceFeeBps: Number(optional('SEND_SERVICE_FEE_BPS') ?? 10),
    sendServiceFeeCapUsdMicros: Number(optional('SEND_SERVICE_FEE_CAP_USD_MICROS') ?? 1_000_000),
    sendPriceMaxAgeSeconds,
    sendMaximumSponsoredCostLamports: Number(optional('SEND_MAXIMUM_SPONSORED_COST_LAMPORTS') ?? 3_000_000),
    swapReimbursementWallet: optional('SWAP_REIMBURSEMENT_WALLET'),
    swapServiceFeeWallet: optional('SWAP_SERVICE_FEE_WALLET'),
    swapServiceFeeBps: Number(optional('SWAP_SERVICE_FEE_BPS') ?? 30),
    swapDefaultSlippageBps: Number(optional('SWAP_DEFAULT_SLIPPAGE_BPS') ?? 50),
    swapMaximumSlippageBps: Number(optional('SWAP_MAXIMUM_SLIPPAGE_BPS') ?? 100),
    swapMaximumPriceImpactBps: optional('SWAP_MAXIMUM_PRICE_IMPACT_BPS') === undefined ? Number.NaN : Number(optional('SWAP_MAXIMUM_PRICE_IMPACT_BPS')),
    swapPriceMaxAgeSeconds,
    swapMaximumSponsoredCostLamports: optional('SWAP_MAXIMUM_SPONSORED_COST_LAMPORTS') === undefined ? Number.NaN : Number(optional('SWAP_MAXIMUM_SPONSORED_COST_LAMPORTS')),
    jupiterApiUrl: optional('JUPITER_API_URL') ?? 'https://api.jup.ag/swap/v2',
    jupiterPriceApiUrl: optional('JUPITER_PRICE_API_URL') ?? 'https://api.jup.ag/price/v3',
    jupiterApiKey: optional('JUPITER_API_KEY'),
    maximumSponsoredCostLamports: Number(optional('MAXIMUM_SPONSORED_COST_LAMPORTS') ?? 20_000),
    relayerLowBalanceThresholdLamports,
    relayerWarningBalanceThresholdLamports,
    pilotWalletAllowlist,
    globalSponsorshipCapLamports,
    walletSponsorshipCapLamports,
    perTransactionSponsorshipCapLamports,
    sponsorshipWindowSeconds: integer('SPONSORSHIP_WINDOW_SECONDS', 86_400),
    routeRateLimit: integer('ROUTE_RATE_LIMIT', 30),
    routeRateWindowSeconds: integer('ROUTE_RATE_WINDOW_SECONDS', 60),
    tokenPausePolicy: json<Array<{ mint: string; actions: Array<'SEND' | 'SWAP_INPUT' | 'SWAP_OUTPUT' | 'CLEAN_RECOVER'> }>>('TOKEN_PAUSE_POLICY_JSON', []),
    sentryDsn: optional('SENTRY_DSN'),
    koraRpcUrl: optional('KORA_RPC_URL'),
    koraAuthToken: optional('KORA_AUTH_TOKEN'),
    koraExpectedPayer,
    publicStatsEnabled: optional('PUBLIC_STATS_ENABLED') === 'true',
    allowMemoryStores: optional('GASLESS_ALLOW_MEMORY_STORES') === 'true' || process.env.NODE_ENV === 'test',
  };
}
