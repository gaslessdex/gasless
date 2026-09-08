import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 393, height: 873 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
];

const publicStats = {
  schemaVersion: 'public-stats-v2', network: 'mainnet-beta',
  totals: { successfulActions: 4, sponsoredTransactions: 5, sponsoredLamports: '5000', supportedTokens: 2, byAction: {}, byActionFamily: { cleanActions: 1, swaps: 1, sends: 1, crossChainActions: 1 } },
  networks: {
    solana: { totalGaslessActions: 4, transactionsSponsored: 5, actions: { cleanActions: 1, swaps: 1, sends: 1, crossChainActions: 1 }, networkFeesSponsored: { atomicAmount: '5000', decimals: 9, symbol: 'SOL' }, supportedTokens: 2 },
    robinhood: { totalGaslessActions: 1, transactionsSponsored: 0, actions: { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 1 }, networkFeesSponsored: null, supportedTokens: 0 },
    base: { totalGaslessActions: 0, transactionsSponsored: 0, actions: { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 0 }, networkFeesSponsored: null, supportedTokens: 0 },
    bnb: { totalGaslessActions: 0, transactionsSponsored: 0, actions: { bridgeActions: 0, swaps: 0, sends: 0, crossChainActions: 0 }, networkFeesSponsored: null, supportedTokens: 0 },
  },
};

const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 4180 } });
await server.listen();
const origin = server.resolvedUrls?.local[0];
if (!origin) throw new Error('Vite did not expose a local test URL.');

