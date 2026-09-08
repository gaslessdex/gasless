import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PRODUCT_NETWORKS } from '../src/config/productNetworks.js';

test('multichain frontend config keeps Solana live and EVM actions preview-only', () => {
  assert.deepEqual(PRODUCT_NETWORKS.map(({ id, ecosystem, productionFunctional, actions }) => ({ id, ecosystem, productionFunctional, actions })), [
    { id: 'solana', ecosystem: 'svm', productionFunctional: true, actions: ['claim', 'swap', 'send'] },
    { id: 'robinhood', ecosystem: 'evm', productionFunctional: false, actions: ['bridge', 'swap', 'send'] },
    { id: 'base', ecosystem: 'evm', productionFunctional: false, actions: ['bridge', 'swap', 'send'] },
    { id: 'bnb', ecosystem: 'evm', productionFunctional: false, actions: ['bridge', 'swap', 'send'] },
  ]);
});

test('EVM previews cannot call transaction APIs and primary overlays lock top utilities', () => {
  const preview = readFileSync('src/components/ui/EvmPreviewConsole.tsx', 'utf8');
  const app = readFileSync('src/app/App.tsx', 'utf8');
  const hud = readFileSync('src/components/ui/TopHud.tsx', 'utf8');
  assert.doesNotMatch(preview, /fetch\(|\/api\//);
  assert.match(preview, /COMING SOON/);
  assert.match(app, /interactionLocked=\{Boolean\(feature \|\| faqOpen \|\| menuOpen\)\}/);
  assert.match(hud, /disabled=\{interactionLocked\}/);
});

test('FAQ and navigation use multichain copy and canonical public links', () => {
  const faq = readFileSync('src/components/ui/FaqConsole.tsx', 'utf8');
  const nav = readFileSync('src/components/ui/racing/CockpitAnchor.tsx', 'utf8');
  assert.match(faq, /Robinhood Chain/);
  assert.match(faq, /LEGAL &amp; PRIVACY/);
  assert.match(faq, /Wallet addresses and transaction metadata may be processed/);
  assert.match(nav, /https:\/\/github\.com\/gaslessdex/);
  assert.doesNotMatch(nav, /gasless-khaki/);
});
