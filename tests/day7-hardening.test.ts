import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import type { ServerConfig } from '../server/config/env.js';
import { GaslessError } from '../server/errors.js';
import { sanitizeLogValue } from '../server/observability/logger.js';
import { OperationalRiskService } from '../server/risk/operational.js';
import { KoraCallFailure, koraFailure, KoraRelayerProvider } from '../server/relayer/provider.js';
import { MemoryDurableStore } from '../server/storage/durable.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';
import { canReleaseAfterKoraFailure } from '../server/swap/engine.js';
import { ServerTokenRegistry, type TokenRegistryEntry } from '../server/token-registry/service.js';
import type { TransactionQuote } from '../shared/transactions/types.js';

const wallet = Keypair.generate().publicKey.toBase58();
const denied = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey.toBase58();

function config(overrides: Partial<ServerConfig> = {}) {
  return { operatingMode: 'private-mainnet', pilotWalletAllowlist: [wallet], routeRateLimit: 3, routeRateWindowSeconds: 60, relayerLowBalanceThresholdLamports: 100, relayerWarningBalanceThresholdLamports: 200, perTransactionSponsorshipCapLamports: 100, walletSponsorshipCapLamports: 200, globalSponsorshipCapLamports: 300, sponsorshipWindowSeconds: 3600, ...overrides } as ServerConfig;
}

function fixture(overrides: Partial<ServerConfig> = {}, balance: number | Error = 1_000) {
  const temporary = new MemoryTemporaryStore();
  const rpc = { async getBalance() { if (balance instanceof Error) throw balance; return balance; } };
  const relayer = { async getFeePayerPublicKey() { return payer; }, async signTransaction(value: string) { return value; } };
  const controls = { async assertExecutionAllowed() { return {}; } };
  return { temporary, risk: new OperationalRiskService(config(overrides), temporary, rpc as never, relayer, controls as never) };
}

function quote(id: string, owner: string, cost: string): TransactionQuote {
  const now = new Date().toISOString();
  return { quoteId: id, status: 'awaiting_user_signature', createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), intent: { intentId: id, walletAddress: owner, actionType: 'SEND', network: 'mainnet-beta', requestId: id, clientRequestId: id, createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), metadata: {} }, send: { schemaVersion: 'send-v1', token: { mint: payer, symbol: 'T', decimals: 6, tokenProgram: payer, balanceRaw: '1', sourceAccount: payer }, recipientWallet: payer, destinationAccount: payer, recipientAtaExists: true, max: false, recipientAmountRaw: '1', sponsorReimbursementRaw: '1', serviceFeeRaw: '1', totalDebitRaw: '3', sponsoredCostLamports: cost, reimbursementDestination: payer, serviceFeeDestination: payer, status: 'awaiting_user_signature' } };
}

async function code(run: () => Promise<unknown>, expected: string) {
  await assert.rejects(run, (error: unknown) => error instanceof GaslessError && error.code === expected);
}

test('wallet connection is unrestricted while each connected or switched account is authorized server-side', () => {
  const { risk } = fixture();
  risk.assertWalletAllowed(wallet, 'mainnet-beta');
  assert.throws(() => risk.assertWalletAllowed(denied, 'mainnet-beta'), (error: unknown) => error instanceof GaslessError && error.code === 'WALLET_NOT_ALLOWED' && /connected.*Private Beta/.test(error.message));
  risk.assertWalletAllowed(denied, 'devnet');
});

test('public Mainnet accepts a normal wallet without the private pilot allowlist', () => {
  const { risk } = fixture({ operatingMode: 'public-mainnet', pilotWalletAllowlist: [] });
  risk.assertWalletAllowed(denied, 'mainnet-beta');
});

test('route limits bind both wallet and client address instead of request IDs', async () => {
  const { risk } = fixture();
  for (let index = 0; index < 3; index += 1) await risk.enforceRequest('SEND', 'quote', wallet, 'mainnet-beta', '203.0.113.4');
  await code(() => risk.enforceRequest('SEND', 'quote', wallet, 'mainnet-beta', '203.0.113.4'), 'RATE_LIMITED');
});

