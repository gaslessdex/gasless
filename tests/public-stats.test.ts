import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildPublicStats } from '../server/operator/public-data.js';
import { MemoryDurableStore } from '../server/storage/durable.js';
import { formatPublicNetworkFee, selectPublicNetworkStats, type PublicStatsResponse } from '../shared/stats/public.js';
import type { DurableTransactionRecord, TransactionAction, TransactionStatus } from '../shared/transactions/types.js';

const now = new Date().toISOString();

function record(id: string, intentId: string, actionType: TransactionAction, status: TransactionStatus = 'reconciled', extra: Partial<DurableTransactionRecord> = {}): DurableTransactionRecord {
  return { id, intentId, quoteId: intentId, walletAddress: `wallet-${intentId}`, actionType, network: 'mainnet-beta', status, sponsoredCostLamports: '1000', createdAt: now, updatedAt: now, ...extra };
}

test('public stats classify reconciled logical actions without cross-chain double counting', async () => {
  const store = new MemoryDurableStore();
  const records = [
    record('claim-1', 'claim', 'CLEAN_CLAIM', 'reconciled', { batchIndex: 0 }),
    record('claim-2', 'claim', 'CLEAN_CLAIM', 'reconciled', { batchIndex: 1 }),
    record('recover', 'recover', 'CLEAN_RECOVER'),
    record('burn', 'burn', 'CLEAN_BURN'),
    record('swap', 'swap', 'SWAP'),
    record('send', 'send', 'SEND'),
    record('bridge', 'bridge', 'CROSS_CHAIN', 'reconciled', { sourceAsset: 'USDC', destinationAsset: 'USDG', destinationChainId: 4663, sponsoredCostLamports: '10000', networkFeeLamports: '5000' }),
    record('cross-swap', 'cross-swap', 'CROSS_CHAIN', 'reconciled', { sourceAsset: 'USDC', destinationAsset: 'ETH', destinationChainId: 4663, sponsoredCostLamports: '10000', networkFeeLamports: '6000' }),
    record('internal', 'internal', 'DEVNET_PROOF'),
    record('failed-swap', 'failed-swap', 'SWAP', 'failed'),
    record('confirmed-send', 'confirmed-send', 'SEND', 'confirmed'),
  ];
  for (const item of records) await store.createTransaction(item);

  const output = buildPublicStats('mainnet-beta', await store.getOperatorMetrics('mainnet-beta'), 4);
  assert.deepEqual(output.networks.solana.actions, { cleanActions: 3, swaps: 1, sends: 1, crossChainActions: 2 });
  assert.equal(output.networks.solana.totalGaslessActions, 7);
  assert.equal(output.networks.solana.transactionsSponsored, 8);
  assert.equal(output.networks.solana.networkFeesSponsored?.atomicAmount, '17000');
  assert.equal(output.networks.solana.supportedTokens, 4);
  assert.deepEqual(output.networks.robinhood.actions, { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 2 });
  assert.equal(output.networks.robinhood.totalGaslessActions, 2);
  assert.equal(output.networks.robinhood.transactionsSponsored, 0);
  assert.equal(output.networks.robinhood.networkFeesSponsored, null);
  assert.deepEqual(output.networks.base, { totalGaslessActions: 0, transactionsSponsored: 0, actions: { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 0 }, networkFeesSponsored: null, supportedTokens: 0 });
  assert.deepEqual(output.networks.bnb, output.networks.base);
  assert.equal(output.totals.byAction.CLEAN_CLAIM, 2, 'legacy action-type totals remain available');
});

test('a partially reconciled multi-transaction intent is not a successful logical action', async () => {
  const store = new MemoryDurableStore();
  await store.createTransaction(record('claim-ok', 'claim', 'CLEAN_CLAIM'));
  await store.createTransaction(record('claim-pending', 'claim', 'CLEAN_CLAIM', 'submitted'));
  const output = buildPublicStats('mainnet-beta', await store.getOperatorMetrics('mainnet-beta'));
  assert.equal(output.networks.solana.actions.cleanActions, 0);
  assert.equal(output.networks.solana.totalGaslessActions, 0);
  assert.equal(output.networks.solana.transactionsSponsored, 1);
});

test('the frontend safely normalizes legacy, empty, and malformed stats responses', () => {
  const legacy: PublicStatsResponse = { totals: { successfulActions: 6, sponsoredLamports: '12300000', supportedTokens: 3, byAction: { CLEAN_CLAIM: 1, CLEAN_RECOVER: 1, CLEAN_BURN: 1, SWAP: 1, SEND: 1, CROSS_CHAIN: 1 } } };
  const solana = selectPublicNetworkStats(legacy, 'solana');
  assert.deepEqual(solana.actions, { cleanActions: 3, swaps: 1, sends: 1, crossChainActions: 1 });
  assert.equal(solana.totalGaslessActions, 6);
  assert.equal(formatPublicNetworkFee(solana.networkFeesSponsored), '0.01230 SOL');
  assert.equal(selectPublicNetworkStats(legacy, 'robinhood').totalGaslessActions, 0);
  assert.deepEqual(selectPublicNetworkStats(legacy, 'robinhood').actions, { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 0 });
  assert.deepEqual(selectPublicNetworkStats({ networks: { base: { actions: { bridgeActions: 5 } } } }, 'base').actions, { bridgeActions: 5, swaps: 0, sends: 0, crossChainActions: 0 });
  assert.equal(selectPublicNetworkStats({ networks: { solana: { totalGaslessActions: Number.NaN, transactionsSponsored: -1, actions: { crossChainActions: Number.NaN }, supportedTokens: Number.NaN } } }, 'solana').actions.crossChainActions, 0);
  assert.equal(formatPublicNetworkFee(null), '—');
});

test('the public drawer renders the network-specific primary action metric and no Clean subtype cards', () => {
  const source = readFileSync('src/components/ui/drawers/StatsDrawer.tsx', 'utf8');
  assert.match(source, /\['CLEAN ACTIONS', selected\.actions\.cleanActions/);
  assert.match(source, /\['BRIDGE ACTIONS', selected\.actions\.bridgeActions/);
  assert.doesNotMatch(source, /\['(?:CLAIM SOL|RECOVER VALUE|BURNS)'/);
});
