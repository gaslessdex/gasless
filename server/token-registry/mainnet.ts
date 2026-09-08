import { GaslessError } from '../errors.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { TokenRegistryEntry } from './service.js';
import { isSupportedXStockMintProfile, parseToken2022Mint } from '../../chains/solana/token-2022/accounts.js';
import { TOKEN_2022_PROGRAM } from '../../chains/solana/token-registry/types.js';

const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export function mainnetMintValidationEntries(entries: TokenRegistryEntry[], recoverMints: string[]) {
  const byMint = new Map(entries.map((entry) => [entry.mint, entry]));
  const recoverEntries = recoverMints.map((mint) => byMint.get(mint) ?? { mint, symbol: mint, decimals: -1, tokenProgram: LEGACY_TOKEN_PROGRAM, extensions: [], status: 'supported' as const, enabledActions: ['CLEAN_RECOVER' as const] });
  return [...entries, ...recoverEntries];
}

export async function assertCanonicalMainnetMints(rpc: Pick<SolanaRpc, 'getMultipleAccounts'>, entries: TokenRegistryEntry[]) {
  const unique = [...new Map(entries.map((entry) => [entry.mint, entry])).values()];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const accounts = await rpc.getMultipleAccounts(batch.map((entry) => entry.mint));
    if (accounts.length !== batch.length) throw new GaslessError('CONFIGURATION_ERROR', 'mainnet_token_identity', 'Mainnet mint identity validation returned an incomplete account batch.', false);
    for (const [index, entry] of batch.entries()) {
      const account = accounts[index];
      try {
        if (!account) throw new Error();
        const data = Buffer.from(account.data[0] ?? '', 'base64');
        const legacy = account.owner === LEGACY_TOKEN_PROGRAM && entry.tokenProgram === LEGACY_TOKEN_PROGRAM && !entry.extensions.length && data.length >= 82 && data[44] === entry.decimals && data[45] === 1;
        const token2022 = account.owner === TOKEN_2022_PROGRAM && entry.tokenProgram === TOKEN_2022_PROGRAM && entry.token2022Profile && isSupportedXStockMintProfile(parseToken2022Mint(entry.mint, account));
        if (!legacy && !token2022) throw new Error();
      } catch (error) {
        throw new GaslessError('CONFIGURATION_ERROR', 'mainnet_token_identity', `Configured Mainnet mint ${entry.mint} failed canonical identity validation.`, false, undefined, { cause: error });
      }
    }
  }
}
