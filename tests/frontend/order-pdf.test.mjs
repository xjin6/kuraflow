import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import { createOrderPDF } from '../../src/features/settlement/order-pdf.js';
import { orderSettlement } from '../../src/shared/settlement-data.js';
import { dailyOrderSummary } from '../../src/shared/daily-orders.js';

const [fontBytes, serifFontBytes] = await Promise.all([
  readFile(new URL('../../public/fonts/KuraflowDocumentSans.ttf', import.meta.url)),
  readFile(new URL('../../public/fonts/KuraflowDocumentSerif.ttf', import.meta.url)),
]);
const pdfOptions = { fontBytes, serifFontBytes, issuedDate: '2026-10-19' };
const sealUrl = '/api/images/00000000-0000-4000-8000-000000000001';
// A synthetic 1 px image; no real document or company seal is checked into tests.
const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV6kAAAAASUVORK5CYII=', 'base64');

function makeRecord(items, { order = {}, issuer = {}, store = {} } = {}) {
  const model = {
    getStore: () => ({ id: 'test-store', name: '納品先テスト', ...store }),
    getProduct: () => ({ name: '現在の商品名', price: 98765, taxRate: 0.1, unit: '箱', spec: '現在の規格' }),
  };
  return orderSettlement(model, {
    id: 'PDF-TEST-001', storeId: 'test-store', deliveryDate: '2026-10-17', stage: 'delivered',
    shipping: 0, shippingTax: 0, items, ...order,
  }, { name: '発行者テスト', address: 'テスト住所', phone: '000-0000-0000', representative: '担当者テスト', ...issuer });
}

const item = (overrides = {}) => ({
  productId: 'test-product', productName: '注文時の商品', spec: '注文時の規格', unit: '個',
  qty: 2, price: 125, taxBasis: 'exclusive', taxRate: 0.08, ...overrides,
});

// Read actual embedded text from the generated PDF, using the font's ToUnicode
// map. This validates emitted content without installing a second PDF runtime.
async function inspectPdf(bytes) {
  const doc = await PDFDocument.load(bytes);
  const decodedFontMaps = new Map();
  const pages = doc.getPages().map(page => {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'));
    const fontMaps = new Map();
    for (const [name, reference] of fonts.entries()) {
      if (decodedFontMaps.has(reference.toString())) {
        fontMaps.set(name.toString(), decodedFontMaps.get(reference.toString()));
        continue;
      }
      const font = doc.context.lookup(reference);
      const cmap = Buffer.from(decodePDFRawStream(font.lookup(PDFName.of('ToUnicode'))).decode()).toString();
      const unicode = new Map();
      for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
          const value = pair[2].match(/.{4}/g).map(code => String.fromCharCode(parseInt(code, 16))).join('');
          unicode.set(pair[1].toUpperCase(), value);
        }
      }
      decodedFontMaps.set(reference.toString(), unicode);
      fontMaps.set(name.toString(), unicode);
    }
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const runs = [];
    for (const stream of streams) {
      const body = Buffer.from(decodePDFRawStream(doc.context.lookup(stream)).decode()).toString();
      for (const block of body.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
        const fontName = block[1].match(/(\/[^\s]+)\s+[\d.]+\s+Tf/)?.[1];
        const mapping = fontMaps.get(fontName);
        assert.ok(mapping, 'every text run has an embedded Unicode mapping');
        for (const value of block[1].matchAll(/<([\da-f]+)>\s*Tj/gi)) {
          const decoded = value[1].match(/.{4}/g).map(code => {
            assert.ok(mapping.has(code.toUpperCase()), `glyph ${code} is readable`);
            return mapping.get(code.toUpperCase());
          }).join('');
          runs.push(decoded);
        }
      }
    }
    return { ...page.getSize(), runs, text: runs.join('\n'), images: page.node.Resources().lookup(PDFName.of('XObject'))?.entries().length || 0 };
  });
  return { doc, pages, runs: pages.flatMap(page => page.runs), text: pages.map(page => page.text).join('\n') };
}

