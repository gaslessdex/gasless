import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { BurnAccount, BurnDiscoveryResult } from '../../../shared/transactions/types.js';
import type { RpcAccountInfo, SolanaRpc } from '../../../server/solana/rpc.js';
import { LEGACY_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../claim/accounts.js';

const TOKEN_ACCOUNT_SIZE = 165;
const MINT_ACCOUNT_SIZE = 82;

function publicKeyAt(data: Buffer, offset: number) { return new PublicKey(data.subarray(offset, offset + 32)).toBase58(); }
function optionAt(data: Buffer, offset: number) { return data.readUInt32LE(offset); }

export function readLegacyMint(account: RpcAccountInfo | null) {
  if (!account || account.owner !== LEGACY_TOKEN_PROGRAM_ID) return null;
  let data: Buffer;
  try { data = Buffer.from(account.data[0], 'base64'); } catch { return null; }
  if (data.length !== MINT_ACCOUNT_SIZE || data[45] !== 1) return null;
  return { supplyRaw: data.readBigUInt64LE(36).toString(), decimals: data[44] };
}

export function inspectBurnAccount(address: string, account: RpcAccountInfo, walletAddress: string, mintAccount: RpcAccountInfo | null): BurnAccount {
  let data: Buffer;
  try { data = Buffer.from(account.data[0], 'base64'); }
  catch { data = Buffer.alloc(0); }
  const mint = data.length >= 32 ? publicKeyAt(data, 0) : '';
  const mintInfo = readLegacyMint(mintAccount);
  const base = {
    address, mint, tokenProgram: account.owner, tokenAmountRaw: data.length >= 72 ? data.readBigUInt64LE(64).toString() : '0',
    decimals: mintInfo?.decimals ?? 0, recoverableLamports: String(account.lamports), mintSupplyRaw: mintInfo?.supplyRaw ?? '0',
    stateFingerprint: createHash('sha256').update(`${address}:${account.owner}:${account.lamports}:${account.data[0]}:${mintAccount?.owner ?? ''}:${mintAccount?.data[0] ?? ''}`).digest('hex'),
  };
  if (account.owner === TOKEN_2022_PROGRAM_ID) return { ...base, eligible: false, reason: 'This token uses features Burn does not support yet.' };
  if (account.owner !== LEGACY_TOKEN_PROGRAM_ID || data.length !== TOKEN_ACCOUNT_SIZE) return { ...base, eligible: false, reason: 'This token account is not supported.' };
  if (!mintInfo || mintInfo.decimals < 1) return { ...base, eligible: false, reason: 'This asset is not an ordinary fungible token supported by Burn.' };
  const owner = publicKeyAt(data, 32);
  const amount = data.readBigUInt64LE(64);
  if (owner !== walletAddress) return { ...base, eligible: false, reason: 'The connected wallet does not control this token account.' };
  if (amount === 0n) return { ...base, eligible: false, reason: 'This token account has no balance to burn.' };
  if (data[108] === 2) return { ...base, eligible: false, reason: 'Frozen token accounts cannot be burned.' };
  if (data[108] !== 1) return { ...base, eligible: false, reason: 'This token account is not ready to burn.' };
  if (optionAt(data, 72) !== 0 || data.readBigUInt64LE(121) !== 0n) return { ...base, eligible: false, reason: 'Delegated token accounts are not supported.' };
  if (optionAt(data, 109) !== 0) return { ...base, eligible: false, reason: 'Wrapped SOL cannot be burned.' };
  if (optionAt(data, 129) !== 0) return { ...base, eligible: false, reason: 'This token account has a separate closing authority.' };
  if (!Number.isSafeInteger(account.lamports) || account.lamports <= 0) return { ...base, eligible: false, reason: 'This token account has no SOL to recover.' };
  return { ...base, eligible: true };
}

export async function discoverBurnAccounts(rpc: SolanaRpc, walletAddress: string): Promise<BurnDiscoveryResult> {
  new PublicKey(walletAddress);
  const [legacy, token2022, walletBalanceLamports] = await Promise.all([
    rpc.getTokenAccountsByOwner(walletAddress, LEGACY_TOKEN_PROGRAM_ID),
    rpc.getTokenAccountsByOwner(walletAddress, TOKEN_2022_PROGRAM_ID),
    rpc.getBalance(walletAddress),
  ]);
  const raw = [...legacy, ...token2022];
  const mints = [...new Set(raw.map(({ account }) => {
    try { const data = Buffer.from(account.data[0], 'base64'); return data.length >= 32 ? publicKeyAt(data, 0) : ''; } catch { return ''; }
  }).filter(Boolean))];
  const mintAccounts = await rpc.getMultipleAccounts(mints);
  const byMint = new Map(mints.map((mint, index) => [mint, mintAccounts[index]]));
  const accounts = raw.map(({ pubkey, account }) => {
    let mint = ''; try { const data = Buffer.from(account.data[0], 'base64'); if (data.length >= 32) mint = publicKeyAt(data, 0); } catch { /* rejected below */ }
    return inspectBurnAccount(pubkey, account, walletAddress, byMint.get(mint) ?? null);
  }).sort((a, b) => a.address.localeCompare(b.address));
  return { walletAddress, network: 'devnet', scannedAt: new Date().toISOString(), walletBalanceLamports: String(walletBalanceLamports), accounts, eligibleAccounts: accounts.filter((a) => a.eligible), skippedAccounts: accounts.filter((a) => !a.eligible) };
}
