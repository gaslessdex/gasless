import { PublicKey } from '@solana/web3.js';
import type { SendToken } from '../../../shared/transactions/types.js';
import type { RpcAccountInfo, SolanaRpc } from '../../../server/solana/rpc.js';
import type { TokenRegistryEntry } from '../../../server/token-registry/service.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';

export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_ACCOUNT_SIZE = 165;

export function deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram = LEGACY_TOKEN_PROGRAM_ID) {
  const ownerKey = new PublicKey(owner); const mintKey = new PublicKey(mint); const programKey = new PublicKey(tokenProgram);
  return PublicKey.findProgramAddressSync([ownerKey.toBuffer(), programKey.toBuffer(), mintKey.toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))[0].toBase58();
}

export function inspectSendTokenAccount(address: string, account: RpcAccountInfo | null, walletAddress: string, entry: TokenRegistryEntry): SendToken | null {
  if (!account || account.owner !== LEGACY_TOKEN_PROGRAM_ID || entry.tokenProgram !== LEGACY_TOKEN_PROGRAM_ID || entry.extensions.length) return null;
  let data: Buffer; try { data = Buffer.from(account.data[0], 'base64'); } catch { return null; }
  if (data.length !== TOKEN_ACCOUNT_SIZE || new PublicKey(data.subarray(0, 32)).toBase58() !== entry.mint || new PublicKey(data.subarray(32, 64)).toBase58() !== walletAddress) return null;
  if (data[108] !== 1 || data.readUInt32LE(72) !== 0 || data.readBigUInt64LE(121) !== 0n || data.readUInt32LE(109) !== 0 || data.readUInt32LE(129) !== 0) return null;
  return { mint: entry.mint, symbol: entry.symbol, decimals: entry.decimals, tokenProgram: entry.tokenProgram, balanceRaw: data.readBigUInt64LE(64).toString(), sourceAccount: address };
}

export function validateDestinationAccount(account: RpcAccountInfo | null, recipientWallet: string, mint: string, expectedAddress: string) {
  if (!account) return false;
  if (account.owner !== LEGACY_TOKEN_PROGRAM_ID) throw new Error('destination token program mismatch');
  let data: Buffer; try { data = Buffer.from(account.data[0], 'base64'); } catch { throw new Error('destination account malformed'); }
  if (data.length !== TOKEN_ACCOUNT_SIZE || new PublicKey(data.subarray(0, 32)).toBase58() !== mint || new PublicKey(data.subarray(32, 64)).toBase58() !== recipientWallet || data[108] !== 1 || deriveAssociatedTokenAddress(recipientWallet, mint) !== expectedAddress) throw new Error('destination account invalid');
  return true;
}

export async function discoverSendTokens(rpc: SolanaRpc, walletAddress: string, entries: TokenRegistryEntry[]) {
  new PublicKey(walletAddress);
  const tokens: SendToken[] = [];
  for (const entry of entries) {
    const source = deriveAssociatedTokenAddress(walletAddress, entry.mint, entry.tokenProgram);
    const inspected = inspectSendTokenAccount(source, await rpc.getAccountInfo(source), walletAddress, entry);
    if (inspected && BigInt(inspected.balanceRaw) > 0n) tokens.push(inspected);
  }
  return { walletAddress, network: 'devnet' as const, scannedAt: new Date().toISOString(), tokens };
}