test('delivery PDF uses the approved landscape page and stored order values without a default seal', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('unconfigured seal must not make a network request'));
  const record = makeRecord([item()]);
  const before = structuredClone(record);
  const pdf = await inspectPdf(await createOrderPDF(record, pdfOptions));
  assert.equal(pdf.pages.length, 1);
  assert.equal(pdf.pages[0].width, 841.68);
  assert.equal(pdf.pages[0].height, 595.44);
  assert.equal(pdf.pages[0].images, 0);
  assert.match(pdf.text, /納品先テスト御中/);
  assert.match(pdf.text, /発行者テスト/);
  assert.match(pdf.text, /発行日：2026\/10\/19/);
  assert.match(pdf.text, /注文時の商品 注文時の規格/);
  assert.ok(pdf.runs.includes('個'));
  assert.ok(pdf.runs.includes('125'));
  assert.ok(pdf.runs.includes('250'));
  assert.ok(pdf.runs.includes('20'));
  assert.match(pdf.text, /¥270 -/);
  assert.doesNotMatch(pdf.text, /現在の商品名|現在の規格|98765/);
  assert.deepEqual(record, before, 'export does not mutate historical order data');
});

test('daily PDF shows the delivery day, combined KG quantity and exact saved totals with source IDs in metadata',async()=>{
 const model={getStore:id=>({id,name:'合并演示门店'}),getProduct:()=>({})};
 const orders=[.125,.25].map((qty,index)=>({id:'SOURCE-'+index,storeId:'s1',deliveryDate:'2026-10-30',stage:'delivered',shipping:0,shippingTax:0,items:[item({qty,unit:'KG',price:100,perBase:1})]}));
 const record=dailyOrderSummary(model,orders,{name:'演示厨房'}),before=structuredClone(orders);
 const pdf=await inspectPdf(await createOrderPDF(record,pdfOptions));
 assert.equal(pdf.pages.length,1);assert.match(pdf.text,/納品日：2026\/10\/30 \/ 2件合算/);assert.ok(pdf.runs.includes('0.375'));assert.ok(pdf.runs.includes('37.5'));assert.match(pdf.text,/¥40.5 -/);
 assert.match(pdf.doc.getSubject(),/SOURCE-0, SOURCE-1/);assert.doesNotMatch(pdf.text,/SOURCE-0|SOURCE-1/);assert.deepEqual(orders,before);
});

test('multipage export preserves all rows and an oversized name without duplicating its quantity', async () => {
  const longName = '長'.repeat(1500) + '末尾確認';
  const items = Array.from({ length: 35 }, (_, index) => item({ productName: `明細番号${String(index + 1).padStart(3, '0')}`, spec: '' }));
  items.splice(7, 0, item({ productName: longName, spec: '', qty: 37.13, price: 3.17, unit: '特別単位' }));
  const pdf = await inspectPdf(await createOrderPDF(makeRecord(items), pdfOptions));
  assert.ok(pdf.pages.length > 3);
  assert.doesNotMatch(pdf.text, /PDF-TEST-001/, 'the order identifier is omitted from the visible footer');
  assert.match(pdf.doc.getSubject(), /PDF-TEST-001/, 'order identification remains in document metadata');
  for (const page of pdf.pages) assert.deepEqual([page.width, page.height], [841.68, 595.44]);
  for (let index = 1; index <= 35; index++) {
    const name = `明細番号${String(index).padStart(3, '0')}`;
    assert.equal(pdf.text.split(name).length - 1, 1, `${name} appears exactly once`);
  }
  assert.equal([...pdf.text].filter(char => char === '長').length, 1500);
  assert.match(pdf.text, /末尾確認/);
  assert.equal(pdf.runs.filter(value => value === '37.13').length, 1);
  assert.equal(pdf.runs.filter(value => value === '特別単位').length, 1);
  assert.equal(pdf.runs.filter(value => value === '税込合計').length, 1);
  assert.match(pdf.pages.at(-1).text, new RegExp(`${pdf.pages.length} / ${pdf.pages.length}`));
});

