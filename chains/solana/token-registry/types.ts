export const SOLANA_TOKEN_REGISTRY_SCHEMA = 'solana-token-registry-v1' as const;
export const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export type RegistryValidationStatus = 'ACTIVE' | 'NEEDS_REVIEW' | 'REJECTED';
export type RegistryDexFamily = 'Raydium CLMM' | 'Meteora DLMM' | 'Pump.fun Amm';

export interface SolanaRegistryRouteCheck {
  direction: 'INPUT' | 'OUTPUT' | 'RECOVER';
  anchorMint: string;
  available: boolean;
  family?: RegistryDexFamily;
  checkedAt: string;
  reason?: string;
}

export interface SolanaRegistryToken {
  sourceRow: number;
  operatorName: string;
  operatorSymbol: string;
  name: string;
  symbol: string;
  mint: string;
  referenceDex: string;
  decimals: number | null;
  supplyRaw: string | null;
  tokenProgram: string | null;
  initialized: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  token2022Profile?: {
    mintAccountSize: number;
    tokenAccountSize: number;
    transferHook: { authority: string | null; programId: string | null; extraAccountMetaList: string | null } | null;
    metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
    permanentDelegate: string | null;
    defaultAccountState: 'INITIALIZED' | 'FROZEN' | 'UNINITIALIZED' | null;
    pausable: { authority: string | null; paused: boolean } | null;
    confidentialTransferMint: { authority: string | null; autoApproveNewAccounts: boolean; auditorElgamalPubkeyHex: string | null } | null;
    scaledUiAmount: { authority: string | null; multiplier: number; newMultiplierEffectiveTimestamp: string; newMultiplier: number; currentMultiplier: number } | null;
  };
  launchPlatform: 'PUMPFUN' | 'RAYDIUM_LAUNCHLAB' | 'METEORA' | 'OTHER_KNOWN' | 'UNKNOWN';
  extensionCompatibility: Array<{ extension: string; category: 'COMPATIBLE_NOW' | 'COMPATIBLE_WITH_EXISTING_ROUTER_BUILDER' | 'ACTUAL_TECHNICAL_BLOCKER'; reason: string }>;
  featureBlockers: { send?: string; swap?: string; recover?: string };
  metadataUri: string | null;
  metadataSource: string;
  image: string;
  imageSource: string | null;
  enabled: boolean;
  sendEnabled: boolean;
  swapInputEnabled: boolean;
  swapOutputEnabled: boolean;
  recoverEnabled: boolean;
  cleanMetadataOnly: true;
  validationStatus: RegistryValidationStatus;
  notes: string[];
  routes: SolanaRegistryRouteCheck[];
}

export interface SolanaTokenRegistry {
  schema: typeof SOLANA_TOKEN_REGISTRY_SCHEMA;
  generatedAt: string;
  source: string;
  rowCount: number;
  tokens: SolanaRegistryToken[];
}

const PINNED_MINTS = new Map([[WRAPPED_SOL_MINT, 0], [USDC_MINT, 1], [USDT_MINT, 2]]);

export function compareSolanaTokens(left: Pick<SolanaRegistryToken, 'mint' | 'symbol' | 'name'>, right: Pick<SolanaRegistryToken, 'mint' | 'symbol' | 'name'>) {
  const leftPin = PINNED_MINTS.get(left.mint) ?? Number.MAX_SAFE_INTEGER;
  const rightPin = PINNED_MINTS.get(right.mint) ?? Number.MAX_SAFE_INTEGER;
  return leftPin - rightPin || left.symbol.localeCompare(right.symbol, undefined, { sensitivity: 'base' }) || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.mint.localeCompare(right.mint);
}

export function searchSolanaTokens<T extends Pick<SolanaRegistryToken, 'mint' | 'symbol' | 'name'>>(tokens: readonly T[], query: string): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return [...tokens].filter((token) => {
    const haystack = `${token.symbol} ${token.name} ${token.mint}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).sort(compareSolanaTokens);
}

export function shortSolanaMint(mint: string) {
  return mint.length > 12 ? `${mint.slice(0, 5)}…${mint.slice(-5)}` : mint;
}
