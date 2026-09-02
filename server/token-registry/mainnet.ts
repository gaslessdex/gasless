import { GaslessError } from '../errors.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { TokenRegistryEntry } from './service.js';

const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export async function assertCanonicalMainnetMints(rpc: Pick<SolanaRpc, 'getAccountInfo'>, entries: TokenRegistryEntry[]) {
  const unique = [...new Map(entries.map((entry) => [entry.mint, entry])).values()];
  for (const entry of unique) {
    const account = await rpc.getAccountInfo(entry.mint);
    try {
      const data = Buffer.from(account?.data[0] ?? '', 'base64');
      if (!account || account.owner !== LEGACY_TOKEN_PROGRAM || entry.tokenProgram !== LEGACY_TOKEN_PROGRAM || entry.extensions.length || data.length < 82 || data[44] !== entry.decimals || data[45] !== 1) throw new Error();
    } catch (error) {
      throw new GaslessError('CONFIGURATION_ERROR', 'mainnet_token_identity', `Configured Mainnet mint ${entry.mint} failed canonical identity validation.`, false, undefined, { cause: error });
    }
  }
}