test('read-only Swap discovery and quote remain available while Mainnet preparation is disabled', async () => {
  const temporary = new MemoryTemporaryStore();
  const controls = { async assertExecutionAllowed() { throw new GaslessError('ACTION_DISABLED', 'controls', 'Mainnet execution is disabled.'); } };
  const rpc = { async getBalance() { return 1_000; } };
  const relayer = { async getFeePayerPublicKey() { return payer; } };
  const risk = new OperationalRiskService(config(), temporary, rpc as never, relayer as never, controls as never);
  await risk.enforceRequest('SWAP', 'discover', wallet, 'mainnet-beta', '203.0.113.5');
  await risk.enforceRequest('SWAP', 'quote', wallet, 'mainnet-beta', '203.0.113.5');
  await code(() => risk.enforceRequest('SWAP', 'prepare', wallet, 'mainnet-beta', '203.0.113.5'), 'ACTION_DISABLED');
  await code(() => risk.enforceRequest('SEND', 'quote', wallet, 'mainnet-beta', '203.0.113.5'), 'ACTION_DISABLED');
});

test('sponsorship caps allow the exact boundary, reject per-transaction/wallet/global overflow, and do not double count retries', async () => {
  const { risk } = fixture();
  await risk.reserveQuoteExposure(quote('one', wallet, '100'));
  await risk.reserveQuoteExposure(quote('one', wallet, '100'));
  await risk.reserveQuoteExposure(quote('two', wallet, '100'));
  await code(() => risk.reserveQuoteExposure(quote('wallet-over', wallet, '1')), 'SPONSOR_LIMIT_EXCEEDED');
  await code(() => risk.reserveQuoteExposure(quote('tx-over', denied, '101')), 'SPONSOR_LIMIT_EXCEEDED');
  await risk.reserveQuoteExposure(quote('other', denied, '100'));
  await code(() => risk.reserveQuoteExposure(quote('global-over', Keypair.generate().publicKey.toBase58(), '1')), 'SPONSOR_LIMIT_EXCEEDED');
});

test('sponsorship release is exact, atomic, idempotent, and safe under concurrent retries', async () => {
  const { risk, temporary } = fixture(); const reserved = quote('release', wallet, '100'); await risk.reserveQuoteExposure(reserved);
  assert.equal(await temporary.getSponsorshipExposure('global:mainnet-beta'), 100); assert.equal(await temporary.getSponsorshipExposure(`wallet:mainnet-beta:${wallet}`), 100);
  const results = await Promise.all([risk.releaseQuoteExposure(reserved), risk.releaseQuoteExposure(reserved)]);
  assert.deepEqual(results.sort(), ['already_released', 'released']); assert.equal(await temporary.getSponsorshipExposure('global:mainnet-beta'), 0); assert.equal(await risk.releaseQuoteExposure(reserved), 'already_released');
  assert.equal(await risk.releaseQuoteExposure(quote('missing', wallet, '100')), 'already_released');
  const wrong = quote('wrong-amount', wallet, '100'); await risk.reserveQuoteExposure(wrong); await assert.rejects(() => risk.releaseQuoteExposure(quote('wrong-amount', wallet, '99')), /amount does not match/); assert.equal(await temporary.getSponsorshipExposure('global:mainnet-beta'), 100);
});

test('CLEAN reservations are isolated per prepared transaction and action', async () => {
  const { risk, temporary } = fixture();
  const base = { network: 'mainnet-beta' as const, walletAddress: wallet, action: 'CLEAN_CLAIM' as const, amountLamports: 50 };
  await risk.reserveTransactionExposure({ ...base, transactionId: 'claim-a' });
  await risk.reserveTransactionExposure({ ...base, transactionId: 'claim-b' });
  assert.equal(await temporary.getSponsorshipExposure('global:mainnet-beta'), 100);
  assert.equal(await risk.releaseTransactionExposure({ ...base, transactionId: 'claim-a' }), 'released');
  assert.equal(await temporary.getSponsorshipExposure('global:mainnet-beta'), 50);
  assert.equal(await risk.releaseTransactionExposure({ ...base, transactionId: 'claim-a' }), 'already_released');
  assert.equal(await temporary.getSponsorshipExposure('global:mainnet-beta'), 50);
});

test('fee-payer health reports healthy, warning, hard pause, and provider failure safely', async () => {
  assert.equal(await fixture({}, 1_000).risk.assertRelayerHealthy(), 'healthy');
  assert.equal(await fixture({}, 150).risk.assertRelayerHealthy(), 'warning');
  await code(() => fixture({}, 99).risk.assertRelayerHealthy(), 'RELAYER_INSUFFICIENT_FUNDS');
  await code(() => fixture({}, new Error('provider down')).risk.assertRelayerHealthy(), 'RELAYER_INSUFFICIENT_FUNDS');
});

