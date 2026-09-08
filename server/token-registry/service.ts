import type { SolanaNetwork, TransactionAction } from '../../shared/transactions/types.js';
import type { SolanaRegistryToken } from '../../chains/solana/token-registry/types.js';
import { RAYDIUM_CLMM_DEX, type ApprovedDexFamily } from '../jupiter/service.js';
import type { DynamicTokenStore } from './dynamic.js';

export type TokenDecision = 'supported' | 'unsupported' | 'blocked' | 'unknown' | 'not_applicable';
export interface TokenRegistryEntry {
  mint: string; symbol: string; name?: string; image?: string; decimals: number; tokenProgram: string; extensions: string[];
  token2022Profile?: SolanaRegistryToken['token2022Profile'];
  status: TokenDecision; enabledActions: TransactionAction[]; feePaymentEnabled?: boolean;
  swapInputEnabled?: boolean; swapOutputEnabled?: boolean;
  approvedDexFamilies?: ApprovedDexFamily[];
  pricingStatus?: 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'DEVIATING'; pricingSource?: string;
  riskLimits?: Record<string, string | number | boolean>;
  operator?: string; auditMetadata?: Record<string, unknown>;
  pausedCapabilities?: Array<'SEND' | 'SWAP_INPUT' | 'SWAP_OUTPUT' | 'CLEAN_RECOVER'>;
  usdPriceMicros?: string; solUsdPriceMicros?: string; priceUpdatedAt?: string; reimbursementBufferBps?: number;
}
export interface TokenRegistry {
  evaluate(action: TransactionAction, mint?: string): Promise<{ decision: TokenDecision; entry?: TokenRegistryEntry }>;
  list(action: TransactionAction): Promise<TokenRegistryEntry[]>;
}