const browser = await chromium.launch({ headless: true });
try {
  for (const [index, viewport] of viewports.entries()) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce', colorScheme: index % 2 ? 'light' : 'dark' });
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (String(type).startsWith('webgl')) return null;
        return original.call(this, type, ...args);
      };
    });
    await page.route('**/api/browser-verification/status', (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/public/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ networkLabel: 'DEVNET', gaslessStatus: 'operational', sponsorshipAvailable: true, supportedTokenCount: 0 }) }));
    await page.route('**/api/public/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(publicStats) }));
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.locator('.loading-sequence').waitFor({ state: 'detached' });

    const controls = await page.evaluate(() => {
      const box = (selector) => {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height, center: bounds.left + bounds.width / 2 };
      };
      return {
        network: box('.hud-tab--left'),
        menu: box('.mobile-menu-trigger'),
        stats: box('.hud-tab--right'),
        networkShape: getComputedStyle(document.querySelector('.hud-tab--left'), '::before').clipPath,
        menuShape: getComputedStyle(document.querySelector('.mobile-menu-trigger'), '::before').clipPath,
        statsShape: getComputedStyle(document.querySelector('.hud-tab--right'), '::before').clipPath,
        themeDisplay: getComputedStyle(document.querySelector('.top-hud > .theme-toggle')).display,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    assert.ok(controls.network.right < controls.menu.left && controls.menu.right < controls.stats.left, `${viewport.width}: top controls overlap or are out of order`);
    assert.ok(Math.abs(controls.menu.center - viewport.width / 2) <= 1, `${viewport.width}: G control is not centered`);
    assert.ok([controls.network, controls.menu, controls.stats].every((control) => control.height >= 44), `${viewport.width}: top control is below the minimum touch height`);
    assert.notEqual(controls.networkShape, 'none', `${viewport.width}: NETWORK lost its angular shape`);
    assert.notEqual(controls.menuShape, 'none', `${viewport.width}: G lost its rhombus shape`);
    assert.notEqual(controls.statsShape, 'none', `${viewport.width}: STATS lost its angular shape`);
    assert.equal(controls.themeDisplay, 'none', `${viewport.width}: home theme toggle is still visible`);
    assert.equal(controls.scrollWidth, controls.clientWidth, `${viewport.width}: home has horizontal overflow`);
    assert.equal(await page.locator('.mobile-action-rail').count(), 0, `${viewport.width}: redundant center actions are still mounted`);

    await page.locator('.mobile-menu-trigger').click();
    const menu = page.locator('.mobile-menu');
    await menu.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.cockpit-nav').evaluate((node) => getComputedStyle(node).display), 'none', `${viewport.width}: desktop dynamic navigation is visible`);
    const footerOrder = await menu.evaluate((node) => {
      const lastLink = node.querySelector('.mobile-menu__links > :last-child').getBoundingClientRect();
      const footer = node.querySelector('.mobile-menu__footer').getBoundingClientRect();
      return footer.top >= lastLink.bottom;
    });
    assert.equal(footerOrder, true, `${viewport.width}: theme toggle is not at the menu bottom`);
    const nextTheme = index % 2 ? 'dark' : 'light';
    await menu.getByLabel(`Use ${nextTheme} theme`).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), nextTheme, `${viewport.width}: menu theme toggle did not update the theme`);

    await menu.getByRole('button', { name: 'NETWORK' }).click();
    await page.locator('#network-drawer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.mobile-menu').count(), 0, `${viewport.width}: menu remained behind Network`);
    await page.getByLabel('Close network panel').click();

    await page.locator('.hud-tab--right').click();
    await page.locator('#stats-drawer').waitFor({ state: 'visible' });
    const stats = await page.locator('#stats-drawer').evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    });
    assert.ok(Math.abs(stats.left) <= 1 && Math.abs(stats.right - viewport.width) <= 1, `${viewport.width}: Stats does not meet both viewport edges`);
    assert.ok(Math.abs(stats.width - viewport.width) <= 1, `${viewport.width}: Stats width does not equal viewport width`);
    assert.ok(stats.scrollWidth <= stats.clientWidth, `${viewport.width}: Stats has horizontal overflow`);
    assert.equal(await page.locator('#stats-drawer dt').count(), 7, `${viewport.width}: Stats does not show exactly seven public metrics`);
    assert.equal(await page.getByText('CLEAN ACTIONS', { exact: true }).count(), 1, `${viewport.width}: Solana Clean Actions is missing`);
    assert.equal(await page.getByText('BRIDGE ACTIONS', { exact: true }).count(), 0, `${viewport.width}: Solana shows Bridge Actions`);
    const gridColumns = await page.locator('.stats-metrics').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    assert.equal(gridColumns, viewport.width <= 760 ? 1 : 2, `${viewport.width}: Stats grid did not reflow at the responsive breakpoint`);
    for (const network of ['ROBINHOOD', 'BASE', 'BNB']) {
      await page.getByRole('tab', { name: network, exact: true }).click();
      assert.equal(await page.getByText('CLEAN ACTIONS', { exact: true }).count(), 0, `${viewport.width}: ${network} retained Clean Actions`);
      assert.equal(await page.getByText('BRIDGE ACTIONS', { exact: true }).count(), 1, `${viewport.width}: ${network} is missing Bridge Actions`);
      assert.ok(await page.locator('#stats-drawer').evaluate((node) => node.scrollWidth <= node.clientWidth), `${viewport.width}: ${network} introduced Stats horizontal overflow`);
    }
    await page.getByRole('tab', { name: 'SOLANA', exact: true }).click();
    assert.equal(await page.getByText('CLEAN ACTIONS', { exact: true }).count(), 1, `${viewport.width}: returning to Solana did not restore Clean Actions`);
    assert.equal(await page.getByText('BRIDGE ACTIONS', { exact: true }).count(), 0, `${viewport.width}: returning to Solana retained Bridge Actions`);
    await page.getByLabel('Close stats panel').click();

    await page.locator('.wheel-hub').click();
    await page.locator('.mobile-menu').waitFor({ state: 'visible' });
    await page.locator('.mobile-menu').getByRole('button', { name: 'FAQ' }).click();
    await page.locator('.faq-console').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.mobile-menu').count(), 0, `${viewport.width}: menu remained behind FAQ`);
    const faqHeader = await page.evaluate(() => {
      const title = document.querySelector('#faq-title').getBoundingClientRect();
      const close = document.querySelector('[aria-label="Close FAQ"]').getBoundingClientRect();
      return { closeRight: close.right, titleLeft: title.left, closeTop: close.top, titleTop: title.top };
    });
    assert.ok(faqHeader.closeRight > faqHeader.titleLeft && faqHeader.closeTop <= faqHeader.titleTop + 12, `${viewport.width}: FAQ close button is not upper-right`);
    assert.equal(await page.locator('.faq-list details').first().evaluate((node) => getComputedStyle(node.querySelector('summary span'), '::before').content), '"−"', `${viewport.width}: expanded FAQ does not use a minus symbol`);
    await page.getByLabel('Close FAQ').click();
    await page.close();
  }
  console.log(`Mobile layout passed across ${viewports.length} phone/tablet viewports and alternating light/dark themes.`);
} finally {
  await browser.close();
  await server.close();
}
