import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, SystemInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { batchClaimAccounts, inspectClaimAccount, LEGACY_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../chains/solana/claim/accounts.js';
import { buildClaimTransaction, calculateClaimFee, calculateClaimNet, validateSignedClaim } from '../chains/solana/transactions/claim.js';
import { ClaimEngine } from '../server/claim/engine.js';
import { EmergencyControlService } from '../server/controls/service.js';
import { GaslessError } from '../server/errors.js';
import { LocalDevnetRelayerProvider } from '../server/relayer/provider.js';
import type { RpcAccountInfo, SolanaRpc } from '../server/solana/rpc.js';
import { MemoryDurableStore } from '../server/storage/durable.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';
import type { ClaimAccount } from '../shared/transactions/types.js';

function tokenAccount(wallet: PublicKey, options: { amount?: bigint; state?: number; delegate?: boolean; native?: boolean; closeAuthority?: PublicKey; program?: string; lamports?: number; malformed?: boolean } = {}): RpcAccountInfo {
  const data = Buffer.alloc(options.malformed ? 10 : 165);
  if (!options.malformed) {
    Keypair.generate().publicKey.toBuffer().copy(data, 0);
    wallet.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(options.amount ?? 0n, 64);
    data.writeUInt32LE(options.delegate ? 1 : 0, 72);
    if (options.delegate) Keypair.generate().publicKey.toBuffer().copy(data, 76);
    data[108] = options.state ?? 1;
    data.writeUInt32LE(options.native ? 1 : 0, 109);
    data.writeBigUInt64LE(options.delegate ? 1n : 0n, 121);
    data.writeUInt32LE(options.closeAuthority ? 1 : 0, 129);
    options.closeAuthority?.toBuffer().copy(data, 133);
  }
  return { lamports: options.lamports ?? 2_039_280, owner: options.program ?? LEGACY_TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, data: [data.toString('base64'), 'base64'] };
}

class FakeClaimRpc {
  readonly wallet: Keypair;
  readonly tokenAddress: string;
  readonly account: RpcAccountInfo;
  sent?: string;
  broadcastBytes: string[] = [];
  broadcastMode: 'both_accept' | 'primary_fails' | 'primary_timeout' | 'already_processed' = 'both_accept';
  secondaryUnavailable = false;
  providerStatuses?: [FakeClaimRpc['signatureStatus'], FakeClaimRpc['signatureStatus']];
  confirmAfterStatusReads?: number;
  expireAfterBroadcast = false;
  statusReads = 0;
  failSimulation = false;
  leaveAccountOpen = false;
  mismatchPayout = false;
  signatureStatus: { slot: number; confirmations: number; err: null; confirmationStatus: string } | null = { slot: 7, confirmations: 1, err: null, confirmationStatus: 'confirmed' };
  blockHeight = 10;
  fee = 42_500;
  constructor(wallet: Keypair) {
    this.wallet = wallet;
    this.tokenAddress = Keypair.generate().publicKey.toBase58();
    this.account = tokenAccount(wallet.publicKey);
  }
  async getTokenAccountsByOwner(_owner: string, program: string) { return program === LEGACY_TOKEN_PROGRAM_ID ? [{ pubkey: this.tokenAddress, account: this.account }] : []; }
  async getMultipleAccounts(addresses: string[]) { return addresses.map((address) => this.sent && address === this.tokenAddress && !this.leaveAccountOpen ? null : address === this.tokenAddress ? this.account : null); }
  async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200, provider: 'fake' }; }
  async getBlockHeight() { return this.blockHeight; }
  async getFeeForMessage() { return this.fee; }
  async simulateTransaction() { return { err: this.failSimulation ? { test: true } : null, logs: ['ok'], unitsConsumed: 100, provider: 'fake' }; }
  async getBalance() { return 10_000_000; }
  async sendRawTransaction(serialized: string) { this.sent = serialized; return { signature: 'claim-devnet-signature', provider: 'fake' }; }
  async getSignatureStatuses() { return this.signatureStatus; }
  async broadcastRawTransactionAcrossProviders(serialized: string) {
    this.sent = serialized; this.broadcastBytes.push(serialized);
    const transaction = VersionedTransaction.deserialize(Buffer.from(serialized, 'base64'));
    const signature = bs58.encode(transaction.signatures[0]);
    if (this.broadcastMode === 'primary_fails') return [{ provider: 'helius', category: 'rpc_error' as const }, { provider: 'fallback', category: 'accepted' as const, returnedSignature: signature }];
    if (this.broadcastMode === 'primary_timeout') return [{ provider: 'helius', category: 'timeout' as const }, { provider: 'fallback', category: 'accepted' as const, returnedSignature: signature }];
    if (this.broadcastMode === 'already_processed') return [{ provider: 'helius', category: 'already_processed' as const }, { provider: 'fallback', category: 'already_processed' as const }];
    return [{ provider: 'helius', category: 'accepted' as const, returnedSignature: signature }, { provider: 'fallback', category: 'accepted' as const, returnedSignature: signature }];
  }
  async getSignatureStatusesAcrossProviders() {
    this.statusReads += 1;
    const confirmed = { slot: 7, confirmations: 1, err: null, confirmationStatus: 'confirmed' };
    const statuses = this.confirmAfterStatusReads !== undefined && this.statusReads >= this.confirmAfterStatusReads ? [confirmed, confirmed] : this.providerStatuses ?? [this.signatureStatus, this.signatureStatus];
    return this.secondaryUnavailable ? [{ provider: 'helius', value: statuses[0] }, { provider: 'fallback', errorCategory: 'rpc_error' as const }] : [{ provider: 'helius', value: statuses[0] }, { provider: 'fallback', value: statuses[1] }];
  }
  async getBlockHeightsAcrossProviders() { const height = this.expireAfterBroadcast && this.broadcastBytes.length ? 201 : this.blockHeight; return this.secondaryUnavailable ? [{ provider: 'helius', value: height }, { provider: 'fallback', errorCategory: 'rpc_error' as const }] : [{ provider: 'helius', value: height }, { provider: 'fallback', value: height }]; }
  async getTransactionAcrossProviders() { return this.getTransaction(); }
  async getTransaction() {
    const transaction = VersionedTransaction.deserialize(Buffer.from(this.sent!, 'base64'));
    const message = TransactionMessage.decompile(transaction.message);
    const keys = transaction.message.staticAccountKeys.map((key) => key.toBase58());
    const transfer = message.instructions.map((instruction) => { try { return SystemInstruction.decodeTransfer(instruction); } catch { return null; } }).find(Boolean)!;
    const settlement = BigInt(transfer.lamports);
    const gross = BigInt(this.account.lamports);
    const preBalances = keys.map(() => 10_000_000);
    const postBalances = [...preBalances];
    const change = (address: string, value: bigint) => { const index = keys.indexOf(address); postBalances[index] = Number(BigInt(preBalances[index]) + value); };
    change(this.wallet.publicKey.toBase58(), gross - settlement + (this.mismatchPayout ? 1n : 0n));
    change(transfer.toPubkey.toBase58(), settlement);
    change(keys[0], -BigInt(this.fee));
    return { slot: 7, meta: { err: null, fee: this.fee, preBalances, postBalances }, transaction: { message: { accountKeys: keys } } };
  }
}

