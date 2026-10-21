import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFlowPrincipal, createFlowDataTools, loadFlowSnapshot } from './flow-data.mjs';

const principal = { role: 'admin', tenantId: 'company-a', userId: 'admin-a' };
function fixture() {
  return {
    tenantId: 'company-a', companyName: '测试公司', revision: 8, capturedAt: '2026-10-19T00:00:00Z', complete: true,
    state: {
      settings: { companyName: '测试公司', currency: 'JPY', platformKey: 'secret-setting' },
      products: [{ id: 'p1', name: '青菜', unit: '袋', saleUnits: [{ unit: '袋', perBase: 1, token: 'secret-unit' }], basePrice: 99999 }],
      stores: [{ id: 's1', name: '木屋', contact: '联系人', phone: '123', accessCode: 'secret-master', account: 'secret-login', password: 'secret-password' }],
      inventory: { p1: null }, prices: { s1: { p1: 500 } }, quoteMeta: { s1: { p1: { taxBasis: 'unspecified', taxRate: null, source: 'secret-url' } } },
      orders: [
        { id: 'o1', storeId: 's1', stage: 'delivered', date: '2026-10-18', items: [{ productId: 'p1', productName: '青菜', qty: 2, price: 10, unit: '袋', taxBasis: 'unspecified' }] },
        { id: 'o2', storeId: 's1', stage: 'delivered', date: '2026-10-18', items: [{ productId: 'p1', qty: 1, price: null, unit: '袋' }] },
        { id: 'o3', storeId: 's1', stage: 'pending', date: '2026-10-18', items: [{ productId: 'p1', qty: 10, price: 100, unit: '袋' }] },
        { id: 'DEMO-o4', storeId: 's1', stage: 'delivered', date: '2026-10-18', items: [{ productId: 'p1', qty: 1, price: 1000, unit: '袋' }] },
      ], documents: [{ id: 'd1', title: '历史单据', storeId: 's1', totals: { total: 123, secret: 'secret-total' }, lines: [] }],
    },
    materials: { materialCosts: [{ name: '青菜成本', costPrice: 9.5, taxBasis: 'unspecified', provenance: { sourceCostValue: 9.4, token: 'secret-provenance' } }], token: 'secret-material' },
  };
}
const withFixture = snapshot => createFlowDataTools({ principal, loadSnapshot: async () => snapshot });

test('Flow read boundary rejects platform and store principals before reading any data', () => {
  for (const value of [null, { ...principal, role: 'platform' }, { ...principal, role: 'store', storeId: 's1' }, { ...principal, storeId: 's1' }, { ...principal, tenantId: '' }]) {
    assert.throws(() => assertFlowPrincipal(value), { status: 403 });
  }
  assert.equal(assertFlowPrincipal(principal), 'company-a');
});

test('Flow observations retain business fields but do not include owner codes, login names, source URLs or nested secrets', async () => {
  const tools = withFixture(fixture());
  const results = await tools.execute('flow_search', { limit: 30 });
  const details = await Promise.all(results.results.map(row => tools.execute('flow_get_record', { kind: row.kind, id: row.id })));
  const serialized = JSON.stringify([results, details]);
  assert.doesNotMatch(serialized, /secret-|accessCode|password|platformKey|99999/);
  assert.ok(serialized.includes('联系人'));
  assert.ok(serialized.includes('9.4'));
  assert.equal(details.find(row => row.kind === 'product').data.inventory.available, null);
  assert.ok(results.results.every(row => row.source.href.startsWith('/?page=')));
});

test('Flow summary uses saved historic prices, delivered orders and explicit unknown amounts', async () => {
  const tools = withFixture(fixture());
  const summary = await tools.execute('flow_business_summary', { from: '2026-10-18', to: '2026-10-18' });
  assert.equal(summary.delivered.orderCount, 2);
  assert.equal(summary.delivered.knownAmount, 20);
  assert.equal(summary.delivered.amount, null);
  assert.equal(summary.delivered.missingPriceLines, 1);
  assert.equal(summary.stages.pending, 1);
  assert.equal(summary.excludedDemoOrders, 1);
  assert.equal(summary.allOrderHistoryCount, 4);
  const demo = await tools.execute('flow_business_summary', { includeDemo: true });
  assert.equal(demo.delivered.knownAmount, 1020);
  assert.equal(demo.delivered.orderCount, 3);
});

test('Flow catalogue summary counts the complete catalogue with exact saved categories and explicit deleted scope', async () => {
  const snapshot = fixture();
  snapshot.state.products = Array.from({ length: 275 }, (_, index) => ({ id: `p-${index}`, name: `商品 ${index}`, unit: '袋', category: index < 200 ? '蔬菜' : '肉类' }));
  snapshot.state.products.push(
    { id: 'p-no-category', name: '无类目', unit: '袋' },
    { id: 'p-empty-category', name: '空类目', unit: '袋', category: '' },
    { id: 'p-exact-category', name: '独立类目', unit: '袋', category: '蔬菜 ' },
    { id: 'p-deleted', name: '已删除商品', unit: '袋', category: '肉类', deletedAt: '2026-10-18T00:00:00Z' },
  );
  const tools = withFixture(snapshot);
  const summary = await tools.execute('flow_catalogue_summary');
  assert.equal(summary.complete, true);
  assert.equal(summary.scope, 'current_management_tenant');
  assert.equal(summary.revision, snapshot.revision);
  assert.equal(summary.capturedAt, snapshot.capturedAt);
  assert.equal(summary.total, 278);
  assert.equal(summary.activeProductCount, 278);
  assert.equal(summary.deletedProductCount, 1);
  assert.equal(summary.categoryCount, 4);
  assert.equal(summary.includeDeleted, false);
  assert.deepEqual(Object.fromEntries(summary.categories.map(row => [row.name, row.count])), { '蔬菜': 200, '肉类': 75, '未分类': 2, '蔬菜 ': 1 });
  assert.equal(summary.categories.reduce((sum, row) => sum + row.count, 0), summary.total);
  assert.equal(summary.source.href, '/?page=catalogue');
  const all = await tools.execute('flow_catalogue_summary', { includeDeleted: true });
  assert.equal(all.total, 279);
  assert.equal(all.activeProductCount, 278);
  assert.equal(all.categories.find(row => row.name === '肉类').count, 76);
  await assert.rejects(tools.execute('flow_catalogue_summary', { includeDeleted: 'true' }), { status: 400 });
  assert.doesNotMatch(JSON.stringify(summary), /secret-|accessCode|password|platformKey/);
});

