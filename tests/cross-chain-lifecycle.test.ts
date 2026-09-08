import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { versionedMessageHash } from '../chains/solana/transactions/clean.js';
import type { ValidatedRelayTransaction } from '../chains/solana/relay/validator.js';
import type { ServerConfig } from '../server/config/env.js';
import { RelayAuthorizationSigner } from '../server/cross-chain/authorization.js';
import { CrossChainSponsorshipLifecycle, finalSimulationAccounts } from '../server/cross-chain/lifecycle.js';
import { GaslessError } from '../server/errors.js';
import { RelayClient } from '../server/relay/client.js';
import type { RelayerProvider } from '../server/relayer/provider.js';
import { OperationalRiskService } from '../server/risk/operational.js';
import { MemoryDurableStore } from '../server/storage/durable.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';

const recipient = `0x${'1'.repeat(40)}`;

test('final simulation requests only accounts whose lamport or token value is bounded', () => {
  const accounts = finalSimulationAccounts({ depositFeePayer: 'payer', expectedSourceAccount: 'source', expectedVaultAccount: 'vault' });
  assert.deepEqual(accounts, ['payer', 'source', 'vault']);
  assert.deepEqual(finalSimulationAccounts({ depositFeePayer: 'wallet', expectedSourceAccount: 'wallet', expectedVaultAccount: 'vault' }), ['wallet', 'vault']);
});

async function fixture(options: { balance?: number; cap?: number; signerFails?: boolean; relayStatus?: string } = {}) {
  const payer = Keypair.generate(); const wallet = Keypair.generate(); const authority = Keypair.generate();
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const instruction = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }], data: Buffer.from('relay-test') });
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash, instructions: [instruction] }).compileToV0Message());
  const serializedTransaction = Buffer.from(transaction.serialize()).toString('base64');
  const expiresAt = new Date(Date.now() + 60_000).toISOString(); const quoteId = crypto.randomUUID(); const relayRequestId = crypto.randomUUID();
  const validated: ValidatedRelayTransaction = { serializedTransaction, messageHash: versionedMessageHash(transaction), wallet: wallet.publicKey.toBase58(), quoteId, relayRequestId, orderId: `0x${'2'.repeat(64)}`, inputAsset: 'USDC', inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inputAmountRaw: '1000000', destinationAsset: 'USDG', recipient, depositFeePayer: payer.publicKey.toBase58(), expectedSponsorMaxLamports: 10_000, expiresAt, recentBlockhash, lastValidBlockHeight: 100, expectedSourceAccount: Keypair.generate().publicKey.toBase58(), expectedVaultAccount: Keypair.generate().publicKey.toBase58(), validatedAt: new Date().toISOString() };
  const temporary = new MemoryTemporaryStore(); const durable = new MemoryDurableStore();
  await temporary.saveCrossChainQuote({ quote: { quoteId, provider: 'Relay', sourceNetwork: 'solana', destinationNetwork: 'robinhood', inputAsset: 'USDC', outputAsset: 'USDG', inputAmount: '1', estimatedOutput: '0.9', appFee: { amount: '0', amountUsd: '0', symbol: 'USDC' }, expiresAt, recipient, executionReady: false }, walletAddress: validated.wallet, providerRequestId: relayRequestId, inputAmountRaw: validated.inputAmountRaw }, 60);
  const relayer: RelayerProvider = { async getFeePayerPublicKey() { return payer.publicKey.toBase58(); }, async signTransaction(serialized, signOptions) { if (options.signerFails) throw new GaslessError('RELAYER_POLICY_REJECTED', 'test', 'rejected'); assert(signOptions?.relayAuthorization); const value = VersionedTransaction.deserialize(Buffer.from(serialized, 'base64')); value.sign([payer]); return Buffer.from(value.serialize()).toString('base64'); } };
  const config = { pilotWalletAllowlist: [validated.wallet], operatingMode: 'private-mainnet', relayerLowBalanceThresholdLamports: 100, relayerWarningBalanceThresholdLamports: 200, perTransactionSponsorshipCapLamports: options.cap ?? 20_000, globalSponsorshipCapLamports: 30_000, walletSponsorshipCapLamports: 30_000, sponsorshipWindowSeconds: 60 } as ServerConfig;
  const rpc = { async getBalance() { return options.balance ?? 1_000_000; } };
  const controls = {};
  const risk = new OperationalRiskService(config, temporary, rpc as never, relayer, controls as never);
  const relay = new RelayClient('test', (async () => Response.json({ status: options.relayStatus ?? 'success', originChainId: 792703809, destinationChainId: 4663 })) as typeof fetch);
  const lifecycle = new CrossChainSponsorshipLifecycle(temporary, durable, relay, relayer, risk, new RelayAuthorizationSigner(JSON.stringify([...authority.secretKey])));
  return { lifecycle, temporary, durable, validated };
}