function engineFixture() {
  const wallet = Keypair.generate();
  const relayer = Keypair.generate();
  const treasury = Keypair.generate();
  const rpc = new FakeClaimRpc(wallet);
  const temporary = new MemoryTemporaryStore();
  const durable = new MemoryDurableStore();
  const released = new Set<string>(); const releaseAttempts: string[] = [];
  const risk = { async releaseTransactionExposure(input: { transactionId: string }) { releaseAttempts.push(input.transactionId); if (released.has(input.transactionId)) return 'already_released' as const; released.add(input.transactionId); return 'released' as const; } };
  const engine = new ClaimEngine(temporary, durable, rpc as unknown as SolanaRpc, new LocalDevnetRelayerProvider(JSON.stringify([...relayer.secretKey])), new EmergencyControlService(durable), 120, { feeDestination: treasury.publicKey.toBase58(), feeBps: 300, minimumUserPayoutLamports: 1, maximumAccountsPerBatch: 10, maximumNetworkFeeLamports: 100_000, relayerLowBalanceThresholdLamports: 100_000 }, risk);
  return { wallet, relayer, treasury, rpc, temporary, durable, engine, released, releaseAttempts };
}

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof GaslessError && error.code === code);
}

async function prepareSignedClaim(fixture: ReturnType<typeof engineFixture>, id: string) {
  const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: `${id}-quote`, requestId: `${id}-quote` });
  const prepared = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), `${id}-prepare`);
  const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.claim!.batches[0].prepared!.serializedTransaction, 'base64'));
  transaction.sign([fixture.wallet]);
  return { quote, prepared, signedTransaction: Buffer.from(transaction.serialize()).toString('base64') };
}

