import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, SystemInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { inspectBurnAccount, readLegacyMint } from '../chains/solana/burn/accounts.js';
import { buildBurnTransaction, calculateBurnFee, calculateBurnNet } from '../chains/solana/transactions/burn.js';
import { LEGACY_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../chains/solana/claim/accounts.js';
import { BurnEngine } from '../server/burn/engine.js';
import { EmergencyControlService } from '../server/controls/service.js';
import { GaslessError } from '../server/errors.js';
import { LocalDevnetRelayerProvider } from '../server/relayer/provider.js';
import type { RpcAccountInfo, SolanaRpc } from '../server/solana/rpc.js';
import { MemoryDurableStore } from '../server/storage/durable.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';

function mintAccount(options: { decimals?: number; supply?: bigint; program?: string; initialized?: boolean; malformed?: boolean } = {}): RpcAccountInfo {
  const data = Buffer.alloc(options.malformed ? 10 : 82);
  if (!options.malformed) { data.writeBigUInt64LE(options.supply ?? 1_000_000_000n, 36); data[44] = options.decimals ?? 6; data[45] = options.initialized === false ? 0 : 1; }
  return { lamports: 1_461_600, owner: options.program ?? LEGACY_TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, data: [data.toString('base64'), 'base64'] };
}

function tokenAccount(wallet: PublicKey, mint: PublicKey, options: { amount?: bigint; state?: number; delegate?: boolean; native?: boolean; closeAuthority?: boolean; program?: string; lamports?: number; malformed?: boolean } = {}): RpcAccountInfo {
  const data = Buffer.alloc(options.malformed ? 10 : 165);
  if (!options.malformed) { mint.toBuffer().copy(data, 0); wallet.toBuffer().copy(data, 32); data.writeBigUInt64LE(options.amount ?? 123_456_789n, 64); data.writeUInt32LE(options.delegate ? 1 : 0, 72); if (options.delegate) Keypair.generate().publicKey.toBuffer().copy(data, 76); data[108] = options.state ?? 1; data.writeUInt32LE(options.native ? 1 : 0, 109); data.writeBigUInt64LE(options.delegate ? 1n : 0n, 121); data.writeUInt32LE(options.closeAuthority ? 1 : 0, 129); }
  return { lamports: options.lamports ?? 2_039_280, owner: options.program ?? LEGACY_TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, data: [data.toString('base64'), 'base64'] };
}

class FakeBurnRpc {
  readonly tokenAddress = Keypair.generate().publicKey.toBase58(); readonly mint = Keypair.generate().publicKey; readonly token: RpcAccountInfo; readonly mintBefore: RpcAccountInfo;
  sent?: string; sends = 0; fee = 42_500; blockHeight = 10; failFinal = false; pending = false; unreadableHeight = false; simulations = 0; mismatchPayout = false; leaveOpen = false; wrongSupply = false;
  constructor(readonly wallet: Keypair) { this.token = tokenAccount(wallet.publicKey, this.mint); this.mintBefore = mintAccount(); }
  async getTokenAccountsByOwner(_owner: string, program: string) { return program === LEGACY_TOKEN_PROGRAM_ID ? [{ pubkey: this.tokenAddress, account: this.token }] : []; }
  async getMultipleAccounts(addresses: string[]) { return addresses.map((address) => address === this.tokenAddress ? this.token : address === this.mint.toBase58() ? this.mintBefore : null); }
  async getAccountInfo(address: string) { if (address === this.tokenAddress) return this.sent && !this.leaveOpen ? null : this.token; if (address === this.mint.toBase58()) { const before = readLegacyMint(this.mintBefore)!; return mintAccount({ supply: BigInt(before.supplyRaw) - (this.wrongSupply ? 1n : 123_456_789n) }); } return null; }
  async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200, provider: 'fake' }; }
  async getBlockHeight() { return this.blockHeight; } async getFeeForMessage() { return this.fee; }
  async simulateTransaction() { this.simulations += 1; return { err: this.failFinal && this.simulations > 1 ? { failed: true } : null, logs: ['ok'], unitsConsumed: 200, provider: 'fake' }; }
  async getBalance() { return 10_000_000; } async sendRawTransaction(serialized: string) { this.sent = serialized; this.sends += 1; return { signature: 'burn-devnet-signature', provider: 'fake' }; }
  async getSignatureStatuses() { return this.pending || !this.sent ? null : { slot: 8, confirmations: 1, err: null, confirmationStatus: 'confirmed' }; }
  async getBlockHeightsAcrossProviders() { return this.unreadableHeight ? [{ provider: 'fake', errorCategory: 'rpc_error' as const }] : [{ provider: 'fake', value: await this.getBlockHeight() }]; }
  async broadcastRawTransactionAcrossProviders(serialized: string) { this.sent = serialized; this.sends += 1; return [{ provider: 'fake', category: 'accepted' as const }]; }
  async getSignatureStatusesAcrossProviders() { return [{ provider: 'fake', value: this.pending || !this.sent ? null : { slot: 8, confirmations: 1, err: null, confirmationStatus: 'confirmed' as const } }]; }
  async getTransactionAcrossProviders() { return this.getTransaction(); }
  async getTransaction() { const transaction = VersionedTransaction.deserialize(Buffer.from(this.sent!, 'base64')); const message = TransactionMessage.decompile(transaction.message); const keys = transaction.message.staticAccountKeys.map((key) => key.toBase58()); const transfer = message.instructions.map((instruction) => { try { return SystemInstruction.decodeTransfer(instruction); } catch { return null; } }).find(Boolean)!; const settlement = BigInt(transfer.lamports); const preBalances = keys.map(() => 10_000_000); const postBalances = [...preBalances]; const change = (address: string, value: bigint) => { const index = keys.indexOf(address); postBalances[index] = Number(BigInt(preBalances[index]) + value); }; change(this.wallet.publicKey.toBase58(), BigInt(this.token.lamports) - settlement + (this.mismatchPayout ? 1n : 0n)); change(transfer.toPubkey.toBase58(), settlement); change(keys[0], -BigInt(this.fee)); return { slot: 8, meta: { err: null, fee: this.fee, preBalances, postBalances }, transaction: { message: { accountKeys: keys } } }; }
}

