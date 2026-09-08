import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { LEGACY_TOKEN_PROGRAM, SOLANA_TOKEN_REGISTRY_SCHEMA, USDC_MINT, USDT_MINT, type SolanaTokenRegistry } from '../../chains/solana/token-registry/types.js';
import { APPROVED_DEX_FAMILIES, type ApprovedDexFamily } from '../jupiter/service.js';
import type { TokenRegistryEntry } from './service.js';

const CORE_TOKENS: TokenRegistryEntry[] = [
  { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, tokenProgram: LEGACY_TOKEN_PROGRAM, extensions: [], status: 'supported', enabledActions: ['SEND', 'SWAP'], feePaymentEnabled: true, swapInputEnabled: true, swapOutputEnabled: false, approvedDexFamilies: [...APPROVED_DEX_FAMILIES], reimbursementBufferBps: 100, operator: 'core-policy' },
  { mint: USDT_MINT, symbol: 'USDT', name: 'Tether USD', decimals: 6, tokenProgram: LEGACY_TOKEN_PROGRAM, extensions: [], status: 'supported', enabledActions: ['SWAP', 'CLEAN_RECOVER'], feePaymentEnabled: false, swapInputEnabled: false, swapOutputEnabled: true, approvedDexFamilies: [...APPROVED_DEX_FAMILIES], reimbursementBufferBps: 100, operator: 'core-policy' },
];

function readRegistry() {
  const file = new URL('../../data/tokens/solana/generated/registry.json', import.meta.url);
  const value = JSON.parse(readFileSync(file, 'utf8')) as SolanaTokenRegistry;
  if (value.schema !== SOLANA_TOKEN_REGISTRY_SCHEMA || value.rowCount !== value.tokens.length) throw new Error('Generated Solana token registry has an unsupported schema or row count.');
  const seen = new Set<string>();
  for (const token of value.tokens) {
    if (seen.has(token.mint)) throw new Error(`Generated Solana token registry contains duplicate mint ${token.mint}.`);
    seen.add(token.mint);
    if (new PublicKey(token.mint).toBase58() !== token.mint) throw new Error(`Generated Solana token registry contains invalid mint ${token.mint}.`);
  }
  return value;
}

export function generatedTokenPolicy() {
  const registry = readRegistry();
  const entries = registry.tokens.filter((token) => token.validationStatus === 'ACTIVE' && token.enabled && token.tokenProgram && token.decimals !== null).map((token): TokenRegistryEntry => {
    const approvedDexFamilies = [...new Set(token.routes.filter((route) => route.available && route.family && APPROVED_DEX_FAMILIES.includes(route.family)).map((route) => route.family!))] as ApprovedDexFamily[];
    const enabledActions = [token.sendEnabled ? 'SEND' : undefined, token.swapInputEnabled || token.swapOutputEnabled ? 'SWAP' : undefined, token.recoverEnabled ? 'CLEAN_RECOVER' : undefined].filter((action): action is 'SEND' | 'SWAP' | 'CLEAN_RECOVER' => Boolean(action));
    return { mint: token.mint, symbol: token.symbol, name: token.name, image: token.image, decimals: token.decimals!, tokenProgram: token.tokenProgram!, extensions: token.extensions, token2022Profile: token.token2022Profile, status: 'supported', enabledActions, feePaymentEnabled: token.sendEnabled || token.swapInputEnabled, swapInputEnabled: token.swapInputEnabled, swapOutputEnabled: token.swapOutputEnabled, approvedDexFamilies, operator: 'xlsx-import', auditMetadata: { sourceRow: token.sourceRow, generatedAt: registry.generatedAt, referenceDex: token.referenceDex, validationStatus: token.validationStatus } };
  });
  const allEntries = mergeTokenEntries(entries, CORE_TOKENS, true);
  return {
    registry,
    entries: allEntries,
    sendTokens: allEntries.filter((entry) => entry.enabledActions.includes('SEND')),
    swapTokens: allEntries.filter((entry) => entry.enabledActions.includes('SWAP')),
    recoverMints: allEntries.filter((entry) => entry.enabledActions.includes('CLEAN_RECOVER')).map((entry) => entry.mint),
  };
}

export function mergeTokenEntries(generated: TokenRegistryEntry[], overrides: TokenRegistryEntry[], includeNew = false) {
  const merged = new Map(generated.map((entry) => [entry.mint, entry]));
  for (const override of overrides) {
    const current = merged.get(override.mint);
    // On-chain-verified generated identity and capabilities are authoritative.
    // Existing environment entries may still supply operational fields such as prices.
    if (current) merged.set(override.mint, { ...override, ...current });
    else if (includeNew) merged.set(override.mint, override);
  }
  return [...merged.values()];
}
