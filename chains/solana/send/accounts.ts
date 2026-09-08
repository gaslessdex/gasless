import { PublicKey } from '@solana/web3.js';
import type { SendToken } from '../../../shared/transactions/types.js';
import type { RpcAccountInfo, SolanaRpc } from '../../../server/solana/rpc.js';
import type { TokenRegistryEntry } from '../../../server/token-registry/service.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { parseToken2022Account, XSTOCK_TOKEN_ACCOUNT_EXTENSIONS } from '../token-2022/accounts.js';
import { TOKEN_2022_PROGRAM } from '../token-registry/types.js';

export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_ACCOUNT_SIZE = 165;

export function deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram = LEGACY_TOKEN_PROGRAM_ID) {
  const ownerKey = new PublicKey(owner); const mintKey = new PublicKey(mint); const programKey = new PublicKey(tokenProgram);
  return PublicKey.findProgramAddressSync([ownerKey.toBuffer(), programKey.toBuffer(), mintKey.toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))[0].toBase58();
}

export function inspectSendTokenAccount(address: string, account: RpcAccountInfo | null, walletAddress: string, entry: TokenRegistryEntry): SendToken | null {
  if (!account || account.owner !== entry.tokenProgram) return null;
  if (entry.tokenProgram === TOKEN_2022_PROGRAM) {
    if (!entry.token2022Profile || entry.token2022Profile.transferHook?.programId !== null) return null;
    try {
      const value = parseToken2022Account(address, account);
      if (value.accountSize !== entry.token2022Profile.tokenAccountSize || value.mint !== entry.mint || value.owner !== walletAddress || !value.initialized || value.frozen || value.native || value.delegate || value.delegatedAmountRaw !== '0' || value.closeAuthority || value.extensions.length !== XSTOCK_TOKEN_ACCOUNT_EXTENSIONS.length || !XSTOCK_TOKEN_ACCOUNT_EXTENSIONS.every((extension) => value.extensions.includes(extension))) return null;
      return { mint: entry.mint, symbol: entry.symbol, name: entry.name, image: entry.image, decimals: entry.decimals, tokenProgram: entry.tokenProgram, balanceRaw: value.amountRaw, sourceAccount: address, uiMultiplier: entry.token2022Profile.scaledUiAmount?.currentMultiplier ?? 1, tokenAccountSize: value.accountSize };
    } catch { return null; }
  }
  if (entry.tokenProgram !== LEGACY_TOKEN_PROGRAM_ID || entry.extensions.length) return null;
  let data: Buffer; try { data = Buffer.from(account.data[0], 'base64'); } catch { return null; }
  if (data.length !== TOKEN_ACCOUNT_SIZE || new PublicKey(data.subarray(0, 32)).toBase58() !== entry.mint || new PublicKey(data.subarray(32, 64)).toBase58() !== walletAddress) return null;
  if (data[108] !== 1 || data.readUInt32LE(72) !== 0 || data.readBigUInt64LE(121) !== 0n || data.readUInt32LE(109) !== 0 || data.readUInt32LE(129) !== 0) return null;
  return { mint: entry.mint, symbol: entry.symbol, name: entry.name, image: entry.image, decimals: entry.decimals, tokenProgram: entry.tokenProgram, balanceRaw: data.readBigUInt64LE(64).toString(), sourceAccount: address };
}

export function validateDestinationAccount(account: RpcAccountInfo | null, recipientWallet: string, mint: string, expectedAddress: string, tokenProgram = LEGACY_TOKEN_PROGRAM_ID, tokenAccountSize = TOKEN_ACCOUNT_SIZE) {
  if (!account) return false;
  if (account.owner !== tokenProgram) throw new Error('destination token program mismatch');
  if (tokenProgram === TOKEN_2022_PROGRAM) {
    const value = parseToken2022Account(expectedAddress, account);
    if (value.accountSize !== tokenAccountSize || value.mint !== mint || value.owner !== recipientWallet || !value.initialized || value.frozen || value.native || value.delegate || value.delegatedAmountRaw !== '0' || value.closeAuthority || value.extensions.length !== XSTOCK_TOKEN_ACCOUNT_EXTENSIONS.length || !XSTOCK_TOKEN_ACCOUNT_EXTENSIONS.every((extension) => value.extensions.includes(extension)) || deriveAssociatedTokenAddress(recipientWallet, mint, tokenProgram) !== expectedAddress) throw new Error('destination account invalid');
    return true;
  }
  let data: Buffer; try { data = Buffer.from(account.data[0], 'base64'); } catch { throw new Error('destination account malformed'); }
  if (data.length !== TOKEN_ACCOUNT_SIZE || new PublicKey(data.subarray(0, 32)).toBase58() !== mint || new PublicKey(data.subarray(32, 64)).toBase58() !== recipientWallet || data[108] !== 1 || deriveAssociatedTokenAddress(recipientWallet, mint) !== expectedAddress) throw new Error('destination account invalid');
  return true;
}

export async function discoverSendTokens(rpc: SolanaRpc, walletAddress: string, entries: TokenRegistryEntry[]) {
  new PublicKey(walletAddress);
  const [legacyAccounts, token2022Accounts] = await Promise.all([
    rpc.getTokenAccountsByOwner(walletAddress, LEGACY_TOKEN_PROGRAM_ID),
    rpc.getTokenAccountsByOwner(walletAddress, TOKEN_2022_PROGRAM),
  ]);
  const accounts = new Map([...legacyAccounts, ...token2022Accounts].map(({ pubkey, account }) => [pubkey, account]));
  const tokens: SendToken[] = [];
  for (const entry of entries) {
    const source = deriveAssociatedTokenAddress(walletAddress, entry.mint, entry.tokenProgram);
    const raw = accounts.get(source) ?? null;
    const inspected = inspectSendTokenAccount(source, raw, walletAddress, entry);
    if (raw && !inspected) throw new Error('canonical Send token account is invalid');
    tokens.push(inspected ?? { mint: entry.mint, symbol: entry.symbol, name: entry.name, image: entry.image, decimals: entry.decimals, tokenProgram: entry.tokenProgram, balanceRaw: '0', sourceAccount: source, uiMultiplier: entry.token2022Profile?.scaledUiAmount?.currentMultiplier ?? 1, tokenAccountSize: entry.token2022Profile?.tokenAccountSize });
  }
  return { walletAddress, network: 'devnet' as const, scannedAt: new Date().toISOString(), tokens };
}