function fixture() { const wallet = Keypair.generate(); const relayer = Keypair.generate(); const treasury = Keypair.generate(); const rpc = new FakeBurnRpc(wallet); const temporary = new MemoryTemporaryStore(); const durable = new MemoryDurableStore(); const releaseAttempts: string[] = []; const risk = { releaseTransactionExposure: async ({ transactionId }: { transactionId: string }) => { releaseAttempts.push(transactionId); return releaseAttempts.filter((id) => id === transactionId).length === 1 ? 'released' as const : 'already_released' as const; } }; const engine = new BurnEngine(temporary, durable, rpc as unknown as SolanaRpc, new LocalDevnetRelayerProvider(JSON.stringify([...relayer.secretKey])), new EmergencyControlService(durable), 120, { feeDestination: treasury.publicKey.toBase58(), feeBps: 300, minimumUserPayoutLamports: 1, maximumNetworkFeeLamports: 100_000, relayerLowBalanceThresholdLamports: 100_000 }, risk); return { wallet, relayer, treasury, rpc, temporary, durable, releaseAttempts, engine }; }
async function expectCode(action: () => Promise<unknown>, code: string) { await assert.rejects(action, (error: unknown) => error instanceof GaslessError && error.code === code); }

test('Burn eligibility fails closed outside ordinary owned fungible legacy SPL accounts', () => {
  const wallet = Keypair.generate(); const mint = Keypair.generate().publicKey; const address = Keypair.generate().publicKey.toBase58(); const goodMint = mintAccount();
  assert.equal(inspectBurnAccount(address, tokenAccount(wallet.publicKey, mint), wallet.publicKey.toBase58(), goodMint).eligible, true);
  for (const account of [tokenAccount(wallet.publicKey, mint, { amount: 0n }), tokenAccount(wallet.publicKey, mint, { state: 2 }), tokenAccount(wallet.publicKey, mint, { delegate: true }), tokenAccount(wallet.publicKey, mint, { native: true }), tokenAccount(wallet.publicKey, mint, { closeAuthority: true }), tokenAccount(Keypair.generate().publicKey, mint), tokenAccount(wallet.publicKey, mint, { program: TOKEN_2022_PROGRAM_ID }), tokenAccount(wallet.publicKey, mint, { malformed: true })]) assert.equal(inspectBurnAccount(address, account, wallet.publicKey.toBase58(), goodMint).eligible, false);
  assert.equal(inspectBurnAccount(address, tokenAccount(wallet.publicKey, mint), wallet.publicKey.toBase58(), mintAccount({ decimals: 0 })).eligible, false);
  assert.equal(inspectBurnAccount(address, tokenAccount(wallet.publicKey, mint), wallet.publicKey.toBase58(), mintAccount({ malformed: true })).eligible, false);
});

