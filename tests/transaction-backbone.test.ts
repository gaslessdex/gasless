import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, Transaction } from '@solana/web3.js';
import { buildProofTransaction, messageHash, prepareProofTransaction, validateSignedProof } from '../chains/solana/transactions/proof.js';
import type { TransactionQuote } from '../shared/transactions/types.js';
import { EmergencyControlService } from '../server/controls/service.js';
import { GaslessError } from '../server/errors.js';
import { LocalDevnetRelayerProvider } from '../server/relayer/provider.js';
import type { SolanaRpc } from '../server/solana/rpc.js';
import { DEVNET_CONTROLS, MemoryDurableStore } from '../server/storage/durable.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';
import { ServerTokenRegistry } from '../server/token-registry/service.js';
import { TransactionEngine } from '../server/transactions/engine.js';

class FakeRpc {
  sent?: string;
  blockHeight = 10;
  async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100, provider: 'fake' }; }
  async getBlockHeight() { return this.blockHeight; }
  async simulateTransaction() { return { err: null, logs: ['ok'], unitsConsumed: 100, provider: 'fake' }; }
  async getFeeForMessage() { return 5000; }
  async sendRawTransaction(serialized: string) { this.sent = serialized; return { signature: 'fake-devnet-signature', provider: 'fake' }; }
  async getSignatureStatuses() { return { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }; }
  async getTransaction() { return { meta: { err: null, fee: 5000 } }; }
  async getBalance() { return 1_000_000; }
}

function quote(wallet: string, expiresAt = new Date(Date.now() + 60_000).toISOString()): TransactionQuote {
  const createdAt = new Date().toISOString();
  return { quoteId: crypto.randomUUID(), status: 'created', createdAt, expiresAt, intent: { intentId: crypto.randomUUID(), walletAddress: wallet, actionType: 'DEVNET_PROOF', network: 'devnet', requestId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), createdAt, expiresAt, metadata: {} } };
}

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof GaslessError && error.code === code);
}

test('message fingerprint ignores signatures but detects message changes', () => {
  const wallet = Keypair.generate();
  const payer = Keypair.generate();
  const item = quote(wallet.publicKey.toBase58());
  const tx = buildProofTransaction(item, payer.publicKey.toBase58(), Keypair.generate().publicKey.toBase58());
  const before = messageHash(tx);
  tx.partialSign(wallet);
  assert.equal(messageHash(tx), before);
  tx.instructions[0].data = Buffer.from('mutated');
  assert.notEqual(messageHash(tx), before);
});

test('strict validation accepts exact wallet signature and rejects mutation, fee payer, signer, and expiry changes', async () => {
  const wallet = Keypair.generate();
  const payer = Keypair.generate();
  const rpc = new FakeRpc();
  const item = quote(wallet.publicKey.toBase58());
  const prepared = await prepareProofTransaction(item, payer.publicKey.toBase58(), rpc as unknown as SolanaRpc);
  const exact = Transaction.from(Buffer.from(prepared.serializedTransaction, 'base64'));
  exact.partialSign(wallet);
  const serialized = exact.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  assert.equal((await validateSignedProof(serialized, prepared, rpc as unknown as SolanaRpc)).messageHash, prepared.preparedMessageHash);

  const changed = Transaction.from(Buffer.from(prepared.serializedTransaction, 'base64'));
  changed.instructions[0].data = Buffer.from('changed'); changed.partialSign(wallet);
  await expectCode(() => validateSignedProof(changed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), prepared, rpc as unknown as SolanaRpc), 'MESSAGE_MISMATCH');

  const wrongPayer = buildProofTransaction(item, Keypair.generate().publicKey.toBase58(), prepared.recentBlockhash);
  wrongPayer.partialSign(wallet);
  await expectCode(() => validateSignedProof(wrongPayer.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), prepared, rpc as unknown as SolanaRpc), 'MESSAGE_MISMATCH');

  const unsigned = Transaction.from(Buffer.from(prepared.serializedTransaction, 'base64'));
  await expectCode(() => validateSignedProof(unsigned.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), prepared, rpc as unknown as SolanaRpc), 'USER_SIGNATURE_INVALID');
  rpc.blockHeight = 101;
  await expectCode(() => validateSignedProof(serialized, prepared, rpc as unknown as SolanaRpc), 'QUOTE_EXPIRED');
});

test('temporary store enforces atomic replay locks and quote expiry', async () => {
  const store = new MemoryTemporaryStore();
  assert.equal(await store.acquireReplayLock('same', 'a', 60), true);
  assert.equal(await store.acquireReplayLock('same', 'b', 60), false);
  await store.releaseReplayLockIfSafe('same', 'b');
  assert.equal(await store.hasReplayLock('same'), true);
  await store.releaseReplayLockIfSafe('same', 'a');
  assert.equal(await store.hasReplayLock('same'), false);
});

