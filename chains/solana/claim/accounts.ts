import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { ClaimAccount, ClaimDiscoveryResult } from '../../../shared/transactions/types.js';
import type { RpcAccountInfo, SolanaRpc } from '../../../server/solana/rpc.js';

export const LEGACY_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_ACCOUNT_SIZE = 165;

export function claimAccountFingerprint(address: string, account: RpcAccountInfo) {
  return createHash('sha256').update(`${address}:${account.owner}:${account.lamports}:${account.data[0]}`).digest('hex');
}

function publicKeyAt(data: Buffer, offset: number) { return new PublicKey(data.subarray(offset, offset + 32)).toBase58(); }
function optionAt(data: Buffer, offset: number) { return data.readUInt32LE(offset); }

export function inspectClaimAccount(address: string, account: RpcAccountInfo, walletAddress: string): ClaimAccount {
  const base = { address, tokenProgram: account.owner, tokenAmountRaw: '0', recoverableLamports: String(account.lamports), stateFingerprint: claimAccountFingerprint(address, account) };
  let data: Buffer;
  try { data = Buffer.from(account.data[0], 'base64'); }
  catch { return { ...base, mint: '', eligible: false, reason: 'This token account has unexpected data.' }; }
  const mint = data.length >= 32 ? publicKeyAt(data, 0) : '';
  if (account.owner === TOKEN_2022_PROGRAM_ID) return { ...base, mint, eligible: false, reason: 'Token-2022 accounts are not supported yet.' };
  if (account.owner !== LEGACY_TOKEN_PROGRAM_ID) return { ...base, mint, eligible: false, reason: 'This account uses an unsupported token program.' };
  if (data.length !== TOKEN_ACCOUNT_SIZE) return { ...base, mint, eligible: false, reason: 'This token account has unexpected data.' };
  const owner = publicKeyAt(data, 32);
  const amount = data.readBigUInt64LE(64);
  const delegateOption = optionAt(data, 72);
  const state = data[108];
  const nativeOption = optionAt(data, 109);
  const delegatedAmount = data.readBigUInt64LE(121);
  const closeAuthorityOption = optionAt(data, 129);
  const result = { ...base, mint, tokenAmountRaw: amount.toString() };
  if (owner !== walletAddress) return { ...result, eligible: false, reason: 'The connected wallet does not own this token account.' };
  if (amount !== 0n) return { ...result, eligible: false, reason: 'This token account still contains tokens.' };
  if (state === 2) return { ...result, eligible: false, reason: 'Frozen token accounts cannot be cleaned.' };
  if (state !== 1) return { ...result, eligible: false, reason: 'This token account is not initialized.' };
  if (delegateOption !== 0 || delegatedAmount !== 0n) return { ...result, eligible: false, reason: 'Delegated token accounts are not supported yet.' };
  if (nativeOption !== 0) return { ...result, eligible: false, reason: 'Wrapped SOL accounts are not supported in this safe path yet.' };
  if (closeAuthorityOption !== 0) return { ...result, eligible: false, reason: 'Accounts with a separate close authority are not supported yet.' };
  if (!Number.isSafeInteger(account.lamports) || account.lamports <= 0) return { ...result, eligible: false, reason: 'This account has no recoverable SOL.' };
  return { ...result, eligible: true };
}

export async function discoverClaimAccounts(rpc: SolanaRpc, walletAddress: string): Promise<ClaimDiscoveryResult> {
  new PublicKey(walletAddress);
  const [legacy, token2022, walletBalanceLamports] = await Promise.all([
    rpc.getTokenAccountsByOwner(walletAddress, LEGACY_TOKEN_PROGRAM_ID),
    rpc.getTokenAccountsByOwner(walletAddress, TOKEN_2022_PROGRAM_ID),
    rpc.getBalance(walletAddress),
  ]);
  const accounts = [...legacy, ...token2022]
    .map(({ pubkey, account }) => inspectClaimAccount(pubkey, account, walletAddress))
    .sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  return {
    walletAddress,
    network: 'devnet',
    scannedAt: new Date().toISOString(),
    walletBalanceLamports: String(walletBalanceLamports),
    accounts,
    eligibleAccounts: accounts.filter((account) => account.eligible),
    skippedAccounts: accounts.filter((account) => !account.eligible),
  };
}

export function batchClaimAccounts(accounts: ClaimAccount[], maximum: number) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('claim batch maximum must be positive');
  const ordered = [...accounts].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  return Array.from({ length: Math.ceil(ordered.length / maximum) }, (_, index) => ordered.slice(index * maximum, (index + 1) * maximum));
}