test('Claim eligibility accepts only the conservative empty legacy SPL path', () => {
  const wallet = Keypair.generate();
  const address = Keypair.generate().publicKey.toBase58();
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey), wallet.publicKey.toBase58()).eligible, true);
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey, { amount: 1n }), wallet.publicKey.toBase58()).eligible, false);
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey, { state: 2 }), wallet.publicKey.toBase58()).reason, 'Frozen token accounts cannot be cleaned.');
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey, { delegate: true }), wallet.publicKey.toBase58()).eligible, false);
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey, { closeAuthority: Keypair.generate().publicKey }), wallet.publicKey.toBase58()).eligible, false);
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey, { native: true }), wallet.publicKey.toBase58()).eligible, false);
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey, { program: TOKEN_2022_PROGRAM_ID }), wallet.publicKey.toBase58()).eligible, false);
  assert.equal(inspectClaimAccount(address, tokenAccount(wallet.publicKey, { malformed: true }), wallet.publicKey.toBase58()).eligible, false);
  assert.equal(inspectClaimAccount(address, tokenAccount(Keypair.generate().publicKey), wallet.publicKey.toBase58()).eligible, false);
});

test('Claim economics use exact integer lamports with floor rounding', () => {
  assert.equal(calculateClaimFee(101n, 300), 3n);
  assert.equal(calculateClaimFee(2_039_280n, 300), 61_178n);
  assert.equal(calculateClaimNet(2_039_280n, 61_178n, 5_000n, 1n), 1_973_102n);
  assert.throws(() => calculateClaimNet(100n, 3n, 98n, 1n), (error: unknown) => error instanceof GaslessError && error.code === 'TOKEN_UNSUPPORTED');
});

test('Claim batching is deterministic and honors the configured maximum', () => {
  const account = (address: string): ClaimAccount => ({ address, mint: Keypair.generate().publicKey.toBase58(), tokenProgram: LEGACY_TOKEN_PROGRAM_ID, tokenAmountRaw: '0', recoverableLamports: '1', stateFingerprint: address, eligible: true });
  const addresses = Array.from({ length: 25 }, () => Keypair.generate().publicKey.toBase58());
  const batches = batchClaimAccounts(addresses.map(account).reverse(), 10);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 5]);
  assert.deepEqual(batches.flat().map((item) => item.address), [...addresses].sort());
});

test('Claim transaction rejects eleven accounts and duplicate accounts', () => {
  const wallet = Keypair.generate(); const payer = Keypair.generate(); const treasury = Keypair.generate(); const blockhash = Keypair.generate().publicKey.toBase58();
  const account = (): ClaimAccount => ({ address: Keypair.generate().publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58(), tokenProgram: LEGACY_TOKEN_PROGRAM_ID, tokenAmountRaw: '0', recoverableLamports: '2039280', stateFingerprint: 'state', eligible: true });
  const accounts = Array.from({ length: 11 }, account);
  assert.throws(() => buildClaimTransaction({ accounts, walletAddress: wallet.publicKey.toBase58(), feePayer: payer.publicKey.toBase58(), feeDestination: treasury.publicKey.toBase58(), blockhash, settlementLamports: 1n }), (error: unknown) => error instanceof GaslessError && error.stage === 'claim_batching');
  assert.throws(() => buildClaimTransaction({ accounts: [accounts[0], accounts[0]], walletAddress: wallet.publicKey.toBase58(), feePayer: payer.publicKey.toBase58(), feeDestination: treasury.publicKey.toBase58(), blockhash, settlementLamports: 1n }), (error: unknown) => error instanceof GaslessError && error.stage === 'claim_batching');
});

