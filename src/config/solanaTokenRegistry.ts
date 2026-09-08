import registryJson from '../../data/tokens/solana/generated/registry.json';
import type { SolanaRegistryToken, SolanaTokenRegistry } from '../../chains/solana/token-registry/types';

const registry = registryJson as unknown as SolanaTokenRegistry;
const byMint = new Map(registry.tokens.map((token) => [token.mint, token]));

export function getSolanaTokenMetadata(mint: string): Pick<SolanaRegistryToken, 'name' | 'symbol' | 'image'> | undefined {
  const token = byMint.get(mint);
  return token ? { name: token.name, symbol: token.symbol, image: token.image } : undefined;
}

export const solanaTokenRegistry = registry;