test('token pauses independently disable Send, Swap input/output, and Recover Value', async () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const entry: TokenRegistryEntry = { mint, symbol: 'T', decimals: 6, tokenProgram: payer, extensions: [], status: 'supported', enabledActions: ['SEND', 'SWAP'], feePaymentEnabled: true, swapInputEnabled: true, swapOutputEnabled: true };
  const registry = new ServerTokenRegistry([mint], [entry], [entry], [{ mint, actions: ['SEND', 'SWAP_INPUT', 'CLEAN_RECOVER'] }]);
  assert.equal((await registry.evaluate('SEND', mint)).decision, 'blocked');
  assert.equal((await registry.evaluate('CLEAN_RECOVER', mint)).decision, 'blocked');
  const swap = (await registry.evaluate('SWAP', mint)).entry!;
  assert.equal(swap.swapInputEnabled, false);
  assert.equal(swap.swapOutputEnabled, true);
});

test('operator metrics keep Devnet and Mainnet accounting separate', async () => {
  const durable = new MemoryDurableStore();
  const now = new Date().toISOString();
  for (const network of ['devnet', 'mainnet-beta'] as const) await durable.createTransaction({ id: network, intentId: network, quoteId: network, walletAddress: wallet, actionType: 'SEND', network, status: 'reconciled', sponsoredCostLamports: network === 'devnet' ? '10' : '20', createdAt: now, updatedAt: now });
  const devnet = await durable.getOperatorMetrics('devnet');
  const mainnet = await durable.getOperatorMetrics('mainnet-beta');
  assert.equal(devnet.totalActions, 1); assert.equal(devnet.sponsoredLamports, '10');
  assert.equal(mainnet.totalActions, 1); assert.equal(mainnet.sponsoredLamports, '20');
});

test('Kora boundary authenticates, accepts only the expected payer, and preserves exact message bytes', async () => {
  const user = Keypair.generate(); const koraPayer = Keypair.generate();
  const transaction = new Transaction({ feePayer: koraPayer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  transaction.partialSign(user);
  const input = transaction.serialize({ requireAllSignatures: false }).toString('base64');
  const calls: string[] = []; let recoverAuthorization: unknown;
  const request = async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'auth');
    const payload = JSON.parse(String(init?.body)) as { method: string; params?: { recover_authorization?: unknown } };
    calls.push(payload.method);
    recoverAuthorization = payload.params?.recover_authorization ?? recoverAuthorization;
    if (payload.method === 'getPayerSigner') return Response.json({ jsonrpc: '2.0', id: 1, result: { signer_address: koraPayer.publicKey.toBase58(), payment_address: koraPayer.publicKey.toBase58() } });
    const signed = Transaction.from(Buffer.from(input, 'base64')); signed.partialSign(koraPayer);
    return Response.json({ jsonrpc: '2.0', id: 1, result: { signer_pubkey: koraPayer.publicKey.toBase58(), signed_transaction: signed.serialize().toString('base64'), signature: 'safe-public-signature' } });
  };
  const provider = new KoraRelayerProvider('https://kora.invalid', 'auth', request as typeof fetch);
  assert.equal(await provider.getFeePayerPublicKey(), koraPayer.publicKey.toBase58());
  const authorization = { payload: 'cGF5bG9hZA', signature: 'signature' };
  assert.ok(await provider.signTransaction(input, { recoverAuthorization: authorization }));
  assert.deepEqual(calls, ['getPayerSigner', 'signTransaction']);
  assert.deepEqual(recoverAuthorization, authorization);
});