test('Flow catalogue summary handles an empty catalogue and enforces the shared tenant boundary', async () => {
  const snapshot = fixture();
  snapshot.state.products = [];
  const summary = await withFixture(snapshot).execute('flow_catalogue_summary', {});
  assert.equal(summary.total, 0);
  assert.equal(summary.categoryCount, 0);
  assert.deepEqual(summary.categories, []);
  await assert.rejects(withFixture({ ...fixture(), tenantId: 'company-b' }).execute('flow_catalogue_summary'), { code: 'FLOW_SCOPE_MISMATCH', status: 403 });
});

test('Flow paginates record details and refuses unknown records or write tools', async () => {
  const snapshot = fixture();
  snapshot.state.orders[0].items = Array.from({ length: 32 }, (_, i) => ({ productId: `p-${i}`, qty: i, price: 2 }));
  const tools = withFixture(snapshot);
  const first = await tools.execute('flow_get_record', { kind: 'order', id: 'o1', limit: 30 });
  assert.equal(first.data.items.length, 30);
  assert.equal(first.lines.nextOffset, 30);
  const last = await tools.execute('flow_get_record', { kind: 'order', id: 'o1', offset: 30, limit: 30 });
  assert.equal(last.data.items.length, 2);
  assert.equal(last.lines.nextOffset, null);
  await assert.rejects(tools.execute('flow_get_record', { kind: 'order', id: 'other-company-order' }), { status: 404 });
  assert.throws(() => tools.execute('delete_order', { id: 'o1' }), { status: 404 });
  assert.equal(snapshot.state.orders[0].items.length, 32);
});

function fakeDb({ count = 275, changing = false } = {}) {
  const calls = [], snapshot = fixture();
  let revisionReads = 0;
  const data = { products: snapshot.state.products, documents: snapshot.state.documents,
    orders: Array.from({ length: count }, (_, i) => ({ id: `historical-${i}`, storeId: 's1', stage: 'delivered', date: '2026-10-18', items: [{ qty: 1, price: 1 }] })) };
  return { calls, prepare(sql) { return { bind(...args) {
    calls.push({ sql, args });
    assert.equal(args[0], 'company-a', 'every read must bind the authenticated tenant');
    return { async first() {
      if (sql.includes('core_json')) return { name: '测试公司', core_json: JSON.stringify(snapshot.state), revision: 8 };
      if (sql.includes('private_materials')) return { data_json: JSON.stringify(snapshot.materials) };
      if (sql.includes('revision')) return { revision: changing ? 9 + revisionReads++ : 8 };
      throw new Error('Unexpected SQL');
    }, async all() {
      const table = /FROM (products|orders|documents) /.exec(sql)?.[1];
      if (!table) throw new Error('Unexpected SQL');
      return { results: data[table].map((row, i) => ({ cursor: i + 1, data_json: JSON.stringify(row) })).filter(row => row.cursor > args[1]).slice(0, args[2]) };
    } };
  } }; } };
}

test('Flow indexes full delivered order history beyond 100 rows with tenant-bound SQL', async () => {
  const db = fakeDb();
  const snapshot = await loadFlowSnapshot(db, principal);
  assert.equal(snapshot.state.orders.length, 275);
  assert.equal(snapshot.complete, true);
  assert.equal(db.calls.filter(call => call.sql.includes('FROM orders')).length, 2);
  assert.ok(db.calls.every(call => !/staff_accounts|account_keys|sessions/.test(call.sql)));
  const summary = await withFixture(snapshot).execute('flow_business_summary');
  assert.equal(summary.delivered.knownAmount, 275);
  assert.equal(summary.delivered.orderCount, 275);
});

test('Flow refuses mixed revisions or an injected cross-tenant snapshot', async () => {
  await assert.rejects(loadFlowSnapshot(fakeDb({ changing: true }), principal), { code: 'FLOW_DATA_CHANGED' });
  await assert.rejects(withFixture({ ...fixture(), tenantId: 'company-b' }).execute('flow_search'), { status: 403 });
});


test('saved null optional metadata does not prevent indexing historical business records',async()=>{
 const snapshot=fixture();snapshot.state.settings=null;snapshot.state.documents[0].totals=null;snapshot.materials.materialCosts[0].provenance=null;
 const result=await withFixture(snapshot).execute('flow_search',{kind:'all',limit:30});
 assert.ok(result.total>0);assert.equal(result.complete,true);
 const doc=await withFixture(snapshot).execute('flow_get_record',{kind:'document',id:'d1'});assert.deepEqual(doc.data.totals,{});
 const cost=await withFixture(snapshot).execute('flow_get_record',{kind:'cost',id:'materialCosts:0'});assert.deepEqual(cost.data.provenance,{});
});