test('cross-chain signing reserves bounded exposure, persists exact bindings, and releases idempotently', async () => {
  const f = await fixture(); const prepared = await f.lifecycle.prepareSignOnly(f.validated);
  assert.equal(await f.temporary.getSponsorshipExposure('global:mainnet-beta'), 10_000);
  const record = await f.durable.getTransaction(prepared.transactionId);
  assert.equal(record?.preparedMessageHash, f.validated.messageHash); assert.equal(record?.relayOrderId, f.validated.orderId); assert.equal(record?.crossChainStatus, 'awaiting_signature');
  assert.equal(await f.lifecycle.abortSignOnly(prepared.transactionId), 'released');
  assert.equal(await f.lifecycle.abortSignOnly(prepared.transactionId), 'already_released');
  assert.equal(await f.temporary.getSponsorshipExposure('global:mainnet-beta'), 0);
  await assert.rejects(() => f.lifecycle.prepareSignOnly(f.validated), (error: unknown) => error instanceof GaslessError && error.code === 'QUOTE_ALREADY_USED');
});

test('cross-chain signing enforces transaction cap and fee-inclusive low-balance floor', async () => {
  const capped = await fixture({ cap: 9_999 });
  await assert.rejects(() => capped.lifecycle.prepareSignOnly(capped.validated), (error: unknown) => error instanceof GaslessError && error.code === 'SPONSOR_LIMIT_EXCEEDED');
  assert.equal(await capped.temporary.getSponsorshipExposure('global:mainnet-beta'), 0);
  const low = await fixture({ balance: 10_099 });
  await assert.rejects(() => low.lifecycle.prepareSignOnly(low.validated), (error: unknown) => error instanceof GaslessError && error.code === 'RELAYER_INSUFFICIENT_FUNDS');
  assert.equal(await low.temporary.getSponsorshipExposure('global:mainnet-beta'), 0);
});

test('provider rejection releases its reservation and leaves a durable failure record', async () => {
  const f = await fixture({ signerFails: true });
  await assert.rejects(() => f.lifecycle.prepareSignOnly(f.validated), (error: unknown) => error instanceof GaslessError && error.code === 'RELAYER_POLICY_REJECTED');
  assert.equal(await f.temporary.getSponsorshipExposure('global:mainnet-beta'), 0);
  assert.equal((await f.durable.getTransactionByQuoteId(f.validated.quoteId))?.status, 'failed');
});

test('Relay reconciliation is normalized, durable, idempotent, and releases terminal exposure once', async () => {
  const f = await fixture({ relayStatus: 'success' }); const prepared = await f.lifecycle.prepareSignOnly(f.validated);
  assert.equal((await f.lifecycle.reconcile(prepared.transactionId)).status, 'completed');
  assert.equal((await f.lifecycle.reconcile(prepared.transactionId)).status, 'completed');
  const record = await f.durable.getTransaction(prepared.transactionId);
  assert.equal(record?.status, 'reconciled'); assert.equal(record?.crossChainStatus, 'completed');
  assert.equal(await f.temporary.getSponsorshipExposure('global:mainnet-beta'), 0);
  assert.equal([...f.durable.events.values()].filter((event) => (event as { eventType?: string }).eventType === 'cross_chain_reconciled').length, 1);
});

test('Relay waiting status cannot revive a locally failed source attempt', async () => {
  const f = await fixture({ relayStatus: 'waiting' }); const prepared = await f.lifecycle.prepareSignOnly(f.validated);
  await f.lifecycle.abortSignOnly(prepared.transactionId, 'cross_chain_source');
  assert.equal((await f.lifecycle.reconcile(prepared.transactionId)).status, 'failed');
  const record = await f.durable.getTransaction(prepared.transactionId);
  assert.equal(record?.status, 'failed'); assert.equal(record?.crossChainStatus, 'failed');
});

test('expired cross-chain signing state releases its reservation without double counting', async () => {
  const f = await fixture(); const prepared = await f.lifecycle.prepareSignOnly(f.validated);
  await assert.rejects(() => f.lifecycle.expire(prepared.transactionId), (error: unknown) => error instanceof GaslessError && error.code === 'INVALID_REQUEST');
  assert.equal(await f.lifecycle.expire(prepared.transactionId, Date.parse(f.validated.expiresAt) + 1), 'released');
  assert.equal(await f.lifecycle.expire(prepared.transactionId, Date.parse(f.validated.expiresAt) + 2), 'already_released');
  assert.equal((await f.durable.getTransaction(prepared.transactionId))?.status, 'expired');
  assert.equal(await f.temporary.getSponsorshipExposure('global:mainnet-beta'), 0);
});
