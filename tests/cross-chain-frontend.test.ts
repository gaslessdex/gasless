import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CROSS_CHAIN_DESTINATIONS,
  CROSS_CHAIN_INPUT_ASSETS,
  CROSS_CHAIN_OUTPUT_ASSETS,
  CROSS_CHAIN_SOURCE,
} from '../src/config/crossChain.js';
import { nextEnabledOption } from '../src/features/cross-chain/selectorNavigation.js';
import { crossChainFailurePresentation, crossChainStatusPresentation } from '../src/features/cross-chain/status.js';
import { crossChainAmountError, crossChainRecipientError } from '../src/features/cross-chain/validation.js';

test('cross-chain V1 config exposes only the approved route and assets', () => {
  assert.deepEqual(CROSS_CHAIN_SOURCE, { id: 'solana', name: 'Solana' });
  assert.deepEqual(CROSS_CHAIN_DESTINATIONS.map(({ id, name, enabled }) => ({ id, name, enabled })), [
    { id: 'robinhood', name: 'Robinhood Chain', enabled: true },
    { id: 'base', name: 'Base', enabled: false },
    { id: 'bnb', name: 'BNB Chain', enabled: false },
  ]);
  assert.equal(CROSS_CHAIN_DESTINATIONS[0].chainId, 4663);
  assert.deepEqual(CROSS_CHAIN_DESTINATIONS[1].outputs, []);
  assert.deepEqual(CROSS_CHAIN_DESTINATIONS[2].outputs, []);
  assert.deepEqual(CROSS_CHAIN_INPUT_ASSETS.map(({ symbol }) => symbol), ['SOL', 'USDC', 'USDT']);
  assert.deepEqual(CROSS_CHAIN_OUTPUT_ASSETS.map(({ symbol }) => symbol), ['ETH', 'USDG']);
});

test('custom selector keyboard navigation skips disabled destinations', () => {
  const options = CROSS_CHAIN_DESTINATIONS.map(({ id, name, enabled }) => ({ value: id, label: name, disabled: !enabled }));
  assert.equal(nextEnabledOption(options, 0, 1), 0);
  assert.equal(nextEnabledOption(options, 2, -1), 0);
});

test('cross-chain amount validation rejects malformed and non-positive values', () => {
  for (const value of ['0', '-1', '1e3', '1.2.3', '12.', 'abc']) assert.ok(crossChainAmountError(value), value);
  for (const value of ['.5', '0.5', '1', '12.25']) assert.equal(crossChainAmountError(value), '', value);
});

test('cross-chain recipient validation accepts exactly one EVM address format', () => {
  assert.equal(crossChainRecipientError(`0x${'a'.repeat(40)}`), '');
  for (const value of [`0x${'a'.repeat(39)}`, `0x${'a'.repeat(41)}`, `0x${'g'.repeat(40)}`, 'not-an-address']) assert.ok(crossChainRecipientError(value), value);
});

test('Send and Swap default to their existing panels and reuse CrossChainPanel', () => {
  const send = readFileSync('src/features/send/components/SendConsole.tsx', 'utf8');
  const swap = readFileSync('src/features/swap/components/SwapConsole.tsx', 'utf8');
  assert.match(send, /useState<'send' \| 'bridge'>\('send'\)/);
  assert.match(send, /<SolanaSendPanel connected=\{connected\}/);
  assert.match(send, /<CrossChainPanel entryMode="bridge"/);
  assert.match(swap, /useState<'swap' \| 'cross-chain'>\('swap'\)/);
  assert.match(swap, /<SolanaSwapPanel connected=\{connected\}/);
  assert.match(swap, /<CrossChainPanel entryMode="swap"/);
});

test('cross-chain panel reuses the private backend lifecycle without exposing a Gasless toggle', () => {
  const panel = readFileSync('src/features/cross-chain/CrossChainPanel.tsx', 'utf8');
  const selector = readFileSync('src/features/cross-chain/CrossChainSelect.tsx', 'utf8');
  assert.doesNotMatch(panel, /GaslessStatus|toggle/i);
  assert.doesNotMatch(panel, /<select|cross-chain-transfer/);
  assert.doesNotMatch(panel, /cross-chain-sponsored/);
  assert.match(panel, /DetailRow label="Network fee" value="Covered by GASLESS"/);
  assert.match(panel, /\/api\/cross-chain\/quote/);
  assert.match(panel, /450/);
  assert.match(panel, /request\.current\?\.abort/);
  assert.match(panel, /LIVE RELAY QUOTE/);
  assert.doesNotMatch(panel, /EXECUTION LOCKED/);
  assert.match(panel, /\/api\/cross-chain\/build/);
  assert.match(panel, /\/api\/cross-chain\/submit/);
  assert.match(panel, /\/api\/cross-chain\/status/);
  assert.match(panel, /wallet\.signTransaction/);
  assert.match(panel, /PRIVATE TESTING/);
  assert.match(panel, /destination\.outputs\.map/);
  assert.match(selector, /role="listbox"/);
  assert.match(selector, /aria-disabled/);
  assert.match(selector, /event\.key === 'Escape'/);
  assert.match(selector, /document\.addEventListener\('pointerdown'/);
});

test('cross-chain status copy stays simple and maps every permanent user state', () => {
  assert.equal(crossChainStatusPresentation('preparing').label, 'PREPARING');
  assert.equal(crossChainStatusPresentation('awaiting_signature').label, 'WAITING FOR SIGNATURE');
  assert.equal(crossChainStatusPresentation('sending').label, 'SENDING');
  assert.equal(crossChainStatusPresentation('executing').label, 'BRIDGING');
  assert.equal(crossChainStatusPresentation('destination_confirmed').label, 'ARRIVING');
  assert.equal(crossChainStatusPresentation('completed').label, 'COMPLETE');
  assert.equal(crossChainStatusPresentation('unknown_retryable').label, 'BRIDGE DELAYED');
  assert.equal(crossChainStatusPresentation('refund_pending').label, 'REFUND PENDING');
  assert.equal(crossChainFailurePresentation('ROUTE_UNAVAILABLE').label, 'ROUTE UNAVAILABLE');
  assert.equal(crossChainFailurePresentation('QUOTE_EXPIRED').label, 'QUOTE EXPIRED');
  assert.equal(crossChainFailurePresentation('SIMULATION_FAILED').label, 'TRANSACTION FAILED');
});