test('Burn fee and payout use integer floor rounding', () => { assert.equal(calculateBurnFee(101n, 300), 3n); assert.equal(calculateBurnFee(2_039_280n, 300), 61_178n); assert.equal(calculateBurnNet(2_039_280n, 61_178n, 5_000n, 1n), 1_973_102n); assert.throws(() => calculateBurnNet(100n, 3n, 98n, 1n)); });

test('Burn transaction uses the authoritative full balance, mint, account, owner, close destination, treasury, and fee payer', () => {
  const f = fixture(); const inspected = inspectBurnAccount(f.rpc.tokenAddress, f.rpc.token, f.wallet.publicKey.toBase58(), f.rpc.mintBefore); const transaction = buildBurnTransaction({ account: inspected, walletAddress: f.wallet.publicKey.toBase58(), feePayer: f.relayer.publicKey.toBase58(), feeDestination: f.treasury.publicKey.toBase58(), blockhash: Keypair.generate().publicKey.toBase58(), settlementLamports: 66_178n });
  const message = TransactionMessage.decompile(transaction.message); assert.equal(transaction.version, 0); assert.equal(message.instructions.length, 5); assert.equal(message.instructions[2].data[0], 15); assert.equal(message.instructions[2].data.readBigUInt64LE(1), 123_456_789n); assert.equal(message.instructions[2].data[9], 6); assert.equal(message.instructions[2].keys[0].pubkey.toBase58(), f.rpc.tokenAddress); assert.equal(message.instructions[2].keys[1].pubkey.toBase58(), f.rpc.mint.toBase58()); assert.equal(message.instructions[2].keys[2].pubkey.toBase58(), f.wallet.publicKey.toBase58()); assert.equal(message.instructions[3].data[0], 9); const transfer = SystemInstruction.decodeTransfer(message.instructions[4]); assert.equal(transfer.toPubkey.toBase58(), f.treasury.publicKey.toBase58()); assert.equal(message.payerKey.toBase58(), f.relayer.publicKey.toBase58());
});

test('Burn lifecycle rejects mutation, burns once, closes, reconciles exact economics, and records accounting', async () => {
  const f = fixture(); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: f.rpc.tokenAddress, clientRequestId: 'quote', requestId: 'quote' }); const prepared = await f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'prepare'); const burn = prepared.burn!;
  assert.equal(burn.gaslessFeeLamports, '61178'); assert.equal(burn.sponsoredCostLamports, '42500'); assert.equal(burn.netUserLamports, '1935602');
  const changed = VersionedTransaction.deserialize(Buffer.from(burn.prepared!.serializedTransaction, 'base64')); changed.message.compiledInstructions[2].data[1] ^= 1; changed.sign([f.wallet]); await expectCode(() => f.engine.submit({ quoteId: quote.quoteId, walletAddress: f.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(changed.serialize()).toString('base64'), clientRequestId: 'bad', requestId: 'bad' }), 'MESSAGE_MISMATCH'); assert.equal(f.rpc.sent, undefined);
  const exact = VersionedTransaction.deserialize(Buffer.from(burn.prepared!.serializedTransaction, 'base64')); exact.sign([f.wallet]); const signed = Buffer.from(exact.serialize()).toString('base64'); const result = await f.engine.submit({ quoteId: quote.quoteId, walletAddress: f.wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'good', requestId: 'good' }); assert.equal(result.reconciliation.status, 'confirmed'); const duplicate = await f.engine.submit({ quoteId: quote.quoteId, walletAddress: f.wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'retry', requestId: 'retry' }); assert.equal(duplicate.alreadyCompleted, true); assert.ok([...f.durable.events.values()].some((event) => (event as { eventType?: string }).eventType === 'burn_succeeded'));
});

