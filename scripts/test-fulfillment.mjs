import { chromium } from '/Users/xinjin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, executablePath: '/Users/xinjin/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(8000);
const dir = 'tmp/fulfillment-review-2026-10-12';
await fs.mkdir(dir, { recursive: true });

try {
  await page.goto('http://127.0.0.1:4173/?page=orders');
  await page.locator('.page-content').waitFor();
  const fixture = await page.evaluate(async () => {
    const { KitchenModel, DEMO_DATE } = await import('/data.js');
    const model = new KitchenModel();
    const store = model.addStore({ name: '履约验收门店', city: '大阪', contact: '验收人', phone: '090-1234-5678', address: '大阪市浪速区難波中1丁目2番3号' });
    const products = Array.from({ length: 8 }, (_, i) => model.addProduct({ name: `履约验收商品 ${i + 1}`, category: '冷冻品', unit: i === 7 ? 'KG' : '袋', basePrice: 100, stock: null }));
    const order = model.submitOrder(store.id, Object.fromEntries(products.map((product, i) => [product.id, i === 7 ? 0.125 : 3])), DEMO_DATE);
    return { id: order.id, productIds: products.map(product => product.id) };
  });
  await page.reload();
  const card = page.locator(`[data-fulfillment-order="${fixture.id}"]`);
  await card.waitFor();
  assert.equal(await page.locator('.nav-item[data-page="orders"]').count(), 1);
  assert.match(await page.locator('.nav-item[data-page="orders"]').innerText(), /订单履约/);
  assert.equal(await page.getByRole('button', { name: '配送看板', exact: true }).count(), 0);
  await page.screenshot({ path: `${dir}/fulfillment-desktop.png`, fullPage: true });
  await card.getByRole('button', { name: '开始配货', exact: true }).click();
  const drawer = page.locator('.drawer');
  const body = drawer.locator('.drawer-body');
  const first = drawer.locator('.detail-item').first();
  const firstInput = first.locator('[data-pack-input]');
  const firstCheck = first.locator('.pack-check');
  assert.equal(await firstCheck.isDisabled(), true);
  await firstInput.fill('2');
  assert.equal(await firstCheck.isDisabled(), true);
  assert.match(await first.locator('.pack-row-feedback').innerText(), /还差 1 袋/);
  await firstInput.fill('');
  assert.equal(await firstCheck.isDisabled(), true);
  await firstInput.fill('0.5');
  assert.equal(await firstCheck.isDisabled(), true);
  await firstInput.fill('4');
  assert.equal(await firstCheck.isDisabled(), true);
  await firstInput.fill('3');
  assert.equal(await firstCheck.isEnabled(), true);
  await firstCheck.click();
  await page.waitForFunction(() => document.querySelector('.detail-item .pack-check').getAttribute('aria-pressed') === 'true');
  assert.equal(await firstCheck.isDisabled(), true);
  assert.match(await drawer.locator('.packing-summary').innerText(), /1 \/ 8/);
  assert.equal(await drawer.getByRole('button', { name: '确认配货完成', exact: true }).isDisabled(), true);

  // A revised quantity invalidates the old confirmation and requires a new check.
  await firstInput.fill('2');
  await firstInput.press('Tab');
  assert.equal(await firstCheck.getAttribute('aria-pressed'), 'false');
  assert.equal(await firstCheck.isDisabled(), true);
  await firstInput.fill('3');
  await firstInput.press('Tab');
  assert.equal(await firstCheck.getAttribute('aria-pressed'), 'false');
  assert.equal(await firstCheck.isEnabled(), true);
  await firstCheck.click();
  await page.waitForFunction(() => document.querySelector('.detail-item .pack-check').getAttribute('aria-pressed') === 'true');

  // Work in the middle of a long drawer: confirming must preserve its DOM and scroll.
  const middle = drawer.locator('.detail-item').nth(4);
  const middleInput = middle.locator('[data-pack-input]');
  const middleCheck = middle.locator('.pack-check');
  await middleInput.fill('3');
  await middleCheck.scrollIntoViewIfNeeded();
  const before = await body.evaluate(node => { node.dataset.scrollAudit = 'unchanged'; return node.scrollTop; });
  assert.ok(before > 200, `Expected a scrolled drawer, got ${before}`);
  await middleCheck.click();
  await page.waitForFunction(() => document.querySelectorAll('.detail-item .pack-check')[4].getAttribute('aria-pressed') === 'true');
  const after = await body.evaluate(node => ({ scrollTop: node.scrollTop, marker: node.dataset.scrollAudit }));
  assert.equal(after.marker, 'unchanged', 'Confirming a line must not recreate the drawer');
  assert.ok(Math.abs(after.scrollTop - before) <= 1, `Drawer jumped from ${before} to ${after.scrollTop}`);
  await page.screenshot({ path: `${dir}/packing-desktop.png` });

  // Quantity entry alone never confirms a line; every line must be checked.
  for (let index = 0; index < fixture.productIds.length; index += 1) {
    const row = drawer.locator('.detail-item').nth(index);
    const input = row.locator('[data-pack-input]');
    const check = row.locator('.pack-check');
    if (await check.getAttribute('aria-pressed') === 'true') continue;
    await input.fill(index === 7 ? '0.125' : '3');
    await input.press('Tab');
    assert.equal(await check.getAttribute('aria-pressed'), 'false');
    assert.equal(await drawer.getByRole('button', { name: '确认配货完成', exact: true }).isDisabled(), true);
    await check.click();
    await page.waitForFunction(index => document.querySelectorAll('.detail-item .pack-check')[index].getAttribute('aria-pressed') === 'true', index);
  }
  assert.equal(await drawer.getByRole('button', { name: '确认配货完成', exact: true }).isEnabled(), true);
  await drawer.getByRole('button', { name: '确认配货完成', exact: true }).click();
  await drawer.getByRole('button', { name: '确认出发', exact: true }).waitFor();
  assert.equal(await drawer.locator('[data-pack-input]:not(:disabled)').count(), 0);
  await drawer.getByRole('button', { name: '关闭订单明细', exact: true }).click();
  assert.match(await card.locator('.status-badge').innerText(), /待配送/);
  await card.getByRole('button', { name: '确认出发', exact: true }).click();
  await card.getByRole('button', { name: '确认送达', exact: true }).waitFor();
  assert.match(await card.locator('.status-badge').innerText(), /配送中/);
  await card.getByRole('button', { name: '确认送达', exact: true }).click();
  await page.getByLabel('签收人', { exact: true }).fill('测试签收人');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认已送达', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.match(await card.locator('.status-badge').innerText(), /已送达/);
  await page.reload();
  await card.waitFor();
  assert.match(await card.locator('.status-badge').innerText(), /已送达/);
  await card.getByRole('button', { name: '订单明细', exact: true }).click();
  assert.match(await drawer.innerText(), /测试签收人/);
  assert.equal(await drawer.locator('.pack-check:not(:disabled)').count(), 0);
  await drawer.getByRole('button', { name: '关闭订单明细', exact: true }).click();

  // Existing bookmarks resolve to the same workflow and small screens do not overflow.
  await page.goto('http://127.0.0.1:4173/?page=delivery');
  await page.getByRole('heading', { name: '订单履约', exact: true }).waitFor();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${dir}/fulfillment-${width}.png`, fullPage: true });
  }
  await card.getByRole('button', { name: '订单明细', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${dir}/packing-mobile.png` });
  assert.deepEqual(errors, []);
  console.log('Fulfillment: short/invalid quantities blocked, explicit confirmation, edits reset confirmation, drawer scroll retained, dispatch/signature/delivery persistence, old bookmarks and mobile layout PASS.');
} catch (error) {
  await page.screenshot({ path: `${dir}/failure.png`, fullPage: true });
  console.log('Browser errors:', errors);
  console.log('Toasts:', await page.locator('.toast').allTextContents());
  throw error;
} finally {
  await browser.close();
}