test('Kora boundary rejects a returned transaction whose authorized message changed', async () => {
  const user = Keypair.generate(); const koraPayer = Keypair.generate();
  const transaction = new Transaction({ feePayer: koraPayer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })); transaction.partialSign(user);
  const input = transaction.serialize({ requireAllSignatures: false }).toString('base64');
  const request = async (_url: string | URL | Request, init?: RequestInit) => { const payload = JSON.parse(String(init?.body)) as { method: string }; if (payload.method === 'getPayerSigner') return Response.json({ result: { signer_address: koraPayer.publicKey.toBase58() } }); const changed = Transaction.from(Buffer.from(input, 'base64')); changed.instructions[0].data[0] ^= 1; changed.partialSign(koraPayer); return Response.json({ result: { signer_pubkey: koraPayer.publicKey.toBase58(), signed_transaction: changed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') } }); };
  const provider = new KoraRelayerProvider('https://kora.invalid', 'auth', request as typeof fetch);
  await code(() => provider.signTransaction(input), 'RELAYER_POLICY_REJECTED');
});

test('Kora errors are categorized, bounded, sanitized, and release-eligible only for deterministic pre-sign policy rejection', async () => {
  const policy = new KoraRelayerProvider('https://kora.invalid', 'auth', (async () => Response.json({ error: { code: -32602, message: 'Invalid transaction: fee payer cannot create account token=secret https://rpc.invalid/?api-key=secret' } }, { status: 400 })) as typeof fetch);
  let caught: unknown; try { await policy.signTransaction('ignored'); } catch (error) { caught = error; }
  const failure = koraFailure(caught); assert.equal(failure?.category, 'KORA_POLICY_INVALID_TRANSACTION'); assert.equal(failure?.rpcCode, -32602); assert.equal(failure?.deterministicPreSignRejection, true); assert.equal(failure?.payerSignatureReturned, false); assert.ok((failure?.reason.length ?? 999) <= 256); assert.equal(failure?.reason.includes('secret'), false);
  const signerWordPolicy = new KoraRelayerProvider('https://kora.invalid', 'auth', (async () => Response.json({ error: { code: -32602, message: 'Invalid transaction: Swap requires exactly the configured payer and one user signer' } }, { status: 400 })) as typeof fetch);
  caught = undefined; try { await signerWordPolicy.signTransaction('ignored'); } catch (error) { caught = error; }
  assert.equal(koraFailure(caught)?.category, 'KORA_POLICY_INVALID_TRANSACTION'); assert.equal(koraFailure(caught)?.deterministicPreSignRejection, true);
  const timeout = new KoraRelayerProvider('https://kora.invalid', 'auth', (async () => { throw new Error('timeout'); }) as typeof fetch); caught = undefined; try { await timeout.signTransaction('ignored'); } catch (error) { caught = error; } assert.equal(koraFailure(caught)?.category, 'KORA_RPC_ERROR'); assert.equal(koraFailure(caught)?.deterministicPreSignRejection, false);
  for (const [status, category] of [[401, 'KORA_AUTH_ERROR'], [429, 'KORA_RATE_LIMIT'], [502, 'KORA_RPC_ERROR'], [200, 'KORA_MALFORMED_RESPONSE']] as const) {
    const malformed = new KoraRelayerProvider('https://kora.invalid', 'auth', (async () => new Response('not-json', { status })) as typeof fetch); caught = undefined; try { await malformed.signTransaction('ignored'); } catch (error) { caught = error; } assert.equal(koraFailure(caught)?.category, category); assert.equal(koraFailure(caught)?.deterministicPreSignRejection, false);
  }
});

test('automatic sponsorship release requires positive proof that payer signing and broadcast never occurred', () => {
  const policy = new KoraCallFailure('KORA_POLICY_INVALID_TRANSACTION', 'invalid transaction', 400, -32602, false, false, true);
  assert.equal(canReleaseAfterKoraFailure(policy, { payerSigned: false, broadcastAttempted: false }), true);
  assert.equal(canReleaseAfterKoraFailure(new KoraCallFailure('KORA_RPC_ERROR', 'timeout'), { payerSigned: false, broadcastAttempted: false }), false);
  assert.equal(canReleaseAfterKoraFailure(new KoraCallFailure('KORA_MALFORMED_RESPONSE', 'ambiguous', 502, undefined, true), { payerSigned: false, broadcastAttempted: false }), false);
  assert.equal(canReleaseAfterKoraFailure(policy, { payerSigned: true, broadcastAttempted: false }), false);
  assert.equal(canReleaseAfterKoraFailure(policy, { payerSigned: false, signature: 'known-signature', broadcastAttempted: false }), false);
  assert.equal(canReleaseAfterKoraFailure(policy, { payerSigned: false, broadcastAttempted: true }), false);
});

test('operator log values redact credential keys, inline credentials, URL queries, and bound strings', () => {
  const sanitized = sanitizeLogValue({
    authorization: 'Bearer secret',
    nested: { apiKey: 'secret', value: `https://rpc.invalid/path?api-key=secret ${'x'.repeat(600)}` },
    reason: 'token=secret',
  }) as Record<string, unknown>;
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal((sanitized.nested as Record<string, unknown>).apiKey, '[REDACTED]');
  assert.equal(String((sanitized.nested as Record<string, unknown>).value).includes('api-key=secret'), false);
  assert.ok(String((sanitized.nested as Record<string, unknown>).value).length <= 512);
  assert.equal(String(sanitized.reason).includes('secret'), false);
});
