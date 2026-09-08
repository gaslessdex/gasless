import type { RecoverAccount, RecoverDiscoveryResult } from '../../../shared/transactions/types.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import type { TokenRegistry } from '../../../server/token-registry/service.js';
import { discoverBurnAccounts } from '../burn/accounts.js';
import { PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '../../../server/jupiter/service.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { WRAPPED_SOL_MINT, wrappedSolAccount } from '../../../server/jupiter/service.js';
import { createHash } from 'node:crypto';
import type { RpcAccountInfo } from '../../../server/solana/rpc.js';

export function recoverSourceAccount(wallet: string, mint: string) {
  return PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(), new PublicKey(LEGACY_TOKEN_PROGRAM_ID).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))[0].toBase58();
}

export function inspectRecoverWrappedSol(walletAddress: string, account: RpcAccountInfo | null) {
  const address = wrappedSolAccount(walletAddress);
  if (!account) return { address, exists: false, lamports: '0', amountRaw: '0', stateFingerprint: createHash('sha256').update(`${address}:absent`).digest('hex') };
  let data: Buffer; try { data = Buffer.from(account.data[0], 'base64'); } catch { data = Buffer.alloc(0); }
  const unsafe = account.owner !== LEGACY_TOKEN_PROGRAM_ID || data.length !== 165 || new PublicKey(data.subarray(0, 32)).toBase58() !== WRAPPED_SOL_MINT || new PublicKey(data.subarray(32, 64)).toBase58() !== walletAddress || data.readBigUInt64LE(64) !== 0n || data.readUInt32LE(72) !== 0 || data[108] !== 1 || data.readUInt32LE(109) !== 1 || data.readUInt32LE(129) !== 0 || data.readBigUInt64LE(121) !== 0n || BigInt(account.lamports) !== data.readBigUInt64LE(113);
  if (unsafe) throw new Error('Canonical wrapped SOL account state is not safe for Recover Value.');
  return { address, exists: true, lamports: String(account.lamports), amountRaw: '0', stateFingerprint: createHash('sha256').update(`${address}:${account.owner}:${account.lamports}:${account.data[0]}`).digest('hex') };
}

export async function readRecoverWrappedSol(rpc: SolanaRpc, walletAddress: string) { return inspectRecoverWrappedSol(walletAddress, await rpc.getAccountInfo(wrappedSolAccount(walletAddress))); }

export async function discoverRecoverAccounts(rpc: SolanaRpc, registry: TokenRegistry, walletAddress: string): Promise<RecoverDiscoveryResult> {
  const discovered = await discoverBurnAccounts(rpc, walletAddress);
  const accounts: RecoverAccount[] = await Promise.all(discovered.accounts.map(async (account) => {
    if (!account.eligible) return { ...account, reason: account.reason?.replaceAll('Burn', 'Recover Value') };
    if (account.address !== recoverSourceAccount(walletAddress, account.mint)) return { ...account, eligible: false, reason: 'Recover Value V1 supports the wallet’s canonical token account only.' };
    const recover = await registry.evaluate('CLEAN_RECOVER', account.mint);
    if (recover.decision !== 'supported') return { ...account, eligible: false, reason: 'This exact mint is not enabled for Recover Value.' };
    const token = recover.entry;
    if (!token || token.mint !== account.mint || token.tokenProgram !== account.tokenProgram || token.decimals !== account.decimals) return { ...account, eligible: false, reason: 'This token account does not match the exact Recover Value registry identity.' };
    return { ...account, symbol: token.symbol, name: token.name, image: token.image };
  }));
  return { walletAddress, network: 'devnet', scannedAt: new Date().toISOString(), accounts, eligibleAccounts: accounts.filter((account) => account.eligible), skippedAccounts: accounts.filter((account) => !account.eligible) };
}