test('emergency controls fail closed for global, relayer, action, and wrong network', async () => {
  const durable = new MemoryDurableStore();
  const controls = new EmergencyControlService(durable);
  durable.controls.globalExecutionEnabled = false;
  await expectCode(() => controls.assertExecutionAllowed('DEVNET_PROOF', 'devnet'), 'ACTION_DISABLED');
  durable.controls = { ...DEVNET_CONTROLS, relayerEnabled: false };
  await expectCode(() => controls.assertExecutionAllowed('DEVNET_PROOF', 'devnet'), 'RELAYER_DISABLED');
  durable.controls = { ...DEVNET_CONTROLS, proofEnabled: false };
  await expectCode(() => controls.assertExecutionAllowed('DEVNET_PROOF', 'devnet'), 'ACTION_DISABLED');
  durable.controls = { ...DEVNET_CONTROLS };
  await expectCode(() => controls.assertExecutionAllowed('DEVNET_PROOF', 'mainnet-beta'), 'ACTION_DISABLED');
});

test('Mainnet and dedicated cross-chain controls independently fail closed', async () => {
  const store = new MemoryDurableStore();
  store.controls.mainnetEnabled = false;
  const controls = new EmergencyControlService(store);
  await expectCode(() => controls.assertExecutionAllowed('CROSS_CHAIN', 'mainnet-beta'), 'ACTION_DISABLED');
  await expectCode(() => controls.assertExecutionAllowed('SEND', 'mainnet-beta'), 'ACTION_DISABLED');
  store.controls.mainnetEnabled = true;
  store.controls.crossChainEnabled = false;
  await expectCode(() => controls.assertExecutionAllowed('CROSS_CHAIN', 'mainnet-beta'), 'ACTION_DISABLED');
  await controls.assertExecutionAllowed('SEND', 'mainnet-beta');
});

test('canonical lifecycle submits final simulated bytes once and reconciles idempotently', async () => {
  const wallet = Keypair.generate();
  const payer = Keypair.generate();
  const temporary = new MemoryTemporaryStore();
  const durable = new MemoryDurableStore();
  const rpc = new FakeRpc();
  const relayer = new LocalDevnetRelayerProvider(JSON.stringify([...payer.secretKey]));
  const engine = new TransactionEngine(temporary, durable, rpc as unknown as SolanaRpc, relayer, new EmergencyControlService(durable), new ServerTokenRegistry(), 120);
  const created = await engine.createQuote({ walletAddress: wallet.publicKey.toBase58(), network: 'devnet', actionType: 'DEVNET_PROOF', clientRequestId: 'one', requestId: 'request-one' });
  await expectCode(() => engine.createQuote({ walletAddress: wallet.publicKey.toBase58(), network: 'devnet', actionType: 'DEVNET_PROOF', clientRequestId: 'one', requestId: 'request-two' }), 'REPLAY_DETECTED');
  const prepared = await engine.prepare(created.quoteId, wallet.publicKey.toBase58(), 'request-one');
  const tx = Transaction.from(Buffer.from(prepared.serializedTransaction, 'base64')); tx.partialSign(wallet);
  const signed = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const result = await engine.submit({ quoteId: created.quoteId, walletAddress: wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'submit-one', requestId: 'submit-request' });
  assert.equal(result.reconciliation.status, 'confirmed');
  assert.equal(Transaction.from(Buffer.from(rpc.sent!, 'base64')).verifySignatures(true), true);
  await expectCode(() => engine.submit({ quoteId: created.quoteId, walletAddress: wallet.publicKey.toBase58(), signedTransaction: signed, clientRequestId: 'submit-two', requestId: 'submit-again' }), 'QUOTE_ALREADY_USED');
  const before = durable.events.size;
  await engine.reconcile(prepared.transactionId);
  assert.equal(durable.events.size, before);
});

test('expired and wallet-mismatched quotes are rejected before preparation', async () => {
  const wallet = Keypair.generate();
  const temporary = new MemoryTemporaryStore();
  const durable = new MemoryDurableStore();
  const rpc = new FakeRpc();
  const relayer = new LocalDevnetRelayerProvider(JSON.stringify([...Keypair.generate().secretKey]));
  const engine = new TransactionEngine(temporary, durable, rpc as unknown as SolanaRpc, relayer, new EmergencyControlService(durable), new ServerTokenRegistry(), 120);
  const expired = quote(wallet.publicKey.toBase58(), new Date(Date.now() - 1).toISOString());
  await temporary.saveQuote(expired, 60);
  await expectCode(() => engine.prepare(expired.quoteId, wallet.publicKey.toBase58(), 'request'), 'QUOTE_EXPIRED');
  const active = quote(wallet.publicKey.toBase58());
  await temporary.saveQuote(active, 60);
  await expectCode(() => engine.prepare(active.quoteId, Keypair.generate().publicKey.toBase58(), 'request'), 'SESSION_ERROR');
});