test('Claim engine caps each quote to one deterministic wallet approval', async () => {
  const fixture = engineFixture();
  const entries = Array.from({ length: 11 }, () => ({ pubkey: Keypair.generate().publicKey.toBase58(), account: tokenAccount(fixture.wallet.publicKey) }));
  const accountMap = new Map(entries.map((entry) => [entry.pubkey, entry.account]));
  fixture.rpc.getTokenAccountsByOwner = async (_owner: string, program: string) => program === LEGACY_TOKEN_PROGRAM_ID ? entries : [];
  fixture.rpc.getMultipleAccounts = async (addresses: string[]) => addresses.map((address) => accountMap.get(address) ?? null);
  const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'batches', requestId: 'batches' });
  const prepared = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'batches-prepare');
  assert.deepEqual(prepared.claim!.batches.map((batch) => batch.accounts.length), [10]);
  assert.equal(prepared.claim!.batches.every((batch) => batch.prepared?.simulation.success), true);
  const gross = BigInt(2_039_280 * 10);
  assert.equal(prepared.claim!.gaslessFeeLamports, calculateClaimFee(gross, 300).toString());
  assert.equal(prepared.claim!.batches.reduce((sum, batch) => sum + BigInt(batch.gaslessFeeLamports), 0n), calculateClaimFee(gross, 300));
  assert.equal(fixture.durable.transactions.size, 1);
  assert.ok(prepared.claim!.batches[0].prepared!.walletSigningExpiresAt);
  const durable = [...fixture.durable.transactions.values()][0];
  assert.equal(durable.recentBlockhash, prepared.claim!.batches[0].prepared!.recentBlockhash);
  assert.equal(durable.lastValidBlockHeight, prepared.claim!.batches[0].prepared!.lastValidBlockHeight);
});

test('Claim unsigned wallet failures release exactly once while signed ambiguity remains reserved', async () => {
  for (const reason of ['USER_EXPLICITLY_CANCELLED', 'WALLET_PROVIDER_ERROR'] as const) {
    const fixture = engineFixture(); const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: reason, requestId: reason }); const prepared = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), `${reason}-prepare`); const id = prepared.claim!.batches[0].prepared!.transactionId;
    await fixture.engine.abortWalletApproval(quote.quoteId, fixture.wallet.publicKey.toBase58(), reason, false);
    await fixture.engine.abortWalletApproval(quote.quoteId, fixture.wallet.publicKey.toBase58(), reason, false);
    assert.deepEqual(fixture.releaseAttempts, [id]);
  }
  const expired = engineFixture(); const expiredQuote = await expired.engine.createQuote({ walletAddress: expired.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'expired', requestId: 'expired' }); const expiredPrepared = await expired.engine.prepare(expiredQuote.quoteId, expired.wallet.publicKey.toBase58(), 'expired-prepare'); expired.rpc.blockHeight = expiredPrepared.claim!.batches[0].prepared!.lastValidBlockHeight + 1; await expired.engine.abortWalletApproval(expiredQuote.quoteId, expired.wallet.publicKey.toBase58(), 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', false); assert.equal(expired.releaseAttempts.length, 1);
  const signed = engineFixture(); const signedQuote = await signed.engine.createQuote({ walletAddress: signed.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'signed', requestId: 'signed' }); const signedPrepared = await signed.engine.prepare(signedQuote.quoteId, signed.wallet.publicKey.toBase58(), 'signed-prepare'); signed.rpc.blockHeight = signedPrepared.claim!.batches[0].prepared!.lastValidBlockHeight - 1; await signed.engine.abortWalletApproval(signedQuote.quoteId, signed.wallet.publicKey.toBase58(), 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', true); assert.equal(signed.releaseAttempts.length, 0);
});

test('Claim pre-wallet gate releases an unsafe or state-changed preparation', async () => {
  const unsafe = engineFixture(); const quote = await unsafe.engine.createQuote({ walletAddress: unsafe.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'unsafe', requestId: 'unsafe' }); const prepared = await unsafe.engine.prepare(quote.quoteId, unsafe.wallet.publicKey.toBase58(), 'unsafe-prepare'); unsafe.rpc.blockHeight = prepared.claim!.batches[0].prepared!.lastValidBlockHeight - 99; await expectCode(() => unsafe.engine.currentWalletGateBlockHeight(quote.quoteId, unsafe.wallet.publicKey.toBase58()), 'QUOTE_EXPIRED'); assert.equal(unsafe.releaseAttempts.length, 1);
  const changed = engineFixture(); const changedQuote = await changed.engine.createQuote({ walletAddress: changed.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'changed-gate', requestId: 'changed-gate' }); await changed.engine.prepare(changedQuote.quoteId, changed.wallet.publicKey.toBase58(), 'changed-gate-prepare'); changed.rpc.account.lamports += 1; await expectCode(() => changed.engine.currentWalletGateBlockHeight(changedQuote.quoteId, changed.wallet.publicKey.toBase58()), 'MESSAGE_MISMATCH'); assert.equal(changed.releaseAttempts.length, 1);
});

