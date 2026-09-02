import type { SolanaNetwork } from '../../shared/transactions/types.js';
import type { TokenRegistryEntry } from './service.js';

export type TokenCapability = 'SEND' | 'SWAP_INPUT' | 'SWAP_OUTPUT' | 'CLEAN_RECOVER';
export interface DynamicTokenEntry extends TokenRegistryEntry {
  network: SolanaNetwork;
  capabilities: TokenCapability[];
  paused: boolean;
  treasuryAta?: string;
  notes?: string;
  lastValidationStatus?: string;
  lastRouteCheckAt?: string;
  pricingAvailable?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DynamicTokenStore {
  list(network: SolanaNetwork): Promise<DynamicTokenEntry[]>;
  listAudit(network: SolanaNetwork, limit?: number): Promise<OperatorAuditEntry[]>;
  upsert(entry: DynamicTokenEntry, operation: string): Promise<void>;
  recordAudit(network: SolanaNetwork, operation: string, mint?: string, details?: Record<string, unknown>): Promise<void>;
}

export interface OperatorAuditEntry { operation: string; network: SolanaNetwork; mint: string; details?: Record<string, unknown>; operator?: string; createdAt: string; }

export class MemoryDynamicTokenStore implements DynamicTokenStore {
  readonly entries = new Map<string, DynamicTokenEntry>();
  readonly audit: OperatorAuditEntry[] = [];
  async list(network: SolanaNetwork) { return [...this.entries.values()].filter((entry) => entry.network === network).map((entry) => structuredClone(entry)); }
  async listAudit(network: SolanaNetwork, limit = 100) { return this.audit.filter((entry) => entry.network === network).slice(-limit).reverse().map((entry) => structuredClone(entry)); }
  async upsert(entry: DynamicTokenEntry, operation: string) {
    const key = `${entry.network}:${entry.mint}:${entry.tokenProgram}`;
    const current = this.entries.get(key);
    const now = new Date().toISOString();
    this.entries.set(key, { ...structuredClone(entry), createdAt: current?.createdAt ?? now, updatedAt: now });
    this.audit.push({ operation, network: entry.network, mint: entry.mint, createdAt: now });
  }
  async recordAudit(network: SolanaNetwork, operation: string, mint = '', details: Record<string, unknown> = {}) { this.audit.push({ operation, network, mint, details: structuredClone(details), createdAt: new Date().toISOString() }); }
}

export class SupabaseDynamicTokenStore implements DynamicTokenStore {
  constructor(private readonly url: string, private readonly key: string) {}
  private async request(path: string, init?: RequestInit) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...init?.headers },
      signal: AbortSignal.timeout(7_000),
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error('Dynamic token registry is unavailable.');
    const text = await response.text();
    return text ? JSON.parse(text) : [];
  }
  async list(network: SolanaNetwork) {
    const rows = await this.request(`gasless_token_registry?network=eq.${encodeURIComponent(network)}&select=*`) as Array<Record<string, unknown>>;
    return rows.map(fromRow);
  }
  async listAudit(network: SolanaNetwork, limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await this.request(`gasless_operator_audit?network=eq.${encodeURIComponent(network)}&select=operation,network,mint,details,created_at&order=created_at.desc&limit=${safeLimit}`) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ operation: String(row.operation), network: row.network as SolanaNetwork, mint: row.mint ? String(row.mint) : '', details: (row.details ?? {}) as Record<string, unknown>, createdAt: String(row.created_at) }));
  }
  async upsert(entry: DynamicTokenEntry, operation: string) {
    const now = new Date().toISOString();
    await this.request('gasless_token_registry?on_conflict=network,mint,token_program', { method: 'POST', body: JSON.stringify(toRow(entry, now)), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    await this.recordAudit(entry.network, operation, entry.mint, { capabilities: entry.capabilities, paused: entry.paused });
  }
  async recordAudit(network: SolanaNetwork, operation: string, mint?: string, details: Record<string, unknown> = {}) { await this.request('gasless_operator_audit', { method: 'POST', body: JSON.stringify({ network, operation, mint, details, created_at: new Date().toISOString() }) }); }
}

function fromRow(row: Record<string, unknown>): DynamicTokenEntry {
  const capabilities = (row.capabilities ?? []) as TokenCapability[];
  return {
    network: row.network as SolanaNetwork,
    mint: String(row.mint), symbol: String(row.symbol), decimals: Number(row.decimals), tokenProgram: String(row.token_program),
    name: row.name ? String(row.name) : undefined,
    extensions: (row.extensions ?? []) as string[], status: row.status === 'ACTIVE' ? 'supported' : 'blocked',
    enabledActions: [...new Set(capabilities.map((capability) => capability === 'SEND' ? 'SEND' : capability.startsWith('SWAP') ? 'SWAP' : 'CLEAN_RECOVER'))] as TokenRegistryEntry['enabledActions'],
    feePaymentEnabled: capabilities.includes('SEND') || capabilities.includes('SWAP_INPUT'),
    swapInputEnabled: capabilities.includes('SWAP_INPUT'), swapOutputEnabled: capabilities.includes('SWAP_OUTPUT'),
    capabilities, paused: Boolean(row.paused), pausedCapabilities: (row.paused_capabilities ?? []) as DynamicTokenEntry['pausedCapabilities'], treasuryAta: row.treasury_ata ? String(row.treasury_ata) : undefined,
    approvedDexFamilies: (row.approved_dex_families ?? []) as DynamicTokenEntry['approvedDexFamilies'],
    pricingStatus: row.pricing_status as DynamicTokenEntry['pricingStatus'], pricingSource: row.pricing_source ? String(row.pricing_source) : undefined,
    riskLimits: (row.risk_limits ?? {}) as DynamicTokenEntry['riskLimits'], operator: row.updated_by ? String(row.updated_by) : undefined,
    auditMetadata: (row.audit_metadata ?? {}) as Record<string, unknown>,
    notes: row.operator_notes ? String(row.operator_notes) : undefined, lastValidationStatus: row.last_validation_status ? String(row.last_validation_status) : undefined,
    lastRouteCheckAt: row.last_route_check_at ? String(row.last_route_check_at) : undefined, pricingAvailable: Boolean(row.pricing_available),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function toRow(entry: DynamicTokenEntry, updatedAt: string) {
  return { network: entry.network, mint: entry.mint, token_program: entry.tokenProgram, symbol: entry.symbol, name: entry.name, decimals: entry.decimals, extensions: entry.extensions, status: entry.status === 'supported' ? 'ACTIVE' : 'REVIEW', capabilities: entry.capabilities, approved_dex_families: entry.approvedDexFamilies ?? [], paused: entry.paused, paused_capabilities: entry.pausedCapabilities ?? [], treasury_ata: entry.treasuryAta, operator_notes: entry.notes, last_validation_status: entry.lastValidationStatus, last_route_check_at: entry.lastRouteCheckAt, pricing_available: entry.pricingAvailable, pricing_status: entry.pricingStatus, pricing_source: entry.pricingSource, risk_limits: entry.riskLimits ?? {}, updated_by: entry.operator, audit_metadata: entry.auditMetadata ?? {}, updated_at: updatedAt };
}
