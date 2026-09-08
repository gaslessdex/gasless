import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import test from 'node:test';
import { CrossChainService } from '../server/cross-chain/service.js';
import { CROSS_CHAIN_INPUTS, CROSS_CHAIN_OUTPUTS, ROBINHOOD_CHAIN_ID, SOLANA_RELAY_CHAIN_ID, inputAsset, outputAsset, parseCrossChainAmount } from '../server/cross-chain/registry.js';
import { RelayClient } from '../server/relay/client.js';
import { GaslessError } from '../server/errors.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';

const wallet = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey.toBase58();
const recipient = `0x${'a'.repeat(40)}`;

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function relayQuote(appFee = '0') { return { requestId: 'relay-request', steps: [{ kind: 'transaction', requestId: 'relay-request', items: [{ data: { instructions: [{}], addressLookupTableAddresses: [] }, check: { endpoint: '/intents/status/v3?requestId=relay-request' } }] }], details: { sender: wallet, recipient, currencyIn: { currency: { chainId: SOLANA_RELAY_CHAIN_ID, address: CROSS_CHAIN_INPUTS.USDC.address, symbol: 'USDC', decimals: 6 }, amount: '1000000', amountFormatted: '1.0', amountUsd: '1.0' }, currencyOut: { currency: { chainId: ROBINHOOD_CHAIN_ID, address: CROSS_CHAIN_OUTPUTS.USDG.address, symbol: 'USDG', decimals: 6 }, amount: '700000', amountFormatted: '0.7', minimumAmount: '680000' }, timeEstimate: 3 }, fees: { relayer: { amountFormatted: '0.28', amountUsd: '0.28', currency: { symbol: 'USDC' } }, app: { amountFormatted: appFee, amountUsd: appFee, currency: { symbol: 'USDC' } } } }; }

function fixture(appFeeBps = 0, executionWallets: string[] = [], publicExecution = false) {
  let payload: Record<string, unknown> | undefined; let calls = 0;
  const request = (async (url: string | URL | Request, init?: RequestInit) => { calls += 1; if (String(url).includes('/status/')) return response({ status: 'pending', originChainId: SOLANA_RELAY_CHAIN_ID, destinationChainId: ROBINHOOD_CHAIN_ID }); payload = JSON.parse(String(init?.body)); return response(relayQuote(appFeeBps ? '0.001' : '0')); }) as typeof fetch;
  const service = new CrossChainService(new MemoryTemporaryStore(), new RelayClient('server-secret', request), { getFeePayerPublicKey: async () => payer, signTransaction: async () => { throw new Error('must not sign'); } }, {} as never, {} as never, { enabled: true, publicExecution, executionWallets, appFeeRecipient: recipient, appFeeBps, quoteTtlSeconds: 120, maximumInputUsd: 10, maximumSponsoredCostLamports: 20_000 });
  return { service, payload: () => payload!, calls: () => calls };
}

test('server registry fixes exact V1 chains, assets, and decimals', () => {
  assert.equal(SOLANA_RELAY_CHAIN_ID, 792703809); assert.equal(ROBINHOOD_CHAIN_ID, 4663);
  assert.deepEqual(Object.keys(CROSS_CHAIN_INPUTS), ['SOL', 'USDC', 'USDT']); assert.deepEqual(Object.keys(CROSS_CHAIN_OUTPUTS), ['ETH', 'USDG']);
  assert.equal(parseCrossChainAmount('1.25', 6), '1250000');
  assert.throws(() => inputAsset('BONK')); assert.throws(() => outputAsset('WETH')); assert.throws(() => parseCrossChainAmount('0', 6));
});

test('quote binds all security-critical Relay fields to server policy', async () => {
  const f = fixture(10); const quote = await f.service.createQuote({ walletAddress: wallet, recipient, inputAsset: 'USDC', outputAsset: 'USDG', amount: '1' }); const payload = f.payload();
  assert.equal(payload.originChainId, SOLANA_RELAY_CHAIN_ID); assert.equal(payload.destinationChainId, ROBINHOOD_CHAIN_ID); assert.equal(payload.depositFeePayer, payer);
  assert.equal(payload.originCurrency, CROSS_CHAIN_INPUTS.USDC.address); assert.equal(payload.destinationCurrency, CROSS_CHAIN_OUTPUTS.USDG.address);
  assert.deepEqual(payload.appFees, [{ recipient, fee: '10' }]); assert.equal(quote.executionReady, false); assert.equal(quote.appFee.amount, '0.001');
});

test('zero BPS omits appFees and status is wallet-bound and normalized', async () => {
  const f = fixture(); const quote = await f.service.createQuote({ walletAddress: wallet, recipient, inputAsset: 'USDC', outputAsset: 'USDG', amount: '1' });
  assert.equal('appFees' in f.payload(), false); assert.equal((await f.service.status(quote.quoteId, wallet)).status, 'executing');
  await assert.rejects(() => f.service.status(quote.quoteId, payer), (error: unknown) => error instanceof GaslessError && error.code === 'QUOTE_EXPIRED');
});

test('execution readiness is exposed only to the dedicated server allowlist', async () => {
  const allowed = fixture(0, [wallet]);
  assert.equal((await allowed.service.createQuote({ walletAddress: wallet, recipient, inputAsset: 'USDC', outputAsset: 'USDG', amount: '1' })).executionReady, true);
  const denied = fixture();
  assert.equal((await denied.service.createQuote({ walletAddress: wallet, recipient, inputAsset: 'USDC', outputAsset: 'USDG', amount: '1' })).executionReady, false);
  await assert.rejects(() => denied.service.prepare('missing', wallet), (error: unknown) => error instanceof GaslessError && error.code === 'ACTION_DISABLED');
});

test('public execution readiness does not require a wallet allowlist', async () => {
  const publicService = fixture(0, [], true);
  assert.equal((await publicService.service.createQuote({ walletAddress: wallet, recipient, inputAsset: 'USDC', outputAsset: 'USDG', amount: '1' })).executionReady, true);
  await assert.rejects(() => publicService.service.prepare('missing', wallet), (error: unknown) => error instanceof GaslessError && error.code === 'QUOTE_EXPIRED');
});

test('missing API key, malformed recipient, and execution all fail closed', async () => {
  const missing = new RelayClient(undefined, (async () => { throw new Error('must not call'); }) as typeof fetch);
  await assert.rejects(() => missing.quote({}), (error: unknown) => error instanceof GaslessError && error.code === 'CONFIGURATION_ERROR');
  const f = fixture(); await assert.rejects(() => f.service.createQuote({ walletAddress: wallet, recipient: 'bad', inputAsset: 'USDC', outputAsset: 'USDG', amount: '1' }));
  await assert.rejects(() => f.service.prepare('missing', wallet), (error: unknown) => error instanceof GaslessError && error.code === 'ACTION_DISABLED');
});

test('Relay transient quote failures retry once and normalize the failure', async () => {
  let calls = 0; const client = new RelayClient('server-secret', (async () => { calls += 1; return response({ message: 'down' }, 503); }) as typeof fetch);
  await assert.rejects(() => client.quote({}), (error: unknown) => error instanceof GaslessError && error.code === 'RELAY_UNAVAILABLE'); assert.equal(calls, 2);
});