test('Claim rejects Compute Budget mutations, duplicates, reorder, and a prefilled payer signature', async () => {
  const fixture = engineFixture(); const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'compute', requestId: 'compute' }); const prepared = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'compute-prepare'); const canonical = prepared.claim!.batches[0].prepared!;
  for (const mutation of ['price', 'limit', 'reorder', 'duplicate'] as const) {
    const transaction = VersionedTransaction.deserialize(Buffer.from(canonical.serializedTransaction, 'base64'));
    if (mutation === 'price') transaction.message.compiledInstructions[0].data[1] ^= 1;
    if (mutation === 'limit') transaction.message.compiledInstructions[1].data[1] ^= 1;
    if (mutation === 'reorder') [transaction.message.compiledInstructions[0], transaction.message.compiledInstructions[1]] = [transaction.message.compiledInstructions[1], transaction.message.compiledInstructions[0]];
    if (mutation === 'duplicate') transaction.message.compiledInstructions.splice(2, 0, { ...transaction.message.compiledInstructions[0], data: Uint8Array.from(transaction.message.compiledInstructions[0].data), accountKeyIndexes: [...transaction.message.compiledInstructions[0].accountKeyIndexes] });
    transaction.sign([fixture.wallet]);
    await expectCode(() => validateSignedClaim(Buffer.from(transaction.serialize()).toString('base64'), canonical, fixture.rpc as unknown as SolanaRpc), 'MESSAGE_MISMATCH');
  }
  const payerSigned = VersionedTransaction.deserialize(Buffer.from(canonical.serializedTransaction, 'base64')); payerSigned.sign([fixture.wallet]); payerSigned.signatures[0] = Uint8Array.from({ length: 64 }, () => 1); await expectCode(() => validateSignedClaim(Buffer.from(payerSigned.serialize()).toString('base64'), canonical, fixture.rpc as unknown as SolanaRpc), 'USER_SIGNATURE_INVALID');
});

test('real Claim lifecycle prepares exact economics, rejects mutation, submits once, and reconciles accounting', async () => {
  const fixture = engineFixture();
  const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'quote-one', requestId: 'request-one' });
  const preparedQuote = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'prepare-one');
  const batch = preparedQuote.claim!.batches[0];
  assert.equal(batch.sponsoredCostLamports, '42500');
  assert.equal(batch.gaslessFeeLamports, '61178');
  assert.equal(batch.netUserLamports, '1935602');

  const changed = VersionedTransaction.deserialize(Buffer.from(batch.prepared!.serializedTransaction, 'base64'));
  changed.message.compiledInstructions.at(-1)!.data[4] ^= 1;
  changed.sign([fixture.wallet]);
  await expectCode(() => fixture.engine.submit({ quoteId: quote.quoteId, batchIndex: 0, walletAddress: fixture.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(changed.serialize()).toString('base64'), clientRequestId: 'bad', requestId: 'bad-request' }), 'MESSAGE_MISMATCH');
  assert.equal(fixture.rpc.sent, undefined);

  const exact = VersionedTransaction.deserialize(Buffer.from(batch.prepared!.serializedTransaction, 'base64'));
  exact.sign([fixture.wallet]);
  const signed = Buffer.from(exact.serialize()).toString('base64');
  const result = await fixture.engine.submit({ quoteId: quote.quoteId, batchIndex: 0, walletAddress: fixture.wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'good', requestId: 'good-request' });
  assert.equal(result.reconciliation.status, 'confirmed');
  assert.ok(fixture.rpc.sent);
  const duplicate = await fixture.engine.submit({ quoteId: quote.quoteId, batchIndex: 0, walletAddress: fixture.wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'retry', requestId: 'retry-request' });
  assert.equal(duplicate.alreadyCompleted, true);
  assert.ok([...fixture.durable.events.values()].some((event) => (event as { eventType?: string }).eventType === 'claim_succeeded'));
  assert.equal([...fixture.durable.events.values()].filter((event) => (event as { eventType?: string }).eventType === 'claim_submission_attempted').length, 1);
  assert.equal([...fixture.durable.events.values()].filter((event) => (event as { eventType?: string }).eventType === 'claim_fully_signed').length, 1);
});

