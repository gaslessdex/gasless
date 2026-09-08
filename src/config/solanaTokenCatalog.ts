import registryJson from '../../data/tokens/solana/generated/registry.json';
import { compareSolanaTokens, LEGACY_TOKEN_PROGRAM, USDC_MINT, USDT_MINT, type SolanaTokenRegistry } from '../../chains/solana/token-registry/types';

export type SolanaCatalogToken = { mint: string; symbol: string; name: string; image?: string; decimals: number; tokenProgram: string };

const registry = registryJson as unknown as SolanaTokenRegistry;
const active = registry.tokens.filter((token) => token.validationStatus === 'ACTIVE' && token.enabled && token.decimals !== null && token.tokenProgram !== null);
const core: Record<string, SolanaCatalogToken> = {
  [USDC_MINT]: { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, tokenProgram: LEGACY_TOKEN_PROGRAM },
  [USDT_MINT]: { mint: USDT_MINT, symbol: 'USDT', name: 'Tether USD', decimals: 6, tokenProgram: LEGACY_TOKEN_PROGRAM },
};

function catalog(tokens: SolanaCatalogToken[]) {
  return [...new Map(tokens.map((token) => [token.mint, token])).values()].sort(compareSolanaTokens);
}

function publicToken(token: (typeof active)[number]): SolanaCatalogToken {
  return { mint: token.mint, symbol: token.symbol, name: token.name, image: token.image, decimals: token.decimals!, tokenProgram: token.tokenProgram! };
}

export const sendTokenCatalog = catalog([core[USDC_MINT]!, ...active.filter((token) => token.sendEnabled).map(publicToken)]);
export const swapInputTokenCatalog = catalog([core[USDC_MINT]!, ...active.filter((token) => token.swapInputEnabled).map(publicToken)]);
export const swapOutputTokenCatalog = catalog([core[USDT_MINT]!, ...active.filter((token) => token.swapOutputEnabled).map(publicToken)]);
