import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../chains/solana/claim/accounts.js';
import { deriveAssociatedTokenAddress, discoverSendTokens } from '../chains/solana/send/accounts.js';
import { discoverSwapTokens } from '../chains/solana/swap/accounts.js';
import type { RpcAccountInfo, SolanaRpc } from '../server/solana/rpc.js';
import type { TokenRegistryEntry } from '../server/token-registry/service.js';

function tokenAccount(owner: string, mint: string, amount: bigint): RpcAccountInfo {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { lamports: 2_039_280, owner: LEGACY_TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, data: [data.toString('base64'), 'base64'] };
}

function entries(count: number): TokenRegistryEntry[] {
  return Array.from({ length: count }, (_, index) => ({ mint: Keypair.generate().publicKey.toBase58(), symbol: `T${index}`, name: `Token ${index}`, decimals: 6, tokenProgram: LEGACY_TOKEN_PROGRAM_ID, extensions: [], status: 'supported', enabledActions: ['SEND', 'SWAP'], feePaymentEnabled: true, swapInputEnabled: true, swapOutputEnabled: true }));
}

class BatchedRpc {
  calls: string[] = [];
  accounts = new Map<string, RpcAccountInfo>();
  async getTokenAccountsByOwner(owner: string, programId: string) {
    this.calls.push(`getTokenAccountsByOwner:${programId}`);
    return [...this.accounts].filter(([, account]) => account.owner === programId && new PublicKey(Buffer.from(account.data[0], 'base64').subarray(32, 64)).toBase58() === owner).map(([pubkey, account]) => ({ pubkey, account }));
  }
  async getAccountInfo() { this.calls.push('getAccountInfo'); return null; }
}

test('Send hydrates a large supported directory with two owner-account RPC calls', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const catalog = entries(120);
  const rpc = new BatchedRpc();
  const held = catalog[73]!;
  rpc.accounts.set(deriveAssociatedTokenAddress(wallet, held.mint), tokenAccount(wallet, held.mint, 42n));
  const result = await discoverSendTokens(rpc as unknown as SolanaRpc, wallet, catalog);
  assert.equal(result.tokens.length, 120);
  assert.equal(result.tokens.find((token) => token.mint === held.mint)?.balanceRaw, '42');
  assert.equal(result.tokens.filter((token) => token.balanceRaw === '0').length, 119);
  assert.equal(rpc.calls.filter((call) => call.startsWith('getTokenAccountsByOwner:')).length, 2);
  assert.equal(rpc.calls.includes('getAccountInfo'), false);
});

test('Swap hydrates full input and output catalogs without per-mint account RPCs', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const catalog = entries(90);
  const rpc = new BatchedRpc();
  const held = catalog[11]!;
  rpc.accounts.set(deriveAssociatedTokenAddress(wallet, held.mint), tokenAccount(wallet, held.mint, 99n));
  const result = await discoverSwapTokens(rpc as unknown as SolanaRpc, wallet, catalog);
  assert.equal(result.inputTokens.length, 90);
  assert.equal(result.outputTokens.length, 90);
  assert.equal(result.inputTokens.find((token) => token.mint === held.mint)?.balanceRaw, '99');
  assert.equal(result.outputTokens.find((token) => token.mint === held.mint)?.outputAtaExists, true);
  assert.equal(rpc.calls.length, 2);
});