test('Claim same-byte broadcast handles primary failure, propagation failure, timeout-after-acceptance, and dual acceptance once', async () => {
  for (const scenario of ['primary-failure', 'primary-no-propagation', 'timeout-after-acceptance', 'dual-acceptance'] as const) {
    const fixture = engineFixture();
    const input = await prepareSignedClaim(fixture, scenario);
    const confirmed = { slot: 7, confirmations: 1, err: null, confirmationStatus: 'confirmed' };
    if (scenario === 'primary-failure') fixture.rpc.broadcastMode = 'primary_fails';
    if (scenario === 'primary-no-propagation') fixture.rpc.providerStatuses = [null, confirmed];
    if (scenario === 'timeout-after-acceptance') fixture.rpc.broadcastMode = 'primary_timeout';
    const result = await fixture.engine.submit({ quoteId: input.quote.quoteId, batchIndex: 0, walletAddress: fixture.wallet.publicKey.toBase58(), signedTransaction: input.signedTransaction, clientRequestId: `${scenario}-submit`, requestId: `${scenario}-submit` });
    const signed = VersionedTransaction.deserialize(Buffer.from(fixture.rpc.broadcastBytes[0], 'base64'));
    assert.equal(result.signature, bs58.encode(signed.signatures[0]));
    assert.equal(fixture.rpc.broadcastBytes.length, 1);
    assert.equal(result.reconciliation.status, 'confirmed');
    const confirmationEvent = [...fixture.durable.events.values()].find((event) => (event as { eventType?: string }).eventType === 'claim_confirmation_observed') as { metadata: { provider?: string; observedAt?: string } };
    assert.ok(confirmationEvent.metadata.provider);
    assert.ok(confirmationEvent.metadata.observedAt);
    assert.equal([...fixture.durable.events.values()].filter((event) => (event as { eventType?: string }).eventType === 'claim_succeeded').length, 1);
    assert.equal(fixture.releaseAttempts.length, 1);
  }
});

test('Claim duplicate and already-processed broadcasts retain one signature and one accounting outcome', async () => {
  for (const mode of ['both_accept', 'already_processed'] as const) {
    const fixture = engineFixture(); const input = await prepareSignedClaim(fixture, `duplicate-${mode}`);
    fixture.rpc.broadcastMode = mode;
    fixture.rpc.signatureStatus = null;
    fixture.rpc.confirmAfterStatusReads = 3;
    const result = await fixture.engine.submit({ quoteId: input.quote.quoteId, batchIndex: 0, walletAddress: fixture.wallet.publicKey.toBase58(), signedTransaction: input.signedTransaction, clientRequestId: `${mode}-submit`, requestId: `${mode}-submit` });
    assert.equal(fixture.rpc.broadcastBytes.length, 3);
    assert.equal(new Set(fixture.rpc.broadcastBytes).size, 1);
    assert.equal([...fixture.durable.events.values()].filter((event) => (event as { eventType?: string }).eventType === 'claim_broadcast_observed').length, 6);
    assert.equal([...fixture.durable.events.values()].filter((event) => (event as { eventType?: string }).eventType === 'claim_succeeded').length, 1);
    assert.equal(fixture.releaseAttempts.length, 1);
    assert.equal(result.signature, fixture.durable.transactions.get(result.transactionId)!.signature);
  }
});

