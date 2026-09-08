import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const cases = [
  ...['dark', 'light'].flatMap((theme) => ['bridge', 'swap'].map((entry) => ({ width: 1280, height: 900, theme, entry }))),
  ...['dark', 'light'].flatMap((theme) => ['bridge', 'swap'].map((entry) => ({ width: 390, height: 844, theme, entry }))),
  { width: 320, height: 800, theme: 'dark', entry: 'bridge' },
];

const screenshotDirectory = join(tmpdir(), 'gasless-cross-chain-layout');
await mkdir(screenshotDirectory, { recursive: true });
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 4181 } });
await server.listen();
const origin = server.resolvedUrls?.local[0];
if (!origin) throw new Error('Vite did not expose a local test URL.');

const browser = await chromium.launch({ headless: true });
try {
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: item.width, height: item.height }, reducedMotion: 'reduce', colorScheme: item.theme });
    await page.addInitScript((theme) => {
      localStorage.setItem('gasless-theme', theme);
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (String(type).startsWith('webgl')) return null;
        return original.call(this, type, ...args);
      };
    }, item.theme);
    await page.route('**/api/browser-verification/status', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/public/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ networkLabel: 'DEVNET', gaslessStatus: 'operational', sponsorshipAvailable: true, supportedTokenCount: 0 }) }));
    await page.route('**/api/public/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ network: 'solana', totals: { successfulActions: 0, sponsoredLamports: '0', supportedTokens: 0, byAction: {} } }) }));
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.locator('.loading-sequence').waitFor({ state: 'detached' });

    if (item.entry === 'bridge') {
      await page.getByRole('button', { name: 'Open Send.' }).click();
      await page.getByRole('tab', { name: 'BRIDGE' }).click();
    } else {
      await page.getByRole('button', { name: 'Open Swap.' }).click();
      await page.getByRole('tab', { name: 'CROSS-CHAIN' }).click();
    }

    const panel = page.locator('.cross-chain-panel');
    await panel.waitFor({ state: 'visible' });
    const layout = await panel.evaluate((node) => {
      const bounds = (selector) => {
        const box = node.querySelector(selector).getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      const action = node.querySelector(':scope > .console-primary');
      const details = node.querySelector(':scope > .advanced-details');
      return {
        fromLabel: bounds('.cross-chain-route > div:first-child > span'),
        fromValue: bounds('.cross-chain-route > div:first-child > strong'),
        toLabel: bounds('.cross-chain-route > div:last-child > span'),
        destination: bounds('.cross-chain-select--destination'),
        actionBeforeDetails: Boolean(action && details && (action.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING)),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });

    const context = `${item.entry} ${item.theme} ${item.width}px`;
    assert.ok(Math.abs(layout.fromLabel.left - layout.fromValue.left) <= 1, `${context}: FROM is not aligned with Solana`);
    assert.ok(Math.abs(layout.toLabel.left - layout.destination.left) <= 1, `${context}: TO is not aligned with the destination selector`);
    assert.equal(layout.actionBeforeDetails, true, `${context}: Fees & Details does not directly follow the primary action`);
    assert.equal(layout.scrollWidth, layout.clientWidth, `${context}: horizontal overflow appeared`);
    assert.equal(await panel.locator('.cross-chain-sponsored').count(), 0, `${context}: primary network-fee row is still present`);
    assert.doesNotMatch(await panel.locator('.cross-chain-route').innerText(), /→/, `${context}: route arrow is present`);
    if (item.width <= 360) assert.ok(layout.toLabel.top > layout.fromValue.bottom, `${context}: narrow route blocks did not stack`);
    else assert.ok(layout.destination.left > layout.fromValue.right, `${context}: route columns overlap`);

    const destination = panel.getByRole('button', { name: 'Destination network' });
    await destination.click();
    const options = panel.getByRole('listbox', { name: 'Destination network' }).getByRole('option');
    assert.equal(await options.count(), 3, `${context}: destination options changed`);
    assert.equal(await options.nth(0).isDisabled(), false, `${context}: Robinhood Chain is disabled`);
    assert.equal(await options.nth(1).isDisabled(), true, `${context}: Base is enabled`);
    assert.equal(await options.nth(2).isDisabled(), true, `${context}: BNB Chain is enabled`);
    await page.keyboard.press('Escape');

    await panel.locator('.advanced-details > summary').click();
    const networkFee = panel.locator('.detail-row').filter({ hasText: 'Network fee' });
    assert.match(await networkFee.innerText(), /Network fee\s+Covered by GASLESS/i, `${context}: sponsorship detail is missing`);
    await panel.screenshot({ path: join(screenshotDirectory, `${item.entry}-${item.theme}-${item.width}.png`) });
    await page.close();
  }
  console.log(`Cross-chain layout passed ${cases.length} shared-panel cases. Screenshots: ${screenshotDirectory}`);
} finally {
  await browser.close();
  await server.close();
}