test('Burn exact-message binding rejects substituted account, mint, destination, fee, and burn amount', async () => {
  const f = fixture(); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: f.rpc.tokenAddress, clientRequestId: 'binding', requestId: 'binding' }); const prepared = await f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'binding-prepare'); const base = prepared.burn!.prepared!.serializedTransaction;
  const mutations = [
    (transaction: VersionedTransaction) => { transaction.message.compiledInstructions[2].accountKeyIndexes[0] = 0; },
    (transaction: VersionedTransaction) => { transaction.message.compiledInstructions[2].accountKeyIndexes[1] = 0; },
    (transaction: VersionedTransaction) => { transaction.message.compiledInstructions[2].data[1] ^= 1; },
    (transaction: VersionedTransaction) => { transaction.message.compiledInstructions[4].accountKeyIndexes[1] = 0; },
    (transaction: VersionedTransaction) => { transaction.message.compiledInstructions[4].data[4] ^= 1; },
  ];
  for (let index = 0; index < mutations.length; index += 1) { const transaction = VersionedTransaction.deserialize(Buffer.from(base, 'base64')); mutations[index](transaction); transaction.sign([f.wallet]); await expectCode(() => f.engine.submit({ quoteId: quote.quoteId, walletAddress: f.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(transaction.serialize()).toString('base64'), clientRequestId: `mutation-${index}`, requestId: `mutation-${index}` }), 'MESSAGE_MISMATCH'); }
  assert.equal(f.rpc.sends, 0);
});

test('Burn retry after an ambiguous submission never broadcasts twice', async () => {
  const f = fixture(); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: f.rpc.tokenAddress, clientRequestId: 'pending', requestId: 'pending' }); const prepared = await f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'pending-prepare'); const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.burn!.prepared!.serializedTransaction, 'base64')); transaction.sign([f.wallet]); const signed = Buffer.from(transaction.serialize()).toString('base64'); f.rpc.pending = true;
  await expectCode(() => f.engine.submit({ quoteId: quote.quoteId, walletAddress: f.wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'pending-submit', requestId: 'pending-submit' }), 'RECONCILIATION_FAILED');
  const broadcastRounds = f.rpc.sends;
  assert.equal(broadcastRounds, 3);
  f.rpc.pending = false;
  const resumed = await f.engine.submit({ quoteId: quote.quoteId, walletAddress: f.wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'pending-retry', requestId: 'pending-retry' });
  assert.equal(resumed.reconciliation.status, 'confirmed');
  assert.equal(f.rpc.sends, broadcastRounds);
});

test('Burn never broadcasts when the safety-floor blockheight cannot be verified', async () => {
  const f = fixture(); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: f.rpc.tokenAddress, clientRequestId: 'height', requestId: 'height' }); const prepared = await f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'height-prepare'); const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.burn!.prepared!.serializedTransaction, 'base64')); transaction.sign([f.wallet]); f.rpc.unreadableHeight = true;
  await expectCode(() => f.engine.submit({ quoteId: quote.quoteId, walletAddress: f.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(transaction.serialize()).toString('base64'), clientRequestId: 'height-submit', requestId: 'height-submit' }), 'RECONCILIATION_FAILED');
  assert.equal(f.rpc.sends, 0);
});

