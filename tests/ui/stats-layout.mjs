import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const viewports = [
  { width: 1920, height: 1080 },
  { width: 1728, height: 1117 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];

const publicStats = {
  schemaVersion: 'public-stats-v2',
  network: 'mainnet-beta',
  totals: { successfulActions: 17, sponsoredTransactions: 19, sponsoredLamports: '12345678', supportedTokens: 8, byAction: {}, byActionFamily: { cleanActions: 6, swaps: 4, sends: 3, crossChainActions: 4 } },
  networks: {
    solana: { totalGaslessActions: 17, transactionsSponsored: 19, actions: { cleanActions: 6, swaps: 4, sends: 3, crossChainActions: 4 }, networkFeesSponsored: { atomicAmount: '12345678', decimals: 9, symbol: 'SOL' }, supportedTokens: 8 },
    robinhood: { totalGaslessActions: 4, transactionsSponsored: 0, actions: { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 4 }, networkFeesSponsored: null, supportedTokens: 0 },
    base: { totalGaslessActions: 0, transactionsSponsored: 0, actions: { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 0 }, networkFeesSponsored: null, supportedTokens: 0 },
    bnb: { totalGaslessActions: 0, transactionsSponsored: 0, actions: { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 0 }, networkFeesSponsored: null, supportedTokens: 0 },
  },
};

const solanaLabels = ['TRANSACTIONS SPONSORED', 'CLEAN ACTIONS', 'SWAPS', 'SENDS', 'CROSS-CHAIN ACTIONS', 'NETWORK FEES SPONSORED', 'SUPPORTED TOKENS'];
const evmLabels = ['TRANSACTIONS SPONSORED', 'BRIDGE ACTIONS', 'SWAPS', 'SENDS', 'CROSS-CHAIN ACTIONS', 'NETWORK FEES SPONSORED', 'SUPPORTED TOKENS'];

const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 4179 } });
await server.listen();
const origin = server.resolvedUrls?.local[0];
if (!origin) throw new Error('Vite did not expose a local test URL.');

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' });
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (String(type).startsWith('webgl')) return null;
        return original.call(this, type, ...args);
      };
    });
    await page.route('**/api/browser-verification/status', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/public/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(publicStats) }));
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.locator('.loading-sequence').waitFor({ state: 'detached' });

    const geometry = () => page.evaluate(() => {
      const rect = (selector) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        return bounds ? { left: +bounds.left.toFixed(3), width: +bounds.width.toFixed(3) } : null;
      };
      const drawer = document.querySelector('#stats-drawer');
      return {
        scrollX,
        innerWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyWidth: +document.body.getBoundingClientRect().width.toFixed(3),
        scrollWidth: document.documentElement.scrollWidth,
        shell: rect('.app-shell'),
        scene: rect('.scene-layer'),
        car: rect('.car-rig'),
        theme: rect('.theme-toggle'),
        network: rect('.hud-tab--left'),
        drawer: drawer ? { right: +drawer.getBoundingClientRect().right.toFixed(3), overflowY: getComputedStyle(drawer).overflowY, clientHeight: drawer.clientHeight, scrollHeight: drawer.scrollHeight } : null,
      };
    });

    for (const theme of ['dark', 'light']) {
      await page.getByLabel(`Use ${theme} theme`).click();
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.waitForTimeout(400);
      const baseline = await geometry();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.locator('.hud-tab--right').hover();
        await page.locator('.hud-tab--right').click();
        await page.waitForTimeout(750);
        assert.deepEqual(await page.locator('#stats-drawer dt').allTextContents(), solanaLabels, `${theme} ${viewport.width}: Solana metric taxonomy changed`);
        assert.equal(await page.locator('#stats-drawer').getByText('CLAIM SOL', { exact: true }).count(), 0);
        assert.equal(await page.locator('#stats-drawer').getByText('RECOVER VALUE', { exact: true }).count(), 0);
        assert.equal(await page.locator('#stats-drawer').getByText('BURNS', { exact: true }).count(), 0);
        if (attempt === 0) {
          assert.equal(await page.locator('.stats-hero strong').innerText(), '17');
          assert.deepEqual(await page.locator('#stats-drawer dd').allTextContents(), ['19', '6', '4', '3', '4', '0.01234 SOL', '8']);
          await page.getByRole('tab', { name: 'ROBINHOOD' }).click();
          assert.equal(await page.locator('.stats-hero strong').innerText(), '4');
          assert.deepEqual(await page.locator('#stats-drawer dt').allTextContents(), evmLabels);
          assert.deepEqual(await page.locator('#stats-drawer dd').allTextContents(), ['0', '0', '0', '0', '4', '—', '0']);
          await page.getByRole('tab', { name: 'BASE', exact: true }).click();
          assert.equal(await page.locator('.stats-hero strong').innerText(), '0');
          assert.deepEqual(await page.locator('#stats-drawer dt').allTextContents(), evmLabels);
          assert.deepEqual(await page.locator('#stats-drawer dd').allTextContents(), ['0', '0', '0', '0', '0', '—', '0']);
          await page.getByRole('tab', { name: 'BNB', exact: true }).click();
          assert.deepEqual(await page.locator('#stats-drawer dt').allTextContents(), evmLabels);
          await page.getByRole('tab', { name: 'SOLANA' }).click();
          assert.deepEqual(await page.locator('#stats-drawer dt').allTextContents(), solanaLabels);
        }
        const opened = await geometry();
        assert.deepEqual(opened.shell, baseline.shell, `${theme} ${viewport.width}: app shell moved`);
        assert.deepEqual(opened.scene, baseline.scene, `${theme} ${viewport.width}: scene moved`);
        assert.deepEqual(opened.car, baseline.car, `${theme} ${viewport.width}: car moved`);
        assert.deepEqual(opened.theme, baseline.theme, `${theme} ${viewport.width}: theme toggle moved`);
        assert.deepEqual(opened.network, baseline.network, `${theme} ${viewport.width}: network control moved`);
        assert.equal(opened.scrollX, 0, `${theme} ${viewport.width}: document scrolled horizontally`);
        assert.equal(opened.innerWidth, opened.clientWidth, `${theme} ${viewport.width}: viewport width changed`);
        assert.equal(opened.bodyWidth, opened.clientWidth, `${theme} ${viewport.width}: body width changed`);
        assert.equal(opened.scrollWidth, opened.clientWidth, `${theme} ${viewport.width}: horizontal overflow appeared`);
        assert.ok(Math.abs((opened.drawer?.right ?? 0) - viewport.width) <= 1, `${theme} ${viewport.width}: Stats drawer right edge was ${opened.drawer?.right}`);
        assert.equal(opened.drawer?.overflowY, 'auto', `${theme} ${viewport.width}: Stats drawer lost internal scrolling`);
        assert.ok((opened.drawer?.scrollHeight ?? 1) <= (opened.drawer?.clientHeight ?? 0), `${theme} ${viewport.width}: Stats drawer still requires desktop scrolling`);

        await page.getByLabel('Close stats panel').click();
        await page.waitForTimeout(400);
        const closed = await geometry();
        assert.deepEqual(closed.scene, baseline.scene, `${theme} ${viewport.width}: scene moved after close`);
        assert.equal(closed.scrollX, 0, `${theme} ${viewport.width}: document remained horizontally scrolled`);
      }

      await page.locator('.hud-tab--left').click();
      await page.waitForTimeout(750);
      const networkOpened = await geometry();
      assert.deepEqual(networkOpened.shell, baseline.shell, `${theme} ${viewport.width}: Network changed the app shell`);
      assert.deepEqual(networkOpened.scene, baseline.scene, `${theme} ${viewport.width}: Network moved the scene`);
      assert.deepEqual(networkOpened.car, baseline.car, `${theme} ${viewport.width}: Network moved the car`);
      assert.equal(networkOpened.scrollX, 0, `${theme} ${viewport.width}: Network scrolled the document horizontally`);
      assert.equal(await page.locator('#network-drawer .drawer-footer').count(), 0, `${theme} ${viewport.width}: Network footer returned`);
      await page.getByLabel('Close network panel').click();
      await page.waitForTimeout(400);

      assert.equal(await page.locator('#stats-drawer .drawer-footer').count(), 0, `${theme} ${viewport.width}: Stats footer returned`);

      await page.getByRole('button', { name: 'Open Clean tools.' }).click();
      await page.getByRole('tab', { name: 'RECOVER VALUE' }).click();
      assert.equal(await page.locator('#clean-panel-recover .selector-field').count(), 1, `${theme} ${viewport.width}: Recover selector is nested`);
      assert.equal(await page.locator('#clean-panel-recover .token-trigger').getByText('SELECT TOKEN').count(), 1, `${theme} ${viewport.width}: Recover empty label changed`);
      await page.getByRole('tab', { name: 'BURN' }).click();
      assert.equal(await page.locator('#clean-panel-burn .selector-field').count(), 1, `${theme} ${viewport.width}: Burn selector is nested`);
      assert.match(await page.locator('#clean-panel-burn .burn-warning').innerText(), /cannot be undone/i);
      await page.getByLabel('Close CLEAN').click();
      await page.waitForTimeout(300);

      await page.getByRole('button', { name: 'Open Swap.' }).click();
      const swapFields = page.locator('.swap-body .transaction-field');
      assert.equal(await swapFields.count(), 2, `${theme} ${viewport.width}: Swap field structure changed`);
      const consoleHud = await page.evaluate(() => {
        const consoleBounds = document.querySelector('.feature-console').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.hud-tab')].map((node) => ({ display: getComputedStyle(node).display, ...node.getBoundingClientRect().toJSON() }));
        return { consoleBounds: consoleBounds.toJSON(), controls };
      });
      for (const control of consoleHud.controls.filter((item) => item.display !== 'none')) {
        const overlaps = control.left < consoleHud.consoleBounds.right && control.right > consoleHud.consoleBounds.left && control.top < consoleHud.consoleBounds.bottom && control.bottom > consoleHud.consoleBounds.top;
        assert.equal(overlaps, false, `${theme} ${viewport.width}: top HUD overlaps the open console`);
      }
      assert.equal(await page.getByText('APPROVED TOKENS', { exact: true }).count(), 0);
      assert.equal(await page.getByText('MINIMUM PROTECTED', { exact: true }).count(), 0);
      const direction = page.getByRole('button', { name: 'Swap token direction' });
      const directionBox = await direction.boundingBox();
      const payBox = await swapFields.first().boundingBox();
      const receiveBox = await swapFields.last().boundingBox();
      assert.ok(directionBox && payBox && receiveBox);
      assert.ok(Math.abs((directionBox.x + directionBox.width / 2) - viewport.width / 2) <= 1, `${theme} ${viewport.width}: direction control is off center`);
      assert.ok(directionBox.y < receiveBox.y && directionBox.y + directionBox.height > payBox.y + payBox.height, `${theme} ${viewport.width}: direction control left the field boundary`);
      await page.locator('.swap-body .advanced-details > summary').click();
      const slippage = page.locator('#swap-slippage');
      await slippage.click();
      assert.equal(await page.getByRole('listbox', { name: 'Slippage' }).count(), 1);
      await page.getByRole('option', { name: /0\.30%/ }).press('ArrowDown');
      await page.getByRole('option', { name: /0\.50%/ }).press('Enter');
      assert.match(await slippage.innerText(), /0\.50%/);
      await slippage.click();
      await page.getByRole('option', { name: /1\.00%/ }).click();
      assert.match(await slippage.innerText(), /1\.00%/);
      await slippage.click();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('listbox', { name: 'Slippage' }).count(), 0);
      await page.getByLabel('Close SWAP').evaluate((button) => button.click());
      await page.waitForTimeout(300);

      await page.getByRole('button', { name: 'Open Send.' }).click();
      const sendOrder = await page.locator('.send-body').evaluate((node) => {
        const button = node.querySelector(':scope > .console-primary');
        const details = node.querySelector(':scope > .advanced-details');
        return button && details ? Boolean(button.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
      });
      assert.equal(sendOrder, true, `${theme} ${viewport.width}: Send details must follow its action`);
      await page.getByLabel('Close SEND').click();
      await page.waitForTimeout(300);
    }
    await page.close();
  }
  console.log(`Stats layout remained stable across ${viewports.length} desktop viewports and both themes.`);
} finally {
  await browser.close();
  await server.close();
}