export class ServerTokenRegistry implements TokenRegistry {
  private readonly recoverMints: Set<string>;
  private readonly sendTokens: TokenRegistryEntry[];
  private readonly swapTokens: TokenRegistryEntry[];
  constructor(recoverMints: string[] = [], sendTokens: TokenRegistryEntry[] = [], swapTokens: TokenRegistryEntry[] = [], private readonly pauses: Array<{ mint: string; actions: Array<'SEND' | 'SWAP_INPUT' | 'SWAP_OUTPUT' | 'CLEAN_RECOVER'> }> = [], private readonly dynamic?: DynamicTokenStore, private readonly network: SolanaNetwork = 'devnet') { this.recoverMints = new Set(recoverMints); this.sendTokens = sendTokens.map((entry) => ({ ...entry })); this.swapTokens = swapTokens.map((entry) => ({ ...entry })); }
  isPaused(mint: string, capability: 'SEND' | 'SWAP_INPUT' | 'SWAP_OUTPUT' | 'CLEAN_RECOVER') { return this.pauses.some((pause) => pause.mint === mint && pause.actions.includes(capability)); }
  private async dynamicEntries() { return this.dynamic ? this.dynamic.list(this.network) : []; }
  private async effectiveEntries(bootstrap: TokenRegistryEntry[]) {
    const dynamic = await this.dynamicEntries();
    const merged = new Map(bootstrap.map((entry) => [`${entry.mint}:${entry.tokenProgram}`, entry]));
    for (const entry of dynamic) {
      const key = `${entry.mint}:${entry.tokenProgram}`;
      const current = merged.get(key);
      const defined = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as unknown as TokenRegistryEntry;
      const effective = { ...current, ...defined };
      merged.set(key, entry.paused ? { ...effective, status: 'blocked' as const } : effective);
    }
    return [...merged.values()];
  }
  private recoverEntry(mint: string): TokenRegistryEntry {
    const configured = [...this.sendTokens, ...this.swapTokens].find((entry) => entry.mint === mint);
    return configured ? { ...configured, enabledActions: [...new Set([...configured.enabledActions, 'CLEAN_RECOVER' as const])], approvedDexFamilies: configured.approvedDexFamilies?.length ? configured.approvedDexFamilies : [RAYDIUM_CLMM_DEX] } : { mint, symbol: mint, decimals: 0, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', extensions: [], status: 'supported', enabledActions: ['CLEAN_RECOVER'], approvedDexFamilies: [RAYDIUM_CLMM_DEX] };
  }
  async evaluate(action: TransactionAction, mint?: string): Promise<{ decision: TokenDecision; entry?: TokenRegistryEntry }> {
    if (action === 'DEVNET_PROOF') return { decision: 'not_applicable' as const };
    const dynamic = await this.dynamicEntries();
    const dynamicEntry = dynamic.find((entry) => entry.mint === mint);
    if (action === 'CLEAN_RECOVER' && mint && (this.isPaused(mint, 'CLEAN_RECOVER') || dynamicEntry?.paused || dynamicEntry?.pausedCapabilities?.includes('CLEAN_RECOVER'))) return { decision: 'blocked' as const, entry: dynamicEntry };
    if (action === 'CLEAN_RECOVER' && mint && dynamicEntry?.capabilities.includes('CLEAN_RECOVER') && dynamicEntry.approvedDexFamilies?.length) return { decision: 'supported' as const, entry: dynamicEntry };
    if (action === 'CLEAN_RECOVER' && mint && this.recoverMints.has(mint)) return { decision: 'supported', entry: this.recoverEntry(mint) };
    if (action === 'SEND' && mint) {
      const entry = (await this.effectiveEntries(this.sendTokens)).find((token) => token.mint === mint);
      if (entry && (this.isPaused(mint, 'SEND') || entry.pausedCapabilities?.includes('SEND'))) return { decision: 'blocked' as const, entry };
      if (entry?.status === 'supported' && entry.feePaymentEnabled && entry.enabledActions.includes('SEND')) return { decision: 'supported' as const, entry };
      return { decision: entry?.status === 'blocked' ? 'blocked' as const : 'unsupported' as const, entry };
    }
    if (action === 'SWAP' && mint) {
      const entry = (await this.effectiveEntries(this.swapTokens)).find((token) => token.mint === mint);
      const pausedCapabilities = (['SWAP_INPUT', 'SWAP_OUTPUT'] as const).filter((capability) => this.isPaused(mint, capability) || entry?.pausedCapabilities?.includes(capability));
      const effective = entry ? { ...entry, pausedCapabilities, swapInputEnabled: Boolean(entry.swapInputEnabled && !pausedCapabilities.includes('SWAP_INPUT')), swapOutputEnabled: Boolean(entry.swapOutputEnabled && !pausedCapabilities.includes('SWAP_OUTPUT')) } : undefined;
      if (effective?.status === 'supported' && effective.enabledActions.includes('SWAP') && (effective.swapInputEnabled || effective.swapOutputEnabled)) return { decision: 'supported' as const, entry: effective };
      return { decision: entry?.status === 'blocked' ? 'blocked' as const : 'unsupported' as const, entry };
    }
    return { decision: 'unsupported' as const };
  }
  async list(action: TransactionAction): Promise<TokenRegistryEntry[]> {
    if (action === 'SEND') return (await this.effectiveEntries(this.sendTokens)).filter((entry) => entry.status === 'supported' && entry.feePaymentEnabled && entry.enabledActions.includes('SEND') && !this.isPaused(entry.mint, 'SEND') && !entry.pausedCapabilities?.includes('SEND')).map((entry) => ({ ...entry }));
    if (action === 'SWAP') return (await this.effectiveEntries(this.swapTokens)).filter((entry) => entry.status === 'supported' && entry.enabledActions.includes('SWAP') && !(['SWAP_INPUT', 'SWAP_OUTPUT'] as const).every((capability) => this.isPaused(entry.mint, capability) || entry.pausedCapabilities?.includes(capability))).map((entry) => ({ ...entry, swapInputEnabled: Boolean(entry.swapInputEnabled && !this.isPaused(entry.mint, 'SWAP_INPUT') && !entry.pausedCapabilities?.includes('SWAP_INPUT')), swapOutputEnabled: Boolean(entry.swapOutputEnabled && !this.isPaused(entry.mint, 'SWAP_OUTPUT') && !entry.pausedCapabilities?.includes('SWAP_OUTPUT')) }));
    if (action === 'CLEAN_RECOVER') {
      const dynamic = (await this.dynamicEntries()).filter((entry) => entry.status === 'supported' && entry.capabilities.includes('CLEAN_RECOVER') && entry.approvedDexFamilies?.length && !entry.paused && !this.isPaused(entry.mint, 'CLEAN_RECOVER') && !entry.pausedCapabilities?.includes('CLEAN_RECOVER'));
      const seen = new Set(dynamic.map((entry) => entry.mint));
      return [...dynamic, ...[...this.recoverMints].filter((mint) => !seen.has(mint)).map((mint) => this.recoverEntry(mint))];
    }
    return [];
  }
}
