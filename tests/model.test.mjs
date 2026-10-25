import assert from 'node:assert/strict';
import { DEMO_DATE, STORAGE_KEY, KitchenModel, products, stores, money, normalizeStoreAccessCode } from '../src/shared/data.js';
import { materialDocuments, exampleOrderLines } from '../src/shared/business-data.js';

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const memory = new Map();
const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

let passed = 0;
const fresh = () => { memory.clear(); return new KitchenModel(); };
const setup = () => {
  const model = fresh();
  const storeId = model.state.stores[0].id;
  const count = model.addProduct({ name: '测试计数商品', category: '冷冻品', unit: '袋', basePrice: 592.25, stock: 10 });
  const weight = model.addProduct({ name: '测试重量商品', category: '冷冻品', unit: 'KG', basePrice: 1388.9, stock: null });
  const unquoted = model.addProduct({ name: '测试未报价商品', category: '其他食材', unit: '盒' });
  return { model, storeId, count, weight, unquoted };
};
const test = (name, run) => { run(); passed += 1; console.log(`✓ ${name}`); };

try {
  test('the preview loads actual products, read-only documents and exactly one marked example order', () => {
    const model = fresh();
    assert.equal(model.state.version, 2);
    assert.equal(model.getProducts().length, products.length);
    assert.equal(model.state.stores.length, stores.length);
    assert.deepEqual(model.state.documents, materialDocuments);
    assert.equal(model.state.orders.length, 1);
    const order = model.state.orders[0];
    assert.equal(order.isDemo, true);
    assert.equal(order.storeId, 's-kobe');
    assert.equal(order.stage, 'pending');
    assert.deepEqual(order.items.map(({ productId, qty }) => ({ productId, qty })),
      exampleOrderLines.map(({ productId, qty }) => ({ productId, qty })));
    assert.ok(order.items.every(item => item.packedQty === 0));
    assert.equal(order.sourceDate, '2026-10-07');
    for (const product of products) assert.equal(model.getStock(product.id), product.stock ?? null);
  });

  test('unknown inventory stays unknown, zero inventory blocks ordering and KG stock reserves precisely', () => {
    const { model, storeId, count, weight } = setup();
    assert.equal(model.getStock(weight.id), null);
    model.submitOrder(storeId, { [weight.id]: 0.125 }, DEMO_DATE);
    assert.equal(model.getStock(weight.id), null);
    model.setStock(weight.id, 1.375);
    model.submitOrder(storeId, { [weight.id]: 0.125 }, DEMO_DATE);
    assert.equal(model.getStock(weight.id), 1.25);
    model.setStock(count.id, 0);
    assert.equal(model.getStock(count.id), 0);
    assert.throws(() => model.submitOrder(storeId, { [count.id]: 1 }, DEMO_DATE), /库存不足/);
    model.setStock(count.id, null);
    assert.equal(model.getStock(count.id), null);
    model.submitOrder(storeId, { [count.id]: 1 }, DEMO_DATE);
    assert.equal(model.getStock(count.id), null);
  });

  test('exclusive store allocations are independent and shared stores only see unallocated stock', () => {
    const { model, storeId, count } = setup();
    const second = model.state.stores[1].id;
    const shared = model.state.stores[2].id;
    assert.equal(model.getAllocation(shared, count.id), null);
    model.setStoreAllocation(storeId, count.id, 3);
    model.setStoreAllocation(second, count.id, 4);
    assert.equal(model.getAllocatedQty(count.id), 7);
    assert.equal(model.getStoreStock(storeId, count.id), 3);
    assert.equal(model.getOrderableStock(storeId, count.id), 3);
    assert.equal(model.getOrderableStock(second, count.id), 4);
    assert.equal(model.getOrderableStock(shared, count.id), 3);
    model.setStoreAllocation(second, count.id, 5);
    assert.equal(model.getAllocation(storeId, count.id), 3);
    assert.equal(model.getOrderableStock(shared, count.id), 2);
    const before = structuredClone(model.state);
    const stored = memory.get(STORAGE_KEY);
    assert.throws(() => model.setStoreAllocation(storeId, count.id, 6), /配额合计/);
    assert.deepEqual(model.state, before);
    assert.equal(memory.get(STORAGE_KEY), stored);
    model.setStoreAllocation(storeId, count.id, ' ');
    assert.equal(model.getAllocation(storeId, count.id), null);
    assert.equal(model.getAllocatedQty(count.id), 5);
    assert.equal(model.getOrderableStock(storeId, count.id), 5);
    assert.equal(model.getOrderableStock(shared, count.id), 5);
    model.setStoreAllocation(storeId, count.id, 0);
    assert.equal(model.getOrderableStock(storeId, count.id), 0);
    assert.equal(model.getOrderableStock(shared, count.id), 5);
  });

  test('orders consume company stock and their own allocation once while protecting other stores', () => {
    const { model, storeId, count } = setup();
    const second = model.state.stores[1].id;
    const shared = model.state.stores[2].id;
    model.setStoreAllocation(storeId, count.id, 4);
    model.setStoreAllocation(second, count.id, 3);
    const order = model.submitOrder(storeId, { [count.id]: 3 }, DEMO_DATE);
    assert.equal(model.getStock(count.id), 7);
    assert.equal(model.getAllocation(storeId, count.id), 1);
    assert.equal(model.getAllocation(second, count.id), 3);
    assert.equal(model.getAllocatedQty(count.id), 4);
    assert.equal(model.getReservedQty(count.id), 3);
    assert.equal(model.getWarehouseStock(count.id), 10);
    assert.equal(model.getOrderableStock(shared, count.id), 3);
    const before = structuredClone(model.state);
    assert.throws(() => model.submitOrder(storeId, { [count.id]: 2 }, DEMO_DATE), /门店可订库存/);
    assert.throws(() => model.submitOrder(shared, { [count.id]: 4 }, DEMO_DATE), /门店可订库存/);
    assert.deepEqual(model.state, before);
    model.submitOrder(shared, { [count.id]: 2 }, DEMO_DATE);
    assert.equal(model.getStock(count.id), 5);
    assert.equal(model.getAllocation(second, count.id), 3);
    assert.equal(model.getOrderableStock(shared, count.id), 1);
    assert.equal(model.getReservedQty(count.id), 5);
    assert.equal(model.getWarehouseStock(count.id), 10);
    model.packLine(order.id, count.id, 3);
    model.confirmPackLine(order.id, count.id);
    model.setStage(order.id, 'ready');
    model.setStage(order.id, 'delivering');
    assert.equal(model.getReservedQty(count.id), 5);
    assert.equal(model.getWarehouseStock(count.id), 10);
    model.setStage(order.id, 'delivered');
    assert.equal(model.getReservedQty(count.id), 2);
    assert.equal(model.getWarehouseStock(count.id), 7);
    assert.equal(model.getStock(count.id), 5);
    assert.equal(model.getAllocation(storeId, count.id), 1);
    assert.equal(model.getAllocation(second, count.id), 3);
  });

  test('unknown company stock permits KG allocations and later warehouse counts validate reservations plus allocations', () => {
    const { model, storeId, weight } = setup();
    const second = model.state.stores[1].id;
    const shared = model.state.stores[2].id;
    model.setStoreAllocation(storeId, weight.id, 1.375);
    model.setStoreAllocation(second, weight.id, 0.25);
    assert.equal(model.getOrderableStock(storeId, weight.id), 1.375);
    assert.equal(model.getOrderableStock(shared, weight.id), null);
    model.submitOrder(storeId, { [weight.id]: 0.125 }, DEMO_DATE);
    assert.equal(model.getAllocation(storeId, weight.id), 1.25);
    assert.equal(model.getAllocatedQty(weight.id), 1.5);
    assert.equal(model.getReservedQty(weight.id), 0.125);
    assert.equal(model.getStock(weight.id), null);
    assert.equal(model.getWarehouseStock(weight.id), null);
    const before = structuredClone(model.state);
    assert.throws(() => model.setWarehouseStock(weight.id, 1.624), /订单占用/);
    assert.throws(() => model.setStock(weight.id, 1.499), /已分配库存/);
    assert.deepEqual(model.state, before);
    model.setWarehouseStock(weight.id, 1.625);
    assert.equal(model.getStock(weight.id), 1.5);
    assert.equal(model.getWarehouseStock(weight.id), 1.625);
    assert.equal(model.getOrderableStock(shared, weight.id), 0);
    assert.equal(model.getOrderableStock(second, weight.id), 0.25);
    model.setWarehouseStock(weight.id, 2.125);
    assert.equal(model.getStock(weight.id), 2);
    assert.equal(model.getOrderableStock(shared, weight.id), 0.5);
    model.setWarehouseStock(weight.id, null);
    assert.equal(model.getStock(weight.id), null);
    assert.equal(model.getWarehouseStock(weight.id), null);
    assert.equal(model.getAllocation(storeId, weight.id), 1.25);
  });

  test('allocation or quantity failure on a later cart line preserves all inventory and quotas', () => {
    const { model, storeId, count, weight } = setup();
    model.setStoreAllocation(storeId, count.id, 2);
    model.setStock(weight.id, 1);
    model.setStoreAllocation(storeId, weight.id, 0.5);
    model.state.cart = { [count.id]: 1, [weight.id]: 0.6 };
    model.save();
    const before = structuredClone(model.state);
    const stored = memory.get(STORAGE_KEY);
    assert.throws(() => model.submitOrder(storeId, model.state.cart, DEMO_DATE), /门店可订库存/);
    assert.throws(() => model.submitOrder(storeId, { [count.id]: 1, [weight.id]: 0.0001 }, DEMO_DATE), /三位/);
    assert.deepEqual(model.state, before);
    assert.equal(memory.get(STORAGE_KEY), stored);
    model.submitOrder(storeId, { [count.id]: 1, [weight.id]: 0.125 }, DEMO_DATE);
    assert.equal(model.getStock(count.id), 9);
    assert.equal(model.getAllocation(storeId, count.id), 1);
    assert.equal(model.getStock(weight.id), 0.875);
    assert.equal(model.getAllocation(storeId, weight.id), 0.375);
  });

  test('recorded example orders are reserved when warehouse inventory is counted later', () => {
    const model = fresh();
    const example = model.state.orders[0];
    const productId = example.items[0].productId;
    const reserved = example.items.filter(item => item.productId === productId).reduce((sum, item) => sum + item.qty, 0);
    assert.equal(model.getReservedQty(productId), reserved);
    assert.equal(model.getWarehouseStock(productId), null);
    const storeId = model.state.stores[1].id;
    model.setStoreAllocation(storeId, productId, 2);
    model.setWarehouseStock(productId, reserved + 2);
    assert.equal(model.getStock(productId), 2);
    assert.equal(model.getWarehouseStock(productId), reserved + 2);
    assert.throws(() => model.setWarehouseStock(productId, reserved + 1), /订单占用/);
  });

  test('allocation precision follows product units and invalid warehouse or allocation changes are atomic', () => {
    const { model, storeId, count, weight } = setup();
    const before = structuredClone(model.state);
    for (const qty of [-1, 0.5, NaN, Infinity]) assert.throws(() => model.setStoreAllocation(storeId, count.id, qty), /整数/);
    assert.throws(() => model.setStoreAllocation(storeId, weight.id, 0.0001), /三位/);
    assert.throws(() => model.setWarehouseStock(count.id, 1.5), /整数/);
    assert.throws(() => model.setWarehouseStock(weight.id, 0.0001), /三位/);
    assert.throws(() => model.setStoreAllocation('missing', count.id, 1), /门店不存在/);
    assert.throws(() => model.setStoreAllocation(storeId, 'missing', 1), /商品不存在/);
    assert.deepEqual(model.state, before);
  });

  test('existing version two data migrates allocations without resetting orders, stock or quotes', () => {
    const { model, storeId, count } = setup();
    model.setPrice(storeId, count.id, 123.45);
    const order = model.submitOrder(storeId, { [count.id]: 2 }, DEMO_DATE);
    const oldState = structuredClone(model.state);
    delete oldState.storeAllocations;
    memory.set(STORAGE_KEY, JSON.stringify(oldState));
    const restored = new KitchenModel();
    assert.deepEqual(restored.state.storeAllocations, {});
    assert.equal(restored.state.orders[0].id, order.id);
    assert.equal(restored.getStock(count.id), 8);
    assert.equal(restored.getWarehouseStock(count.id), 10);
    assert.equal(restored.getPrice(storeId, count.id), 123.45);
    restored.setStoreAllocation(storeId, count.id, 3);
    assert.equal(new KitchenModel().getAllocation(storeId, count.id), 3);
    restored.reset();
    assert.deepEqual(restored.state.storeAllocations, {});
    assert.equal(restored.state.orders.length, 1);
  });

  test('stock and unquoted-item rejection preserve every line, draft and persisted state atomically', () => {
    const { model, storeId, count, weight, unquoted } = setup();
    model.setStock(weight.id, 0);
    model.state.cart = { [count.id]: 2, [weight.id]: 1 };
    model.save();
    const before = structuredClone(model.state);
    const stored = memory.get(STORAGE_KEY);
    assert.throws(() => model.submitOrder(storeId, model.state.cart, DEMO_DATE), /库存不足/);
    assert.deepEqual(model.state, before);
    assert.equal(memory.get(STORAGE_KEY), stored);
    assert.throws(() => model.submitOrder(storeId, { [count.id]: 2, [unquoted.id]: 1 }, DEMO_DATE), /尚未报价/);
    assert.deepEqual(model.state, before);
    assert.equal(memory.get(STORAGE_KEY), stored);
  });

  test('price and tax snapshots retain original decimals after store-specific quote overrides', () => {
    const { model, storeId, weight } = setup();
    const otherStore = model.addStore({ name: '测试独立门店', account: 'test_price_store' });
    model.setPrice(storeId, weight.id, 592.25, 'exclusive', 0.08);
    const order = model.submitOrder(storeId, { [weight.id]: 0.125 }, DEMO_DATE, ' 请单独装箱 ');
    assert.equal(order.note, '请单独装箱');
    assert.equal(order.isDemo, true);
    assert.equal(order.origin, 'manual_preview');
    assert.equal(order.items[0].price, 592.25);
    assert.equal(order.items[0].taxBasis, 'exclusive');
    assert.equal(order.items[0].taxRate, 0.08);
    assert.equal(model.orderTotal(order), 74.03);
    assert.equal(model.orderTaxKnown(order), true);
    assert.equal(model.orderTax(order), 5.92);
    model.setPrice(storeId, weight.id, 1388.9, 'inclusive', 0.1);
    assert.equal(order.items[0].price, 592.25);
    assert.equal(order.items[0].taxBasis, 'exclusive');
    assert.equal(model.orderTotal(order), 74.03);
    assert.equal(model.getPrice(otherStore.id, weight.id), 1388.9);
    assert.equal(model.state.priceHistory[0].previous.price, 592.25);
    assert.equal(model.state.priceHistory[0].previous.taxBasis, 'exclusive');
    const next = model.submitOrder(storeId, { [weight.id]: 1 }, DEMO_DATE);
    assert.equal(next.items[0].taxBasis, 'inclusive');
    assert.equal(next.items[0].price, 1388.9);
    assert.notEqual(next.id, order.id);
    assert.match(money(592.25), /592\.25/);
    assert.match(money(1388.9), /1,388\.9/);
    assert.equal(money(null), '待报价');
  });

  test('unquoted lines and unspecified tax remain visible rather than appearing as confirmed zero tax', () => {
    const { model, storeId, count, unquoted } = setup();
    assert.equal(model.getPrice(storeId, unquoted.id), null);
    assert.equal(model.getQuote(storeId, unquoted.id).taxBasis, 'unspecified');
    const order = model.submitOrder(storeId, { [count.id]: 2 }, DEMO_DATE);
    assert.equal(model.orderTaxKnown(order), false);
    assert.equal(model.orderTax(order), null);
    assert.equal(model.orderSubtotal(order), 1184.5);
    const draft = { items: [...order.items, { productId: unquoted.id, qty: 1, price: null, taxBasis: 'unspecified', taxRate: null }] };
    assert.equal(model.orderUnquotedCount(draft), 1);
    assert.equal(model.orderTotal(draft), 1184.5);
    assert.equal(model.orderTax(draft), null);
  });

  test('order totals sum rounded line amounts so fractional KG lines match the displayed invoice', () => {
    const { model, storeId, weight } = setup();
    model.setPrice(storeId, weight.id, 1.01);
    const second = model.addProduct({ name: '测试第二重量商品', category: '冷冻品', unit: 'KG', basePrice: 1.01 });
    const order = model.submitOrder(storeId, { [weight.id]: 1.5, [second.id]: 1.5 }, DEMO_DATE);
    assert.equal(order.items.length, 2);
    assert.equal(model.orderSubtotal(order), 3.04);
    assert.equal(model.orderTotal(order), 3.04);
    assert.equal(Math.round(order.items.reduce((sum, item) => sum + item.price * item.qty, 0) * 100) / 100, 3.03);
  });

  test('KG allows up to three decimals while package counts require whole units', () => {
    const { model, storeId, count, weight } = setup();
    for (const qty of [0.5, 1e-10, -1, NaN, Infinity]) assert.throws(() => model.submitOrder(storeId, { [count.id]: qty }, DEMO_DATE), /整数/);
    for (const qty of [0.0001, 1e-10, -0.001, NaN, Infinity]) assert.throws(() => model.submitOrder(storeId, { [weight.id]: qty }, DEMO_DATE), /三位/);
    const order = model.submitOrder(storeId, { [weight.id]: 0.001 }, DEMO_DATE);
    assert.equal(order.items[0].qty, 0.001);
    assert.throws(() => model.setStock(weight.id, 0.0001), /三位/);
    assert.throws(() => model.setStock(count.id, 1.5), /整数/);
    assert.throws(() => model.submitOrder(storeId, {}, DEMO_DATE), /选择/);
    assert.throws(() => model.submitOrder(storeId, { unknown: 1 }, DEMO_DATE), /不存在/);
    assert.throws(() => model.submitOrder('missing', { [count.id]: 1 }, DEMO_DATE), /门店/);
  });

  test('calendar dates must be valid and cannot predate the demo day', () => {
    const { model, storeId, count } = setup();
    assert.throws(() => model.submitOrder(storeId, { [count.id]: 1 }, '2026-02-30'), /有效/);
    assert.throws(() => model.submitOrder(storeId, { [count.id]: 1 }, '2026-10-07'), /早于/);
    const order = model.submitOrder(storeId, { [count.id]: 1 }, '2026-10-09');
    assert.equal(order.deliveryDate, '2026-10-09');
  });

  test('fulfillment proceeds sequentially only after quantities are fully verified', () => {
    const { model, storeId, count, weight } = setup();
    const order = model.submitOrder(storeId, { [count.id]: 2, [weight.id]: 0.125 }, DEMO_DATE);
    assert.throws(() => model.setStage(order.id, 'ready'), /顺序/);
    model.setStage(order.id, 'packing');
    assert.throws(() => model.setStage(order.id, 'delivering'), /顺序/);
    assert.throws(() => model.setStage(order.id, 'ready'), /未配齐/);
    for (const qty of [-1, 0.5, NaN]) assert.throws(() => model.packLine(order.id, count.id, qty), /整数/);
    assert.throws(() => model.packLine(order.id, count.id, 3), /超过/);
    assert.throws(() => model.packLine(order.id, weight.id, 0.1255), /三位/);
    model.packLine(order.id, count.id, 2);
    model.packLine(order.id, weight.id, 0.124);
    assert.throws(() => model.setStage(order.id, 'ready'), /未配齐/);
    model.packLine(order.id, weight.id, 0.125);
    model.confirmPackLine(order.id, count.id);
    model.confirmPackLine(order.id, weight.id);
    assert.equal(order.stage, 'packing');
    model.setStage(order.id, 'ready');
    assert.throws(() => model.packLine(order.id, count.id, 1), /不能修改/);
    model.setStage(order.id, 'delivering');
    model.setStage(order.id, 'delivered');
    assert.ok(order.departedAt && order.deliveredAt);
    assert.throws(() => model.setStage(order.id, 'packing'), /不能修改/);
    assert.throws(() => model.packLine(order.id, count.id, 1), /不能修改/);
    assert.throws(() => model.remindOrder(order.id), /已送达/);
  });

  test('catalog additions can be unquoted with unknown stock and receive independent quote lists', () => {
    const { model, storeId, unquoted } = setup();
    assert.equal(unquoted.basePrice, null);
    assert.equal(unquoted.stock, null);
    assert.equal(model.getPrice(storeId, unquoted.id), null);
    const store = model.addStore({ name: '新增门店' });
    assert.equal(model.getPrice(store.id, unquoted.id), null);
    model.setPrice(store.id, unquoted.id, 1388.9);
    assert.equal(model.getPrice(storeId, unquoted.id), null);
    const saved = new KitchenModel();
    assert.equal(saved.getProduct(unquoted.id).name, unquoted.name);
    assert.equal(saved.getPrice(store.id, unquoted.id), 1388.9);
    saved.reset();
    assert.equal(saved.getProduct(unquoted.id), undefined);
    assert.equal(saved.getProducts().length, products.length);
  });

  test('recycle bin persists products and restores their stock, allocations, units and quotes', () => {
    const { model, storeId, count, weight } = setup();
    count.image = 'data:image/png;base64,aW1hZ2U=';
    count.description = '冷冻保存，开袋后尽快使用。';
    model.setSaleUnits(count.id, [{ unit: '袋', perBase: 1 }, { unit: 'KG', perBase: 2 }]);
    model.setPrice(storeId, count.id, 640, 'inclusive', 0.08);
    model.setUnitQuote(storeId, count.id, 'KG', 320, 'exclusive', 0.08);
    model.setStoreAllocation(storeId, count.id, 4);
    const order = model.submitOrder(storeId, { [count.id]: 2 }, DEMO_DATE);
    const productBefore = structuredClone(count);
    const quoteBefore = model.getQuote(storeId, count.id);
    const unitQuoteBefore = model.getUnitQuote(storeId, count.id, 'KG');
    const orderBefore = structuredClone(order);
    const originalIndex = model.getProducts().findIndex(product => product.id === count.id);
    model.state.cart = { [count.id]: 1, [weight.id]: 0.5 };
    model.state.cartUnits = { [count.id]: 'KG', [weight.id]: 'KG' };

    model.deleteProduct(count.id);
    assert.ok(count.deletedAt);
    assert.equal(model.getProducts().some(product => product.id === count.id), false);
    assert.equal(model.getDeletedProducts().find(product => product.id === count.id), count);
    assert.deepEqual(model.state.orders[0], orderBefore);
    assert.equal(model.getStock(count.id), 8);
    assert.equal(model.getOrderableStock(storeId, count.id), 0);
    assert.equal(model.getUnitOrderableStock(storeId, count.id, 'KG'), 0);
    assert.equal(model.getAllocation(storeId, count.id), 2);
    assert.deepEqual(model.state.cart, { [weight.id]: 0.5 });
    assert.deepEqual(model.state.cartUnits, { [weight.id]: 'KG' });

    const saved = new KitchenModel();
    assert.equal(saved.getProduct(count.id).deletedAt, count.deletedAt);
    assert.equal(saved.getProducts().some(product => product.id === count.id), false);
    assert.deepEqual(saved.getQuote(storeId, count.id), quoteBefore);
    assert.deepEqual(saved.getUnitQuote(storeId, count.id, 'KG'), unitQuoteBefore);
    // Existing orders remain usable while their product is in the recycle bin.
    saved.packLine(order.id, count.id, 2);
    saved.confirmPackLine(order.id, count.id);
    for (const stage of ['ready', 'delivering', 'delivered']) saved.setStage(order.id, stage);
    assert.equal(saved.getWarehouseStock(count.id), 8);
    saved.restoreProduct(count.id);
    assert.equal(saved.getProducts()[originalIndex].id, count.id);
    assert.deepEqual(saved.getProduct(count.id), productBefore);
    assert.deepEqual(saved.getQuote(storeId, count.id), quoteBefore);
    assert.deepEqual(saved.getUnitQuote(storeId, count.id, 'KG'), unitQuoteBefore);
    assert.equal(saved.getAllocation(storeId, count.id), 2);
    assert.equal(saved.getDeletedProducts().length, 0);
    assert.equal(new KitchenModel().getProduct(count.id).deletedAt, undefined);
    saved.submitOrder(storeId, { [count.id]: 1 }, DEMO_DATE);
    assert.equal(saved.getStock(count.id), 7);
  });

  test('deleted products reject stale cart submissions without consuming any other line', () => {
    const { model, storeId, count, weight } = setup();
    model.deleteProduct(count.id);
    const before = structuredClone(model.state);
    const stored = memory.get(STORAGE_KEY);
    assert.throws(() => model.setCartUnit(count.id, count.unit), /回收站/);
    assert.throws(() => model.submitOrder(storeId, { [weight.id]: 1, [count.id]: 1 }, DEMO_DATE), /回收站/);
    assert.deepEqual(model.state, before);
    assert.equal(memory.get(STORAGE_KEY), stored);
  });

  test('recycle operations are repeatable and duplicate additions direct users to restore', () => {
    const { model, count } = setup();
    model.deleteProduct(count.id);
    const deletedAt = count.deletedAt;
    model.deleteProduct(count.id);
    assert.equal(count.deletedAt, deletedAt);
    const before = structuredClone(model.state);
    assert.throws(() => model.addProduct({ name: count.name, category: count.category, unit: count.unit, spec: count.spec }), /回收站恢复/);
    assert.throws(() => model.deleteProduct('missing'), /商品不存在/);
    assert.throws(() => model.restoreProduct('missing'), /商品不存在/);
    assert.deepEqual(model.state, before);
    const next = model.addProduct({ name: '删除后的新商品', category: '饮品', unit: '瓶' });
    assert.notEqual(next.id, count.id);
    model.restoreProduct(count.id);
    const restored = structuredClone(model.state);
    model.restoreProduct(count.id);
    assert.deepEqual(model.state, restored);
  });

  test('stale saved drafts exclude deleted products and new stores retain their reference quotes on restore', () => {
    const { model, count, weight } = setup();
    model.deleteProduct(count.id);
    model.state.cart = { [count.id]: 2, [weight.id]: 0.5 };
    model.state.cartUnits = { [count.id]: '袋', [weight.id]: 'KG' };
    model.save();
    const saved = new KitchenModel();
    assert.deepEqual(saved.state.cart, { [weight.id]: 0.5 });
    assert.deepEqual(saved.state.cartUnits, { [weight.id]: 'KG' });
    const store = saved.addStore({ name: '回收站期间新建门店' });
    assert.equal(saved.getOrderableStock(store.id, count.id), 0);
    saved.restoreProduct(count.id);
    assert.equal(saved.getOrderableStock(store.id, count.id), 10);
    assert.equal(saved.getPrice(store.id, count.id), count.basePrice);
    assert.equal(saved.getQuote(store.id, count.id).taxBasis, 'unspecified');
  });

  test('invalid prices, tax fields, duplicate legacy accounts and catalog changes are rejected before mutation', () => {
    const { model, storeId, count } = setup();
    const before = structuredClone(model.state);
    for (const price of [0, -1, 1.001, NaN, Infinity]) assert.throws(() => model.setPrice(storeId, count.id, price), /两位/);
    assert.throws(() => model.setPrice(storeId, count.id, 100, 'invalid', null), /税口径/);
    assert.throws(() => model.setPrice(storeId, count.id, 100, 'exclusive', 1.1), /税率/);
    assert.throws(() => model.setPrice(storeId, count.id, 100, 'unspecified', 0.08), /税口径/);
    const valid = { name: '其他测试新品', category: '冷冻品', unit: '袋', basePrice: 1000, stock: 10 };
    for (const update of [{ name: count.name }, { name: '' }, { unit: '' }, { category: '不支持分类' }, { basePrice: 0 }, { stock: -1 }, { stock: 1.5 }]) {
      assert.throws(() => model.addProduct({ ...valid, ...update }));
    }
    assert.deepEqual(model.state, before);
    const store = model.addStore({ name: '账号检查门店', account: 'UNIQUE_ACCOUNT' });
    assert.throws(() => model.addStore({ name: '重复账号', account: ' unique_account ' }), /已被使用/);
    assert.equal(model.getStore(store.id).account, 'UNIQUE_ACCOUNT');
  });

  test('version two persistence preserves previous prototype data and restores snapshots and reminders', () => {
    const { model, storeId, count } = setup();
    const legacyKey = 'kuraflow-kitchen-demo-v1';
    const legacyContent = JSON.stringify({ version: 1, sentinel: 'previous demo stays intact' });
    memory.set(legacyKey, legacyContent);
    const order = model.submitOrder(storeId, { [count.id]: 2 }, DEMO_DATE);
    model.remindOrder(order.id);
    assert.ok(memory.has(STORAGE_KEY));
    const restored = new KitchenModel();
    assert.equal(restored.state.orders[0].id, order.id);
    assert.equal(restored.getStock(count.id), 8);
    assert.equal(restored.state.reminders[0].orderId, order.id);
    restored.reset();
    assert.equal(restored.state.orders.length, 1);
    assert.equal(restored.state.reminders.length, 0);
    assert.equal(memory.get(legacyKey), legacyContent);
    assert.deepEqual(restored.state.documents, materialDocuments);
  });

  test('mutable state does not leak between instances or into source data and malformed storage recovers', () => {
    const first = fresh();
    const second = new KitchenModel();
    first.state.products[0].name = '只改第一实例';
    first.state.stores[0].name = '本地测试';
    first.state.orders[0].items[0].packedQty = 99;
    assert.equal(second.getProducts()[0].name, products[0].name);
    assert.equal(second.state.stores[0].name, stores[0].name);
    assert.equal(second.state.orders[0].items[0].packedQty, 0);
    memory.set(STORAGE_KEY, '{broken json');
    assert.equal(new KitchenModel().state.orders.length, 1);
  });

  test('sale units carry independent store prices and deduct one shared inventory pool', () => {
    const m=fresh(), sid=m.state.stores[0].id, other=m.state.stores[1].id;
    const p=m.addProduct({name:'多单位测试',category:'冷冻品',unit:'箱',spec:'15KG/箱',basePrice:1500,stock:10});
    m.setSaleUnits(p.id,[{unit:'箱',perBase:1},{unit:'KG',perBase:15}]);
    m.setUnitQuote(sid,p.id,'KG',120,'exclusive',0.08);
    assert.equal(m.getUnitQuote(other,p.id,'KG').price,null);
    assert.equal(m.getUnitQuote(sid,p.id,'箱').price,1500);
    m.setStoreUnitAllocation(sid,p.id,'KG',30);
    assert.equal(m.getAllocation(sid,p.id),2);
    assert.equal(m.getUnitOrderableStock(sid,p.id,'箱'),2);
    assert.equal(m.getUnitOrderableStock(sid,p.id,'KG'),30);
    m.setCartUnit(p.id,'箱');m.state.cart[p.id]=1;
    m.setCartUnit(p.id,'KG');assert.equal(m.state.cart[p.id],undefined);
    const o=m.submitOrder(sid,{[p.id]:7.5},DEMO_DATE,'',{[p.id]:'KG'});
    assert.equal(o.items[0].unit,'KG');assert.equal(o.items[0].baseQty,0.5);
    assert.equal(o.items[0].price,120);assert.equal(m.orderTotal(o),900);
    assert.equal(m.getStock(p.id),9.5);assert.equal(m.getAllocation(sid,p.id),1.5);
    assert.equal(m.getWarehouseStock(p.id),10);
    m.setSaleUnits(p.id,[{unit:'箱',perBase:1},{unit:'KG',perBase:20}]);
    m.setUnitQuote(sid,p.id,'KG',200);
    assert.equal(o.items[0].perBase,15);assert.equal(m.orderTotal(o),900);
    m.packLine(o.id,p.id,7.5);m.confirmPackLine(o.id,p.id);m.setStage(o.id,'ready');m.setStage(o.id,'delivering');m.setStage(o.id,'delivered');
    assert.equal(m.getWarehouseStock(p.id),9.5);
    assert.throws(()=>m.submitOrder(sid,{[p.id]:{箱:1,KG:1}},DEMO_DATE),/一种单位/);
    assert.throws(()=>m.submitOrder(sid,{[p.id]:0.5},DEMO_DATE,'',{[p.id]:'箱'}),/整数/);
  });
  test('unit settings and product image/details persist without changing historic orders', () => {
    const m=fresh(), sid=m.state.stores[0].id;
    const p=m.addProduct({name:'图片测试',category:'冷冻品',unit:'盒',description:'保存于冷冻环境',image:'data:image/png;base64,aGVsbG8=',stock:2});
    m.setSaleUnits(p.id,[{unit:'盒',perBase:1},{unit:'KG',perBase:0.5}]);
    m.setUnitQuote(sid,p.id,'KG',250);
    const restored=new KitchenModel();
    assert.equal(restored.getProduct(p.id).description,'保存于冷冻环境');
    assert.equal(restored.getProduct(p.id).image,p.image);
    assert.equal(restored.getUnitQuote(sid,p.id,'KG').price,250);
    assert.throws(()=>m.setSaleUnits(p.id,[{unit:'斤',perBase:2}]),/有效单位/);
    assert.throws(()=>m.setSaleUnits(p.id,[{unit:'KG',perBase:1},{unit:'KG',perBase:2}]),/重复/);
  });

  test('two-sided conversion equations preserve their input and resolve connected units from either direction', () => {
    const m = fresh();
    const p = m.addProduct({ name: '双向换算牛骨', category: '冷冻品', unit: '箱', stock: 10 });
    const equations = [
      { fromQty: 30, fromUnit: 'KG', toQty: 2, toUnit: '箱' },
      { fromQty: 5, fromUnit: 'KG', toQty: 1, toUnit: '袋' },
      { fromQty: 1, fromUnit: '箱', toQty: 3, toUnit: '袋' },
    ];
    m.setSaleUnitEquations(p.id, equations);
    assert.equal(m.getUnitFactor(p.id, '箱'), 1);
    assert.equal(m.getUnitFactor(p.id, 'KG'), 15);
    assert.equal(m.getUnitFactor(p.id, '袋'), 3);
    assert.deepEqual(m.getSaleUnitEquations(p.id), equations);
    equations[0].fromQty = 99;
    const returned = m.getSaleUnitEquations(p.id);
    returned[0].toQty = 99;
    const restored = new KitchenModel();
    assert.equal(restored.getSaleUnitEquations(p.id)[0].fromQty, 30);
    assert.equal(restored.getSaleUnitEquations(p.id)[0].toQty, 2);
    assert.equal(restored.getUnitFactor(p.id, 'KG'), 15);
    restored.setSaleUnits(p.id, [{ unit: '箱', perBase: 1 }, { unit: 'KG', perBase: 20 }]);
    assert.deepEqual(restored.getSaleUnitEquations(p.id), [
      { fromQty: 1, fromUnit: '箱', toQty: 1, toUnit: '箱' },
      { fromQty: 1, fromUnit: '箱', toQty: 20, toUnit: 'KG' },
    ]);
  });

  test('contradictory, disconnected or invalid conversion equations preserve stock, quotes and orders', () => {
    const m = fresh(), sid = m.state.stores[0].id;
    const p = m.addProduct({ name: '换算约束测试', category: '冷冻品', unit: '箱', basePrice: 1500, stock: 10 });
    const valid = { fromQty: 1, fromUnit: '箱', toQty: 15, toUnit: 'KG' };
    m.setSaleUnitEquations(p.id, [valid]);
    m.setUnitQuote(sid, p.id, 'KG', 100);
    const order = m.submitOrder(sid, { [p.id]: 7.5 }, DEMO_DATE, '', { [p.id]: 'KG' });
    const snapshot = structuredClone(order);
    const before = structuredClone(m.state), stored = memory.get(STORAGE_KEY);
    for (const invalid of [
      [], [valid, { fromQty: 1, fromUnit: '箱', toQty: 16, toUnit: 'KG' }],
      [valid, { fromQty: 1, fromUnit: '袋', toQty: 2, toUnit: '盒' }],
      [{ fromQty: 1, fromUnit: 'KG', toQty: 2, toUnit: '袋' }],
      [{ fromQty: 1, fromUnit: '箱', toQty: 2, toUnit: '箱' }],
      [{ ...valid, toUnit: '斤' }], ...[0, -1, NaN, Infinity, true, '', 0.0000001].map(fromQty => [{ ...valid, fromQty }]),
    ]) assert.throws(() => m.setSaleUnitEquations(p.id, invalid));
    assert.deepEqual(m.state, before);
    assert.equal(memory.get(STORAGE_KEY), stored);
    m.setSaleUnitEquations(p.id, [{ fromQty: 30, fromUnit: 'KG', toQty: 1, toUnit: '箱' }]);
    assert.deepEqual(order, snapshot);
    assert.equal(m.getStock(p.id), 9.5);
    assert.equal(m.getReservedQty(p.id), 0.5);
    assert.equal(m.getUnitQuote(sid, p.id, 'KG').price, 100);
  });

  test('reciprocal ratios keep sufficient precision and explicit legacy weight units retain their original base', () => {
    const m = fresh(), sid = m.state.stores[0].id;
    const p = m.addProduct({ name: '三箱一KG', category: '冷冻品', unit: '箱', basePrice: 500 });
    const relation = [{ fromQty: 1, fromUnit: 'KG', toQty: 3, toUnit: '箱' }];
    m.setSaleUnitEquations(p.id, relation);
    assert.equal(m.getUnitFactor(p.id, 'KG'), 1 / 3);
    m.setWarehouseUnitStock(p.id, 'KG', 1);
    assert.equal(m.getWarehouseStock(p.id), 3);
    assert.equal(m.getWarehouseUnitStock(p.id, 'KG'), 1);
    assert.deepEqual(new KitchenModel().getSaleUnitEquations(p.id), relation);
    const legacy = m.getProducts().find(product => product.unit === '500g');
    assert.ok(legacy);
    const oldQuote = m.getQuote(sid, legacy.id);
    const oldOrders = structuredClone(m.state.orders);
    assert.deepEqual(m.getSaleUnitEquations(legacy.id), [{ fromQty: 1, fromUnit: '500g', toQty: 1, toUnit: '500g' }]);
    // Previously saved KG-only equations remain supported without changing base stock.
    m.setSaleUnitEquations(legacy.id, [{ fromQty: 1, fromUnit: 'KG', toQty: 1, toUnit: 'KG' }]);
    assert.equal(m.getProduct(legacy.id).unit, '500g');
    assert.deepEqual(m.getSaleUnits(legacy.id), [{ unit: 'KG', perBase: 0.5 }]);
    assert.deepEqual(m.getQuote(sid, legacy.id), oldQuote);
    assert.equal(m.getUnitQuote(sid, legacy.id, 'KG').price, null);
    m.setWarehouseUnitStock(legacy.id, 'KG', 1);
    assert.equal(m.getWarehouseStock(legacy.id), 2);
    assert.equal(m.getWarehouseUnitStock(legacy.id, 'KG'), 1);
    assert.deepEqual(m.state.orders, oldOrders);
  });

  test('package and 500g sales retain their own prices and discrete quantities', () => {
    const m = fresh(), sid = m.state.stores[0].id;
    const weight = m.addProduct({ name: '半公斤供货测试', category: '冷冻品', unit: 'KG', stock: 5 });
    const pack = m.addProduct({ name: '包供货测试', category: '常温品', unit: '包', stock: 10 });
    m.setSaleUnitEquations(weight.id, [{ fromQty: 1, fromUnit: 'KG', toQty: 2, toUnit: '500g' }]);
    assert.equal(m.getUnitFactor(weight.id, '500g'), 2);
    const plan = m.createQuotePlan('原单位报价测试');
    m.setQuotePlanPrice(plan.id, weight.id, '500g', { price: 2160, taxBasis: 'exclusive', taxRate: .08 });
    m.setQuotePlanPrice(plan.id, pack.id, '包', { price: 260, taxBasis: 'exclusive', taxRate: .08 });
    m.setStoreQuotePlan(sid, plan.id);
    const order = m.submitOrder(sid, { [weight.id]: 3, [pack.id]: 2 }, DEMO_DATE, '', { [weight.id]: '500g', [pack.id]: '包' });
    assert.equal(order.items[0].price, 2160);
    assert.equal(order.items[0].baseQty, 1.5);
    assert.equal(order.items[1].unit, '包');
    assert.equal(m.getStock(weight.id), 3.5);
    assert.equal(m.getStock(pack.id), 8);
    for (const [product, unit] of [[weight, '500g'], [pack, '包']]) {
      assert.throws(() => m.submitOrder(sid, { [product.id]: .5 }, DEMO_DATE, '', { [product.id]: unit }), /整数|整数数量/);
    }
    assert.throws(() => m.setSaleUnits(weight.id, [{ unit: 'KG', perBase: 1 }, { unit: '500g', perBase: 1 }]), /2 × 500g/);
    assert.throws(() => m.setSaleUnitEquations(weight.id, [{ fromQty: 1, fromUnit: 'KG', toQty: 1, toUnit: '500g' }]), /2 × 500g/);
    assert.equal(m.getUnitFactor(weight.id, '500g'), 2);
  });

  test('warehouse counts accept configured units and protect reserved and allocated stock after conversion', () => {
    const m = fresh(), sid = m.state.stores[0].id;
    const p = m.addProduct({ name: '盘点单位测试', category: '冷冻品', unit: '箱', basePrice: 1500, stock: 10 });
    m.setSaleUnitEquations(p.id, [{ fromQty: 1, fromUnit: '箱', toQty: 15, toUnit: 'KG' }]);
    m.setUnitQuote(sid, p.id, 'KG', 100);
    m.setStoreUnitAllocation(sid, p.id, 'KG', 30);
    const order = m.submitOrder(sid, { [p.id]: 7.5 }, DEMO_DATE, '', { [p.id]: 'KG' });
    const snapshot = structuredClone(order);
    m.setWarehouseUnitStock(p.id, 'KG', 60);
    assert.equal(m.getWarehouseStock(p.id), 4);
    assert.equal(m.getStock(p.id), 3.5);
    assert.equal(m.getWarehouseUnitStock(p.id, 'KG'), 60);
    assert.equal(m.getAllocation(sid, p.id), 1.5);
    const before = structuredClone(m.state);
    assert.throws(() => m.setWarehouseUnitStock(p.id, 'KG', 29), /订单占用/);
    assert.throws(() => m.setWarehouseUnitStock(p.id, '箱', 0.5), /整数/);
    assert.throws(() => m.setWarehouseUnitStock(p.id, 'KG', 1.0001), /三位/);
    assert.throws(() => m.setWarehouseUnitStock(p.id, '袋', 1), /不支持/);
    assert.deepEqual(m.state, before);
    m.setWarehouseUnitStock(p.id, 'KG', 31.25);
    assert.equal(m.getWarehouseUnitStock(p.id, 'KG'), 31.25);
    assert.ok(m.getWarehouseStock(p.id) * m.getUnitFactor(p.id, 'KG') <= 31.25);
    assert.deepEqual(order, snapshot);
    m.setWarehouseUnitStock(p.id, '箱', null);
    assert.equal(m.getWarehouseUnitStock(p.id, 'KG'), null);
  });

  test('stock count precision is stable on reload and the non-sale base unit is never enabled for ordering', () => {
    const m = fresh(), sid = m.state.stores[0].id;
    const p = m.addProduct({ name: '仅按KG卖的箱装商品', category: '冷冻品', unit: '箱', basePrice: 1500 });
    m.setSaleUnits(p.id, [{ unit: 'KG', perBase: 15 }]);
    assert.equal(m.getUnitFactor(p.id, '箱'), 1);
    m.setUnitQuote(sid, p.id, 'KG', 100);
    m.setWarehouseUnitStock(p.id, 'KG', 1);
    const baseStock = m.getStock(p.id);
    assert.ok(Math.abs(baseStock - 1 / 15) < 1e-15);
    assert.equal(m.getWarehouseUnitStock(p.id, 'KG'), 1);
    assert.equal(m.getUnitOrderableStock(sid, p.id, 'KG'), 1);
    const restored = new KitchenModel();
    restored.setWarehouseUnitStock(p.id, 'KG', restored.getWarehouseUnitStock(p.id, 'KG'));
    assert.equal(restored.getStock(p.id), baseStock);
    assert.throws(() => restored.setCartUnit(p.id, '箱'), /不支持/);
    assert.throws(() => restored.submitOrder(sid, { [p.id]: 1 }, DEMO_DATE, '', { [p.id]: '箱' }), /不支持/);
    assert.throws(() => restored.setUnitQuote(sid, p.id, '箱', 100), /不支持/);
    restored.submitOrder(sid, { [p.id]: 1 }, DEMO_DATE, '', { [p.id]: 'KG' });
    assert.equal(restored.getStock(p.id), 0);
    assert.equal(restored.getUnitOrderableStock(sid, p.id, 'KG'), 0);
    assert.throws(() => restored.submitOrder(sid, { [p.id]: 0.001 }, DEMO_DATE, '', { [p.id]: 'KG' }), /库存不足/);
  });

  test('repeated small weight orders never gain stock through conversion rounding', () => {
    const m = fresh(), sid = m.state.stores[0].id;
    const p = m.addProduct({ name: '微量换算库存', category: '冷冻品', unit: '箱', basePrice: 1500 });
    m.setSaleUnitEquations(p.id, [{ fromQty: 1, fromUnit: '箱', toQty: 3, toUnit: 'KG' }]);
    m.setUnitQuote(sid, p.id, 'KG', 100);
    m.setWarehouseUnitStock(p.id, 'KG', 1);
    m.save = () => m.state;
    let ordered = 0;
    while (m.getUnitOrderableStock(sid, p.id, 'KG') >= 0.001 && ordered < 1100) {
      m.submitOrder(sid, { [p.id]: 0.001 }, DEMO_DATE, '', { [p.id]: 'KG' });
      ordered++;
    }
    assert.equal(ordered, 1000);
    assert.ok(m.getStock(p.id) >= 0);
    assert.throws(() => m.submitOrder(sid, { [p.id]: 0.001 }, DEMO_DATE, '', { [p.id]: 'KG' }), /库存不足/);
  });

  test('local store codes are unique, persisted on first load and accept normalized lookup without switching stores', () => {
    const m = fresh();
    const initialActive = m.state.activeStoreId;
    const store = m.addStore({
      name: '大阪の新店舗', prefecture: '大阪府', municipality: '大阪市', ward: '中央区',
      addressDetail: '難波一丁目 1-1 テストビル 2F', contact: '田中', phone: '06-1234-5678',
    });
    assert.equal(store.address, '大阪府大阪市中央区難波一丁目 1-1 テストビル 2F');
    assert.equal(store.city, '大阪市');
    assert.equal(store.account, '');
    const codes = m.state.stores.map(item => item.accessCode);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) {
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.match(code, /[A-Z]/); assert.match(code, /[0-9]/);
    }
    const entered = ` ${store.accessCode.toLowerCase().replaceAll('-', ' ')} `;
    assert.equal(normalizeStoreAccessCode(entered), store.accessCode);
    assert.equal(m.getStoreByAccessCode(entered), store);
    for (const invalid of [null, {}, '', 'AAAAAAAAAAAA', '123456789012', 'not-a-valid-code', `${store.accessCode}!`]) {
      assert.equal(m.getStoreByAccessCode(invalid), undefined);
    }
    assert.equal(m.state.activeStoreId, initialActive);
    const restored = new KitchenModel();
    assert.equal(restored.getStoreByAccessCode(entered).id, store.id);
    assert.deepEqual(restored.state.stores.map(item => item.accessCode), codes);
    assert.ok(memory.get(STORAGE_KEY));
    assert.ok(stores.every(item => !item.accessCode));
  });

  test('local code migration repairs only local copies and server-created models do not gain local login behavior', () => {
    const m = fresh();
    m.state.stores[0].accessCode = 'ABCD-1234-EFGH';
    m.state.stores[2].accessCode = m.state.stores[1].accessCode;
    m.save();
    const restored = new KitchenModel();
    assert.equal(new Set(restored.state.stores.map(item => item.accessCode)).size, restored.state.stores.length);
    assert.match(JSON.parse(memory.get(STORAGE_KEY)).stores[0].accessCode, /^(?:[A-Z0-9]{4}-){3}[A-Z0-9]{4}$/);
    assert.equal(restored.getStoreByAccessCode('ABCD-1234-EFGH'), undefined);
    const server = Object.create(KitchenModel.prototype);
    server.state = structuredClone(restored.state); server.storage = null;
    const previous = structuredClone(server.state);
    assert.equal(server.getStoreByAccessCode(restored.state.stores[0].accessCode), undefined);
    assert.deepEqual(server.state, previous);
    const store = server.addStore({ name: '线上兼容门店', account: 'server_legacy_account' });
    assert.equal(store.accessCode, undefined);
    assert.equal(server.getStoreByAccessCode(store.accessCode), undefined);
  });

  test('store edits preserve identity, code, quotes and orders while saving photo and address fields', () => {
    const { model, count } = setup();
    const photo = 'data:image/jpeg;base64,YWJj';
    const store = model.addStore({ name: '图片门店', image: photo, prefectureCode: '27', municipalityCode: '27100', wardCode: '27111' });
    const code = store.accessCode;
    model.setPrice(store.id, count.id, 890);
    const order = model.submitOrder(store.id, { [count.id]: 1 });
    model.updateStore(store.id, { name: '已编辑门店', contact: '田中', phone: '090-1234-5678' });
    assert.equal(store.image, photo);
    assert.equal(store.prefectureCode, '27');
    assert.equal(store.accessCode, code);
    assert.equal(model.getStoreByAccessCode(code).name, '已编辑门店');
    assert.equal(model.getQuote(store.id, count.id).price, 890);
    assert.equal(model.state.orders.find(item => item.id === order.id).storeId, store.id);
    model.updateStore(store.id, { image: null });
    assert.equal(store.image, null);
    const before = structuredClone(model.state);
    assert.throws(() => model.updateStore(store.id, { name: '不得保存', image: 'https://example.com/photo.jpg' }), /有效.*图片/);
    assert.deepEqual(model.state, before);
    const restored = new KitchenModel();
    assert.equal(restored.getStore(store.id).name, '已编辑门店');
    assert.equal(restored.getStore(store.id).image, null);
  });

  test('deleting a store removes access and unused allocations but retains historical orders', () => {
    const { model, count } = setup();
    const store = model.addStore({ name: '待删除门店' });
    model.setStoreAllocation(store.id, count.id, 4);
    const order = model.submitOrder(store.id, { [count.id]: 1 });
    model.state.activeStoreId = store.id;
    model.state.cart[count.id] = 1;
    const inventory = structuredClone(model.state.inventory), savedOrder = structuredClone(order);
    const deleted = model.deleteStore(store.id);
    assert.ok(deleted.deletedAt);
    assert.equal(model.getStores().some(item => item.id === store.id), false);
    assert.equal(model.getStoreByAccessCode(store.accessCode), undefined);
    assert.equal(model.getStore(store.id).name, '待删除门店');
    assert.deepEqual(model.state.orders.find(item => item.id === order.id), savedOrder);
    assert.deepEqual(model.state.inventory, inventory);
    assert.equal(model.getAllocatedQty(count.id), 0);
    assert.equal(model.getReservedQty(count.id), 1);
    assert.deepEqual(model.state.cart, {});
    assert.notEqual(model.state.activeStoreId, store.id);
    assert.equal(model.getOrderableStock(store.id, count.id), 0);
    assert.throws(() => model.submitOrder(store.id, { [count.id]: 1 }), /有效.*门店/);
    assert.throws(() => model.setStoreAllocation(store.id, count.id, 1), /已删除/);
    assert.throws(() => model.updateStore(store.id, { name: '不能复活' }), /已删除/);
    assert.equal(model.deleteStore(store.id).deletedAt, deleted.deletedAt);
    const restored = new KitchenModel();
    assert.equal(restored.getStores().some(item => item.id === store.id), false);
    assert.equal(restored.getStoreByAccessCode(store.accessCode), undefined);
  });

  test('packing confirmation requires exact quantities, resets after edits and accepts legacy completion', () => {
    const { model, storeId, count } = setup();
    const order = model.submitOrder(storeId, { [count.id]: 2 });
    const line = order.items[0];
    assert.throws(() => model.confirmPackLine(order.id, count.id), /尚未补全/);
    model.packLine(order.id, count.id, 1);
    assert.equal(order.stage, 'packing');
    assert.equal(line.packingConfirmed, false);
    assert.throws(() => model.confirmPackLine(order.id, count.id), /尚未补全/);
    model.packLine(order.id, count.id, 2);
    assert.throws(() => model.setStage(order.id, 'ready'), /未配齐/);
    model.confirmPackLine(order.id, count.id);
    assert.equal(line.packingConfirmed, true);
    model.confirmPackLine(order.id, count.id);
    model.packLine(order.id, count.id, 2);
    assert.equal(line.packingConfirmed, true);
    model.packLine(order.id, count.id, 1);
    assert.equal(line.packingConfirmed, false);
    model.packLine(order.id, count.id, 2);
    assert.equal(line.packingConfirmed, false);
    delete line.packingConfirmed;
    model.setStage(order.id, 'ready');
    assert.throws(() => model.confirmPackLine(order.id, count.id), /不能修改/);
    model.setStage(order.id, 'delivering');
    model.setStage(order.id, 'delivered');
  });

  test('packing checklist completes saved quantities atomically and can undo without changing stock or notes', () => {
    const { model, storeId, count, weight } = setup();
    const order = model.submitOrder(storeId, { [count.id]: 2, [weight.id]: 0.125 });
    const inventory = structuredClone(model.state.inventory);
    const line = order.items[0];
    model.setPackingNote(order.id, count.id, '  缺货，等待补货  ');
    assert.equal(line.packingNote, '缺货，等待补货');
    assert.equal(line.packedQty, 0);
    assert.equal(order.stage, 'pending');
    model.setPackLineDone(order.id, count.id, true);
    assert.equal(order.stage, 'packing');
    assert.equal(line.packedQty, 2);
    assert.equal(line.packingConfirmed, true);
    model.setPackLineDone(order.id, count.id, true);
    assert.equal(line.packedQty, 2);
    assert.throws(() => model.setStage(order.id, 'ready'), /未配齐/);
    model.setPackLineDone(order.id, count.id, false);
    assert.equal(line.packedQty, 0);
    assert.equal(line.packingConfirmed, false);
    assert.equal(line.packingNote, '缺货，等待补货');
    assert.deepEqual(model.state.inventory, inventory);
    const restored = new KitchenModel();
    const savedLine = restored.state.orders.find(item => item.id === order.id).items[0];
    assert.equal(savedLine.packingNote, '缺货，等待补货');
    assert.equal(savedLine.packingConfirmed, false);
    model.setPackingNote(order.id, count.id, '  ');
    assert.equal(line.packingNote, undefined);
    const before = structuredClone(order);
    assert.throws(() => model.setPackLineDone(order.id, count.id, 'true'), /有效的配货状态/);
    assert.throws(() => model.setPackLineDone(order.id, 'missing-product', true), /没有这项商品/);
    assert.throws(() => model.setPackingNote(order.id, count.id, 'a'.repeat(1001)), /最多 1000 字/);
    assert.deepEqual(order, before);
    model.setPackLineDone(order.id, count.id, true);
    model.setPackLineDone(order.id, weight.id, true);
    assert.equal(order.items[1].packedQty, 0.125);
    model.setStage(order.id, 'ready');
    assert.throws(() => model.setPackLineDone(order.id, count.id, false), /不能修改/);
    assert.throws(() => model.setPackingNote(order.id, count.id, '迟来的备注'), /不能修改/);
  });

  test('store catalogue and unit choices exclude missing prices and clear obsolete cart quantities', () => {
    const { model, storeId, count, unquoted } = setup();
    model.setSaleUnits(unquoted.id, [{unit:'盒', perBase:1}, {unit:'袋', perBase:2}]);
    model.setUnitQuote(storeId, unquoted.id, '袋', 80);
    assert.deepEqual(model.getQuotedSaleUnits(storeId, unquoted.id).map(u => u.unit), ['袋']);
    model.state.cart = {[unquoted.id]:3, [count.id]:2};
    model.normalizeStoreCart(storeId);
    assert.equal(model.getCartUnit(unquoted.id), '袋');
    assert.equal(model.state.cart[unquoted.id], undefined);
    assert.equal(model.state.cart[count.id], 2);
    model.state.cart[unquoted.id] = 4;
    delete model.state.unitQuotes[storeId][unquoted.id];
    model.normalizeStoreCart(storeId);
    assert.equal(model.getOrderableProducts(storeId).some(p => p.id === unquoted.id), false);
    assert.equal(model.state.cart[unquoted.id], undefined);
    assert.equal(model.state.cartUnits[unquoted.id], undefined);
    model.getProduct(count.id).catalogueHidden = true;
    assert.equal(model.getProducts().some(p => p.id === count.id), false);
    assert.equal(model.getProduct(count.id).id, count.id);
  });

  console.log(`\n${passed} model tests passed.`);
} finally {
  if (originalStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', originalStorageDescriptor);
  else delete globalThis.localStorage;
}