test('Claim expires only after every provider reports absence and releases exactly once', async () => {
  const fixture = engineFixture(); const input = await prepareSignedClaim(fixture, 'everywhere-expired');
  fixture.rpc.signatureStatus = null;
  fixture.rpc.expireAfterBroadcast = true;
  await expectCode(() => fixture.engine.submit({ quoteId: input.quote.quoteId, batchIndex: 0, walletAddress: fixture.wallet.publicKey.toBase58(), signedTransaction: input.signedTransaction, clientRequestId: 'everywhere-expired-submit', requestId: 'everywhere-expired-submit' }), 'RECONCILIATION_FAILED');
  const record = [...fixture.durable.transactions.values()][0];
  assert.equal(record.status, 'failed');
  assert.equal(record.errorStage, 'failed_expired');
  assert.deepEqual(fixture.releaseAttempts, [record.id]);
  assert.equal([...fixture.durable.events.values()].some((event) => (event as { eventType?: string }).eventType === 'claim_succeeded'), false);
  const status = await fixture.engine.reconcileStatus(input.quote.quoteId, fixture.wallet.publicKey.toBase58(), 'devnet');
  assert.equal(status.status, 'failed');
  assert.deepEqual(fixture.releaseAttempts, [record.id]);
  const fresh = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'fresh-after-expiry', requestId: 'fresh-after-expiry' });
  assert.notEqual(fresh.quoteId, input.quote.quoteId);
});

test('Claim refresh reconciles a durable submitted signature without rebroadcast and remains idempotent', async () => {
  const fixture = engineFixture();
  const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'durable-refresh', requestId: 'durable-refresh' });
  const prepared = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'durable-refresh-prepare');
  const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.claim!.batches[0].prepared!.serializedTransaction, 'base64'));
  transaction.sign([fixture.wallet, fixture.relayer]);
  fixture.rpc.sent = Buffer.from(transaction.serialize()).toString('base64');
  const record = [...fixture.durable.transactions.values()][0];
  await fixture.durable.updateTransaction(record.id, { status: 'submitted', signature: 'durable-signature' });

  const first = await fixture.engine.reconcileStatus(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'devnet');
  const second = await fixture.engine.reconcileStatus(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'devnet');
  assert.equal(first.status, 'confirmed');
  assert.equal(second.status, 'confirmed');
  assert.deepEqual(fixture.releaseAttempts, [record.id]);
  assert.equal([...fixture.durable.events.values()].filter((event) => (event as { eventType?: string }).eventType === 'claim_succeeded').length, 1);
  assert.equal(fixture.rpc.broadcastBytes.length, 0);
  assert.equal(fixture.durable.transactions.size, 1);
});

test('Claim refresh keeps an expired but singly-observed absent signature pending and reserved', async () => {
  const fixture = engineFixture();
  const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'durable-pending', requestId: 'durable-pending' });
  const prepared = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'durable-pending-prepare');
  const record = [...fixture.durable.transactions.values()][0];
  await fixture.durable.updateTransaction(record.id, { status: 'submitted', signature: 'absent-signature' });
  fixture.rpc.signatureStatus = null;
  fixture.rpc.secondaryUnavailable = true;
  fixture.rpc.blockHeight = prepared.claim!.batches[0].prepared!.lastValidBlockHeight + 1;

  const result = await fixture.engine.reconcileStatus(quote.quoteId, fixture.wallet.publicKey.toBase58(), 'devnet');
  assert.equal(result.status, 'pending');
  assert.equal(result.expired, true);
  assert.equal(fixture.releaseAttempts.length, 0);
  assert.equal(fixture.durable.transactions.get(record.id)!.status, 'submitted');
});

test('Claim fails closed for emergency disable, wrong network, stale account state, and simulation failure', async () => {
  const disabled = engineFixture();
  disabled.durable.controls.claimEnabled = false;
  await expectCode(() => disabled.engine.createQuote({ walletAddress: disabled.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'disabled', requestId: 'disabled' }), 'ACTION_DISABLED');
  await expectCode(() => disabled.engine.createQuote({ walletAddress: disabled.wallet.publicKey.toBase58(), network: 'mainnet-beta' as 'devnet', clientRequestId: 'wrong', requestId: 'wrong' }), 'ACTION_DISABLED');

  const stale = engineFixture();
  const staleQuote = await stale.engine.createQuote({ walletAddress: stale.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'stale', requestId: 'stale' });
  stale.rpc.account.lamports += 1;
  await expectCode(() => stale.engine.prepare(staleQuote.quoteId, stale.wallet.publicKey.toBase58(), 'stale-prepare'), 'MESSAGE_MISMATCH');

  const failed = engineFixture();
  const failedQuote = await failed.engine.createQuote({ walletAddress: failed.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'simulation', requestId: 'simulation' });
  failed.rpc.failSimulation = true;
  await expectCode(() => failed.engine.prepare(failedQuote.quoteId, failed.wallet.publicKey.toBase58(), 'simulation-prepare'), 'SIMULATION_FAILED');
  assert.equal(failed.rpc.sent, undefined);
});

