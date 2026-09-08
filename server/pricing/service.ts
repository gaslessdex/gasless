import { GaslessError } from '../errors.js';
import type { SolanaRpc } from '../solana/rpc.js';
import { effectiveRawTokenUsdPriceMicros } from '../../chains/solana/token-2022/accounts.js';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface AuthoritativePrice { usdPriceMicros: string; observedAt: string }
export interface PriceProvider {
  getUsdPrices(mints: string[]): Promise<Record<string, AuthoritativePrice>>;
  assertExecutablePriceConfidence?(mint: string, decimals: number, prices: Record<string, AuthoritativePrice>, uiMultiplier?: number): Promise<void>;
}

interface JupiterPrice {
  usdPrice?: unknown;
  blockId?: unknown;
  stockData?: { price?: unknown; updatedAt?: unknown };
}

function usdMicros(value: unknown, roundUp: boolean) {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new Error('malformed price');
  const [whole, fraction = ''] = raw.split('.');
  let micros = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  if (roundUp && fraction.slice(6).replace(/0/g, '').length) micros += 1n;
  if (micros <= 0n || micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('price outside safe range');
  return micros.toString();
}

export class RegistryPriceProvider implements PriceProvider {
  constructor(private readonly entries: Array<{ mint: string; usdPriceMicros?: string; priceUpdatedAt?: string }>) {}
  async getUsdPrices(mints: string[]) {
    return Object.fromEntries(mints.map((mint) => {
      const entry = this.entries.find((item) => item.mint === mint);
      if (!entry?.usdPriceMicros || !entry.priceUpdatedAt) throw new GaslessError('TOKEN_UNSUPPORTED', 'pricing', 'Current pricing is unavailable.');
      return [mint, { usdPriceMicros: entry.usdPriceMicros, observedAt: entry.priceUpdatedAt }];
    }));
  }
}

export class JupiterPriceProvider implements PriceProvider {
  private readonly cache = new Map<string, AuthoritativePrice & { cachedAt: number }>();
  private readonly confidenceCache = new Map<string, { tokenPrice: string; solPrice: string; checkedAt: number }>();
  constructor(private readonly apiUrl: string, private readonly apiKey: string | undefined, private readonly rpc: SolanaRpc, private readonly maxAgeSeconds = 300, private readonly refreshSeconds = 30, private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now, private readonly quoteApiUrl = 'https://api.jup.ag/swap/v1/quote', private readonly maximumDeviationBps = 500, private readonly maximumPriceImpactBps = 100) {}

  async getUsdPrices(mints: string[]) {
    const unique = [...new Set([...mints, WRAPPED_SOL_MINT])];
    const current = this.now();
    const cached = unique.map((mint) => this.cache.get(mint));
    if (cached.every((price) => price && current - price.cachedAt <= this.refreshSeconds * 1000 && this.validAge(price.observedAt, current))) return this.pick(unique);
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!this.apiKey) throw new Error('missing api key');
        const url = new URL(this.apiUrl); url.searchParams.set('ids', unique.join(','));
        const response = await this.request(url, { headers: { 'x-api-key': this.apiKey }, signal: AbortSignal.timeout(7_000) });
        const payload = await response.json() as Record<string, JupiterPrice>;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const observations = await Promise.all(unique.map(async (mint) => {
          const price = payload[mint];
          if (!price || !Number.isSafeInteger(price.blockId) || Number(price.blockId) < 0) throw new Error('missing or malformed price');
          const blockTime = await this.rpc.getBlockTime(Number(price.blockId)).catch(() => null);
          const blockObservedAt = Number.isSafeInteger(blockTime) && blockTime! >= 0 ? new Date(blockTime! * 1000).toISOString() : '';
          if (this.validAge(blockObservedAt, current)) return [mint, { usdPriceMicros: usdMicros(price.usdPrice, mint === WRAPPED_SOL_MINT), observedAt: blockObservedAt, cachedAt: current }] as const;
          const stockObservedAt = typeof price.stockData?.updatedAt === 'string' ? price.stockData.updatedAt : '';
          if (mint === WRAPPED_SOL_MINT || !this.validAge(stockObservedAt, current)) throw new Error('stale or future price');
          return [mint, { usdPriceMicros: usdMicros(price.stockData?.price, false), observedAt: stockObservedAt, cachedAt: current }] as const;
        }));
        for (const [mint, price] of observations) this.cache.set(mint, price);
        return this.pick(unique);
      } catch (error) {
        failure = error;
        if (attempt === 0 && this.apiKey) await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    if (unique.every((mint) => { const price = this.cache.get(mint); return price && this.validAge(price.observedAt, current); })) return this.pick(unique);
    throw new GaslessError('TOKEN_UNSUPPORTED', 'pricing', 'Current server pricing is unavailable.', true, undefined, { cause: failure });
  }

  async assertExecutablePriceConfidence(mint: string, decimals: number, prices: Record<string, AuthoritativePrice>, uiMultiplier = 1) {
    try {
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !Number.isInteger(this.maximumDeviationBps) || this.maximumDeviationBps < 1 || this.maximumDeviationBps > 2_000 || !Number.isInteger(this.maximumPriceImpactBps) || this.maximumPriceImpactBps < 0 || this.maximumPriceImpactBps > 1_000) throw new Error('invalid confidence policy');
      const tokenPrice = prices[mint]?.usdPriceMicros; const solPrice = prices[WRAPPED_SOL_MINT]?.usdPriceMicros;
      if (!tokenPrice || !solPrice) throw new Error('missing price');
      const current = this.now(); const cached = this.confidenceCache.get(mint);
      if (cached && cached.tokenPrice === tokenPrice && cached.solPrice === solPrice && current - cached.checkedAt <= this.refreshSeconds * 1000) return;
      const executableReference = effectiveRawTokenUsdPriceMicros(BigInt(tokenPrice), uiMultiplier);
      if (mint === USDC_MINT) this.assertDeviation(executableReference, 1_000_000n);
      else this.assertDeviation(executableReference, await this.executableUsdPrice(mint, decimals, executableReference));
      this.assertDeviation(BigInt(solPrice), await this.executableUsdPrice(WRAPPED_SOL_MINT, 9, BigInt(solPrice)));
      this.confidenceCache.set(mint, { tokenPrice, solPrice, checkedAt: current });
    } catch (error) {
      throw new GaslessError('TOKEN_UNSUPPORTED', 'pricing_confidence', 'Current server pricing could not be confirmed by an executable route.', true, undefined, { cause: error });
    }
  }

  private async executableUsdPrice(inputMint: string, decimals: number, referencePriceMicros: bigint) {
    const scale = 10n ** BigInt(decimals);
    const amount = (10_000_000n * scale + referencePriceMicros - 1n) / referencePriceMicros;
    const url = new URL(this.quoteApiUrl);
    url.searchParams.set('inputMint', inputMint); url.searchParams.set('outputMint', USDC_MINT); url.searchParams.set('amount', (amount > 0n ? amount : 1n).toString()); url.searchParams.set('slippageBps', '50'); url.searchParams.set('swapMode', 'ExactIn');
    const response = await this.request(url, { headers: this.apiKey ? { 'x-api-key': this.apiKey } : undefined, signal: AbortSignal.timeout(7_000) });
    const payload = await response.json() as { outAmount?: unknown; priceImpactPct?: unknown; routePlan?: unknown[] };
    if (!response.ok || !/^\d+$/.test(String(payload.outAmount ?? '')) || BigInt(String(payload.outAmount)) <= 0n || !Array.isArray(payload.routePlan) || !payload.routePlan.length) throw new Error('unavailable executable quote');
    const impact = Number(payload.priceImpactPct); if (!Number.isFinite(impact) || impact < 0 || Math.ceil(impact * 10_000) > this.maximumPriceImpactBps) throw new Error('quote price impact exceeds policy');
    return BigInt(String(payload.outAmount)) * scale / amount;
  }

  private assertDeviation(reference: bigint, executable: bigint) {
    if (reference <= 0n || executable <= 0n || (reference > executable ? reference - executable : executable - reference) * 10_000n > reference * BigInt(this.maximumDeviationBps)) throw new Error('price deviation exceeds policy');
  }

  private validAge(observedAt: string, current: number) { const timestamp = Date.parse(observedAt); const age = current - timestamp; return Number.isFinite(timestamp) && age >= -30_000 && age <= this.maxAgeSeconds * 1000; }
  private pick(mints: string[]) { return Object.fromEntries(mints.map((mint) => { const price = this.cache.get(mint); if (!price) throw new Error('missing cache entry'); return [mint, { usdPriceMicros: price.usdPriceMicros, observedAt: price.observedAt }]; })); }
}
