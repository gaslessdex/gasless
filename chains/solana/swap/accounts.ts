import type { SwapDiscoveryResult, SwapToken } from '../../../shared/transactions/types.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import type { TokenRegistryEntry } from '../../../server/token-registry/service.js';
import { deriveAssociatedTokenAddress, inspectSendTokenAccount, validateDestinationAccount } from '../send/accounts.js';

function publicToken(entry: TokenRegistryEntry): Omit<SwapToken, 'balanceRaw' | 'sourceAccount'> {
  return { mint: entry.mint, symbol: entry.symbol, decimals: entry.decimals, tokenProgram: entry.tokenProgram, swapInputEnabled: entry.swapInputEnabled === true, swapOutputEnabled: entry.swapOutputEnabled === true };
}

export async function discoverSwapTokens(rpc: SolanaRpc, walletAddress: string, entries: TokenRegistryEntry[]): Promise<SwapDiscoveryResult> {
  const inputTokens: SwapToken[] = [];
  const outputTokens: SwapDiscoveryResult['outputTokens'] = [];
  for (const entry of entries.filter((token) => token.swapInputEnabled || token.swapOutputEnabled)) {
    const sourceAccount = deriveAssociatedTokenAddress(walletAddress, entry.mint, entry.tokenProgram);
    const rawAccount = await rpc.getAccountInfo(sourceAccount);
    const account = inspectSendTokenAccount(sourceAccount, rawAccount, walletAddress, entry);
    if (rawAccount && !account) throw new Error('canonical swap token account is invalid');
    if (entry.swapInputEnabled && account && BigInt(account.balanceRaw) > 0n) inputTokens.push({ ...account, swapInputEnabled: true, swapOutputEnabled: entry.swapOutputEnabled === true });
    if (entry.swapOutputEnabled) outputTokens.push({ ...publicToken(entry), sourceAccount, balanceRaw: account?.balanceRaw, outputAtaExists: rawAccount !== null });
  }
  return { walletAddress, network: 'devnet', scannedAt: new Date().toISOString(), inputTokens, outputTokens };
}

export function validateSwapOutputAccount(account: Awaited<ReturnType<SolanaRpc['getAccountInfo']>>, walletAddress: string, entry: TokenRegistryEntry) {
  const address = deriveAssociatedTokenAddress(walletAddress, entry.mint, entry.tokenProgram);
  if (account) validateDestinationAccount(account, walletAddress, entry.mint, address);
  return { address, exists: account !== null };
}