test('Burn wallet cancellation and stale pre-wallet gates release once while signed ambiguity stays reserved', async () => {
  const cancelled = fixture(); const cq = await cancelled.engine.createQuote({ walletAddress: cancelled.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: cancelled.rpc.tokenAddress, clientRequestId: 'cancel', requestId: 'cancel' }); await cancelled.engine.prepare(cq.quoteId, cancelled.wallet.publicKey.toBase58(), 'cancel-prepare');
  await cancelled.engine.abortWalletApproval(cq.quoteId, cancelled.wallet.publicKey.toBase58(), 'USER_EXPLICITLY_CANCELLED', false);
  await cancelled.engine.abortWalletApproval(cq.quoteId, cancelled.wallet.publicKey.toBase58(), 'USER_EXPLICITLY_CANCELLED', false);
  assert.equal(cancelled.releaseAttempts.length, 1);

  const signed = fixture(); const sq = await signed.engine.createQuote({ walletAddress: signed.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: signed.rpc.tokenAddress, clientRequestId: 'signed-abort', requestId: 'signed-abort' }); const sp = await signed.engine.prepare(sq.quoteId, signed.wallet.publicKey.toBase58(), 'signed-abort-prepare'); signed.rpc.blockHeight = sp.burn!.prepared!.lastValidBlockHeight - 29;
  await signed.engine.abortWalletApproval(sq.quoteId, signed.wallet.publicKey.toBase58(), 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', true);
  assert.equal(signed.releaseAttempts.length, 0);

  const stale = fixture(); const tq = await stale.engine.createQuote({ walletAddress: stale.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: stale.rpc.tokenAddress, clientRequestId: 'stale-gate', requestId: 'stale-gate' }); const tp = await stale.engine.prepare(tq.quoteId, stale.wallet.publicKey.toBase58(), 'stale-gate-prepare'); stale.rpc.blockHeight = tp.burn!.prepared!.lastValidBlockHeight - 99;
  await expectCode(() => stale.engine.currentWalletGateBlockHeight(tq.quoteId, stale.wallet.publicKey.toBase58()), 'QUOTE_EXPIRED');
  assert.equal(stale.releaseAttempts.length, 1);
});

test('Burn fails closed for malformed selection, stale state, missing signature, final simulation failure, and reconciliation mismatch', async () => {
  const malformed = fixture(); await expectCode(() => malformed.engine.createQuote({ walletAddress: malformed.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: 'bad', clientRequestId: 'bad', requestId: 'bad' }), 'INVALID_REQUEST');
  const stale = fixture(); const staleQuote = await stale.engine.createQuote({ walletAddress: stale.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: stale.rpc.tokenAddress, clientRequestId: 'stale', requestId: 'stale' }); stale.rpc.token.lamports += 1; await expectCode(() => stale.engine.prepare(staleQuote.quoteId, stale.wallet.publicKey.toBase58(), 'stale-prepare'), 'MESSAGE_MISMATCH');
  const unsigned = fixture(); const uq = await unsigned.engine.createQuote({ walletAddress: unsigned.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: unsigned.rpc.tokenAddress, clientRequestId: 'u', requestId: 'u' }); const up = await unsigned.engine.prepare(uq.quoteId, unsigned.wallet.publicKey.toBase58(), 'up'); await expectCode(() => unsigned.engine.submit({ quoteId: uq.quoteId, walletAddress: unsigned.wallet.publicKey.toBase58(), signedTransaction: up.burn!.prepared!.serializedTransaction, clientRequestId: 'us', requestId: 'us' }), 'USER_SIGNATURE_INVALID');
  const simulation = fixture(); const sq = await simulation.engine.createQuote({ walletAddress: simulation.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: simulation.rpc.tokenAddress, clientRequestId: 's', requestId: 's' }); const sp = await simulation.engine.prepare(sq.quoteId, simulation.wallet.publicKey.toBase58(), 'sp'); const st = VersionedTransaction.deserialize(Buffer.from(sp.burn!.prepared!.serializedTransaction, 'base64')); st.sign([simulation.wallet]); simulation.rpc.failFinal = true; await expectCode(() => simulation.engine.submit({ quoteId: sq.quoteId, walletAddress: simulation.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(st.serialize()).toString('base64'), clientRequestId: 'ss', requestId: 'ss' }), 'SIMULATION_FAILED'); assert.equal(simulation.rpc.sent, undefined); assert.equal(simulation.releaseAttempts.length, 1);
  const mismatch = fixture(); const mq = await mismatch.engine.createQuote({ walletAddress: mismatch.wallet.publicKey.toBase58(), network: 'devnet', tokenAccount: mismatch.rpc.tokenAddress, clientRequestId: 'm', requestId: 'm' }); const mp = await mismatch.engine.prepare(mq.quoteId, mismatch.wallet.publicKey.toBase58(), 'mp'); const mt = VersionedTransaction.deserialize(Buffer.from(mp.burn!.prepared!.serializedTransaction, 'base64')); mt.sign([mismatch.wallet]); mismatch.rpc.mismatchPayout = true; await expectCode(() => mismatch.engine.submit({ quoteId: mq.quoteId, walletAddress: mismatch.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(mt.serialize()).toString('base64'), clientRequestId: 'ms', requestId: 'ms' }), 'RECONCILIATION_FAILED');
});