test('Claim rejects state changes after signing, invalid wallet signatures, and low relayer balance', async () => {
  const stale = engineFixture();
  const quote = await stale.engine.createQuote({ walletAddress: stale.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'after-sign', requestId: 'after-sign' });
  const prepared = await stale.engine.prepare(quote.quoteId, stale.wallet.publicKey.toBase58(), 'after-sign-prepare');
  const batch = prepared.claim!.batches[0];
  const unsigned = VersionedTransaction.deserialize(Buffer.from(batch.prepared!.serializedTransaction, 'base64'));
  await expectCode(() => stale.engine.submit({ quoteId: quote.quoteId, batchIndex: 0, walletAddress: stale.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(unsigned.serialize()).toString('base64'), clientRequestId: 'unsigned', requestId: 'unsigned' }), 'USER_SIGNATURE_INVALID');
  unsigned.sign([stale.wallet]);
  stale.rpc.account.lamports += 1;
  await expectCode(() => stale.engine.submit({ quoteId: quote.quoteId, batchIndex: 0, walletAddress: stale.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(unsigned.serialize()).toString('base64'), clientRequestId: 'changed', requestId: 'changed' }), 'MESSAGE_MISMATCH');
  assert.equal(stale.rpc.sent, undefined);

  const low = engineFixture();
  const lowQuote = await low.engine.createQuote({ walletAddress: low.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: 'low', requestId: 'low' });
  const lowPrepared = await low.engine.prepare(lowQuote.quoteId, low.wallet.publicKey.toBase58(), 'low-prepare');
  const lowTransaction = VersionedTransaction.deserialize(Buffer.from(lowPrepared.claim!.batches[0].prepared!.serializedTransaction, 'base64'));
  lowTransaction.sign([low.wallet]);
  low.rpc.getBalance = async () => 0;
  await expectCode(() => low.engine.submit({ quoteId: lowQuote.quoteId, batchIndex: 0, walletAddress: low.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(lowTransaction.serialize()).toString('base64'), clientRequestId: 'low-submit', requestId: 'low-submit' }), 'RELAYER_INSUFFICIENT_FUNDS');
  assert.equal(low.rpc.sent, undefined);
});

test('local relayer configuration rejects missing and malformed key material without exposing it', () => {
  assert.throws(() => new LocalDevnetRelayerProvider(undefined), (error: unknown) => error instanceof GaslessError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => new LocalDevnetRelayerProvider('[1,2,3]'), (error: unknown) => error instanceof GaslessError && error.code === 'CONFIGURATION_ERROR');
});

test('Claim reconciliation fails closed for a payout mismatch or an account that remains open', async () => {
  for (const failure of ['payout', 'open-account'] as const) {
    const fixture = engineFixture();
    const quote = await fixture.engine.createQuote({ walletAddress: fixture.wallet.publicKey.toBase58(), network: 'devnet', clientRequestId: failure, requestId: failure });
    const prepared = await fixture.engine.prepare(quote.quoteId, fixture.wallet.publicKey.toBase58(), `${failure}-prepare`);
    const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.claim!.batches[0].prepared!.serializedTransaction, 'base64'));
    transaction.sign([fixture.wallet]);
    fixture.rpc.mismatchPayout = failure === 'payout';
    fixture.rpc.leaveAccountOpen = failure === 'open-account';
    await expectCode(() => fixture.engine.submit({ quoteId: quote.quoteId, batchIndex: 0, walletAddress: fixture.wallet.publicKey.toBase58(), signedTransaction: Buffer.from(transaction.serialize()).toString('base64'), clientRequestId: `${failure}-submit`, requestId: `${failure}-submit` }), 'RECONCILIATION_FAILED');
    assert.equal([...fixture.durable.events.values()].some((event) => (event as { eventType?: string }).eventType === 'claim_succeeded'), false);
  }
});
