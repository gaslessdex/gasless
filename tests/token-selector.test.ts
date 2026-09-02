import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { financialTokenSelectionLocked } from '../src/components/ui/financialControlState.js';

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

before(async () => {
  server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 41789, strictPort: true } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Token-selector test server did not start.');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

type Harness = { context: BrowserContext; page: Page };

async function harness(options: { touch?: boolean; twoSelectors?: boolean } = {}): Promise<Harness> {
  const context = await browser.newContext({ hasTouch: options.touch, isMobile: options.touch, viewport: { width: 480, height: 760 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`token-selector page error: ${error.message}`));
  await page.goto(baseUrl);
  await page.setContent('<main><button id="underlying" type="button">Underlying</button><div id="root"></div></main>');
  await page.addStyleTag({ content: '#underlying{position:absolute;inset:0}#root{position:relative;z-index:1}.token-picker-scrim{position:fixed;inset:0;z-index:2}.token-picker{background:white}' });
  await page.addScriptTag({ type: 'module', content: `
    import React from '/@id/react';
    import ReactDOMClient from '/@id/react-dom/client';
    import { TokenSelector } from '/src/components/ui/TransactionControls.tsx';
    const initial = [
      { id: 'usdc', mint: 'USDCMint', program: 'TokenProgram', symbol: 'USDC', name: 'USD Coin', balance: '2.01', eligible: true },
      { id: 'usdt', mint: 'USDTMint', program: 'TokenProgram', symbol: 'USDT', name: 'Tether USD', balance: '3.00', eligible: true },
    ];
    let controls;
    function Harness() {
      const [tokens, setTokens] = React.useState(initial);
      const [value, setValue] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);
      const [changes, setChanges] = React.useState(0);
      controls = { setTokens, setRefreshing, changes: () => changes, selected: () => value?.symbol ?? null };
      const picker = React.createElement(TokenSelector, { label: 'Token to send', value, tokens, onChange: (token) => { setValue(token); setChanges((n) => n + 1); } });
      const second = ${options.twoSelectors ? "React.createElement(TokenSelector, { label: 'Pay with', value: null, tokens, onChange: () => {} })" : 'null'};
      return React.createElement('section', { 'data-refreshing': refreshing }, picker, second);
    }
    document.querySelector('#underlying').addEventListener('click', () => window.__underlyingClicks = (window.__underlyingClicks || 0) + 1);
    window.__underlyingClicks = 0;
    window.__selectorHarness = () => controls;
    ReactDOMClient.createRoot(document.querySelector('#root')).render(React.createElement(Harness));
  ` });
  await page.locator('.token-trigger').first().waitFor({ timeout: 5_000 });
  return { context, page };
}

async function close(h: Harness) {
  await h.page.getByRole('button', { name: 'Close token selector' }).click();
}

test('selector stays interactive during loading/refresh and locks only for financial execution', () => {
  for (const state of ['disconnected', 'loading', 'empty', 'entry', 'checking', 'review', 'confirmed', 'stale', 'failure', 'quoting', 'refreshing-quote']) assert.equal(financialTokenSelectionLocked(state), false, state);
  for (const state of ['validating', 'preparing', 'awaiting-signature', 'submitting']) assert.equal(financialTokenSelectionLocked(state), true, state);
});

test('first click opens exactly one picker', async () => {
  const h = await harness();
  await h.page.locator('.token-trigger').click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  assert.equal(await h.page.locator('.token-trigger').getAttribute('aria-expanded'), 'true');
  await h.context.close();
});

test('symbol, name, and chevron areas each open on their first click', async () => {
  const h = await harness();
  const trigger = h.page.locator('.token-trigger');
  await trigger.locator('strong').click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await close(h);
  await trigger.locator('span').click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await close(h);
  await trigger.locator('i').click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await h.context.close();
});

test('Enter opens the picker once', async () => {
  const h = await harness();
  await h.page.locator('.token-trigger').press('Enter');
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await h.context.close();
});

test('Space opens the picker once', async () => {
  const h = await harness();
  await h.page.locator('.token-trigger').press('Space');
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await h.context.close();
});

test('touch opens on the first tap', async () => {
  const h = await harness({ touch: true });
  await h.page.locator('.token-trigger').tap();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await h.context.close();
});

test('no underlying element steals the first interaction', async () => {
  const h = await harness();
  await h.page.locator('.token-trigger').click();
  assert.equal(await h.page.evaluate(() => (window as unknown as { __underlyingClicks: number }).__underlyingClicks), 0);
  await h.context.close();
});

test('closing then reopening works on the first click', async () => {
  const h = await harness();
  const trigger = h.page.locator('.token-trigger');
  await trigger.click();
  await close(h);
  await trigger.click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await h.context.close();
});

test('selecting a token closes the picker and records one selection', async () => {
  const h = await harness();
  await h.page.locator('.token-trigger').click();
  await h.page.getByRole('option', { name: /USDC/ }).click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 0);
  assert.equal(await h.page.evaluate(() => (window as unknown as { __selectorHarness: () => { changes: () => number } }).__selectorHarness().changes()), 1);
  await h.context.close();
});

test('reopening after selection works on the first click', async () => {
  const h = await harness();
  await h.page.locator('.token-trigger').click();
  await h.page.getByRole('option', { name: /USDC/ }).click();
  await h.page.locator('.token-trigger').click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await h.context.close();
});

test('balance refresh does not swallow the opening click', async () => {
  const h = await harness();
  await h.page.evaluate(() => (window as unknown as { __selectorHarness: () => { setRefreshing: (value: boolean) => void } }).__selectorHarness().setRefreshing(true));
  const trigger = h.page.locator('.token-trigger');
  assert.equal(await trigger.isEnabled(), true);
  await trigger.click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await h.context.close();
});

test('SEND and SWAP selectors share independent single-open behavior', async () => {
  const h = await harness({ twoSelectors: true });
  await h.page.locator('.token-trigger').first().click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Token to send token' }).count(), 1);
  await close(h);
  await h.page.locator('.token-trigger').last().click();
  assert.equal(await h.page.getByRole('dialog', { name: 'Pay with token' }).count(), 1);
  assert.equal(await h.page.getByRole('dialog').count(), 1);
  await h.context.close();
});

test('one interaction cannot duplicate the modal or animation surface', async () => {
  const h = await harness();
  await h.page.locator('.token-trigger i').click();
  assert.equal(await h.page.locator('.token-picker-scrim').count(), 1);
  assert.equal(await h.page.locator('.token-picker').count(), 1);
  await h.context.close();
});
