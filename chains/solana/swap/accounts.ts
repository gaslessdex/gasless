import type { SwapDiscoveryResult, SwapToken } from '../../../shared/transactions/types.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import type { TokenRegistryEntry } from '../../../server/token-registry/service.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { TOKEN_2022_PROGRAM } from '../token-registry/types.js';
import { deriveAssociatedTokenAddress, inspectSendTokenAccount, validateDestinationAccount } from '../send/accounts.js';

function publicToken(entry: TokenRegistryEntry): Omit<SwapToken, 'balanceRaw' | 'sourceAccount'> {
  return { mint: entry.mint, symbol: entry.symbol, name: entry.name, image: entry.image, decimals: entry.decimals, tokenProgram: entry.tokenProgram, uiMultiplier: entry.token2022Profile?.scaledUiAmount?.currentMultiplier, tokenAccountSize: entry.token2022Profile?.tokenAccountSize, swapInputEnabled: entry.swapInputEnabled === true, swapOutputEnabled: entry.swapOutputEnabled === true };
}

export async function discoverSwapTokens(rpc: SolanaRpc, walletAddress: string, entries: TokenRegistryEntry[]): Promise<SwapDiscoveryResult> {
  const inputTokens: SwapToken[] = [];
  const outputTokens: SwapDiscoveryResult['outputTokens'] = [];
  const [legacyAccounts, token2022Accounts] = await Promise.all([
    rpc.getTokenAccountsByOwner(walletAddress, LEGACY_TOKEN_PROGRAM_ID),
    rpc.getTokenAccountsByOwner(walletAddress, TOKEN_2022_PROGRAM),
  ]);
  const accounts = new Map([...legacyAccounts, ...token2022Accounts].map(({ pubkey, account }) => [pubkey, account]));
  for (const entry of entries.filter((token) => token.swapInputEnabled || token.swapOutputEnabled)) {
    const sourceAccount = deriveAssociatedTokenAddress(walletAddress, entry.mint, entry.tokenProgram);
    const rawAccount = accounts.get(sourceAccount) ?? null;
    const account = inspectSendTokenAccount(sourceAccount, rawAccount, walletAddress, entry);
    if (rawAccount && !account) throw new Error('canonical swap token account is invalid');
    if (entry.swapInputEnabled) inputTokens.push({ ...(account ?? { ...publicToken(entry), sourceAccount, balanceRaw: '0' }), swapInputEnabled: true, swapOutputEnabled: entry.swapOutputEnabled === true });
    if (entry.swapOutputEnabled) outputTokens.push({ ...publicToken(entry), sourceAccount, balanceRaw: account?.balanceRaw, outputAtaExists: rawAccount !== null });
  }
  return { walletAddress, network: 'devnet', scannedAt: new Date().toISOString(), inputTokens, outputTokens };
}

export function validateSwapOutputAccount(account: Awaited<ReturnType<SolanaRpc['getAccountInfo']>>, walletAddress: string, entry: TokenRegistryEntry) {
  const address = deriveAssociatedTokenAddress(walletAddress, entry.mint, entry.tokenProgram);
  if (account) validateDestinationAccount(account, walletAddress, entry.mint, address, entry.tokenProgram, entry.token2022Profile?.tokenAccountSize);
  return { address, exists: account !== null };
}