test('unknown price and tax remain explicitly unknown in emitted totals', async () => {
  const record = makeRecord([item({ price: null }), item({ productName: '税区分未確認の商品', price: 50, taxBasis: 'unspecified', taxRate: null })], { order: { shipping: null, shippingTax: null } });
  assert.equal(record.unpriced, 1);
  assert.equal(record.taxUnknown, 2);
  assert.equal(record.amount, 100);
  assert.equal(record.tax, null);
  assert.equal(record.gross, null);
  const pdf = await inspectPdf(await createOrderPDF(record, pdfOptions));
  assert.ok(pdf.runs.filter(value => value === '未確定').length >= 5);
  assert.match(pdf.text, /確認済み小計/);
  assert.match(pdf.text, /単価未確定の明細は小計に含めていません/);
  assert.match(pdf.text, /税区分未確認/);
  assert.match(pdf.text, /運賃未確認/);
  assert.doesNotMatch(pdf.text, /¥0 -/);
});

test('inclusive and mixed taxes preserve the settlement arithmetic in the PDF', async () => {
  const inclusive = makeRecord([item({ qty: 2, price: 108, taxBasis: 'inclusive' })]);
  assert.equal(inclusive.net, 200);
  assert.equal(inclusive.tax, 16);
  assert.equal(inclusive.gross, 216);
  const includedPdf = await inspectPdf(await createOrderPDF(inclusive, pdfOptions));
  assert.match(includedPdf.text, /小計（税込）/);
  assert.match(includedPdf.text, /内消費税（8%）/);
  assert.match(includedPdf.text, /¥216 -/);
  assert.doesNotMatch(includedPdf.text, /¥232 -/);

  const mixed = makeRecord([
    item({ qty: 1, price: 108, taxBasis: 'inclusive' }),
    item({ productName: '税別商品', qty: 1, price: 100, taxBasis: 'exclusive', taxRate: 0.1 }),
  ], { order: { shipping: 50, shippingTax: 5 } });
  assert.deepEqual([mixed.net, mixed.tax, mixed.gross], [200, 18, 218]);
  const mixedPdf = await inspectPdf(await createOrderPDF(mixed, pdfOptions));
  assert.match(mixedPdf.text, /消費税（8%）/);
  assert.match(mixedPdf.text, /消費税（10%）/);
  assert.match(mixedPdf.text, /運賃消費税/);
  assert.match(mixedPdf.text, /¥273 -/);
  assert.match(mixedPdf.text, /消費税を控除して小計を計算/);
});

test('an empty order exports an explicit empty detail grid', async () => {
  const pdf = await inspectPdf(await createOrderPDF(makeRecord([]), pdfOptions));
  assert.equal(pdf.pages.length, 1);
  assert.match(pdf.text, /明細なし/);
  assert.match(pdf.text, /税込合計/);
});

test('a configured seal must be a same-origin protected image path', async t => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; assert.fail('invalid seal URL cannot be fetched'); });
  for (const url of ['https://example.invalid/seal.png', '//example.invalid/seal.png', '/public/seal.png', `${sealUrl}?token=private`]) {
    await assert.rejects(createOrderPDF(makeRecord([item()], { issuer: { sealUrl: url } }), pdfOptions), /公章地址无效/);
  }
  assert.equal(fetched, false);
});

test('a missing configured seal stops export rather than silently omitting it', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return new Response(null, { status: 404 }); });
  await assert.rejects(createOrderPDF(makeRecord([item()], { issuer: { sealUrl } }), pdfOptions), /公章加载失败/);
  assert.deepEqual(requests, [{ url: sealUrl, options: { credentials: 'same-origin', cache: 'no-store' } }]);
});

test('an authorized synthetic seal is embedded; oversized or corrupt image responses fail', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(syntheticPng));
  const record = makeRecord([item()], { issuer: { sealUrl } });
  const pdf = await inspectPdf(await createOrderPDF(record, pdfOptions));
  assert.equal(pdf.pages[0].images, 1);
  globalThis.fetch.mock.mockImplementation(async () => new Response(new Uint8Array(204801)));
  await assert.rejects(createOrderPDF(record, pdfOptions), /公章文件过大/);
  globalThis.fetch.mock.mockImplementation(async () => new Response('not an image'));
  await assert.rejects(createOrderPDF(record, pdfOptions), /公章文件无法读取/);
});
