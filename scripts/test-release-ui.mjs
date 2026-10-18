import {chromium} from '/Users/xinjin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:'/Users/xinjin/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
await fs.mkdir('tmp/release-review',{recursive:true});
try{
 await page.goto('http://127.0.0.1:4173/?page=catalogue');await page.locator('.catalog-table').waitFor();
 const id=await page.evaluate(async()=>{const {KitchenModel}=await import('/data.js');const m=new KitchenModel();const p=m.addProduct({name:'报价验收牛骨',unit:'箱',spec:'15KG/箱',stock:100,category:'冷冻品'});m.setSaleUnitEquations(p.id,[{fromQty:1,fromUnit:'箱',toQty:15,toUnit:'KG'},{fromQty:1,fromUnit:'箱',toQty:3,toUnit:'袋'}]);return p.id;});
 await page.reload();await page.getByRole('tab',{name:/门店库存与报价/}).click();
 await page.locator('#catalogue-search').fill('报价验收牛骨');
 const row=page.locator(`[data-catalogue-row="${id}"]`);await row.getByRole('button',{name:'添加报价',exact:true}).click();
 await row.getByLabel('报价验收牛骨报价单位').selectOption('箱');await row.getByLabel('报价验收牛骨单价',{exact:true}).fill('1500');
 await row.getByLabel('报价验收牛骨税口径').selectOption('exclusive');await row.getByLabel('报价验收牛骨税率',{exact:true}).fill('8');
 await row.getByRole('button',{name:'保存报价',exact:true}).click();
 assert.equal(await row.locator('.quote-entry').count(),0);assert.equal(await row.locator('.saved-unit-quote').count(),1);
 await row.getByRole('button',{name:'添加单位报价',exact:true}).click();assert.equal(await row.locator('[name=quoteUnit] option[value="箱"]').count(),0);
 await row.getByLabel('报价验收牛骨报价单位').selectOption('KG');await row.getByLabel('报价验收牛骨单价',{exact:true}).fill('120');await row.getByRole('button',{name:'保存报价',exact:true}).click();
 assert.equal(await row.locator('.saved-unit-quote').count(),2);assert.equal(await row.locator('input').count(),0);
 await row.getByRole('button',{name:'编辑报价验收牛骨箱报价',exact:true}).click();await row.getByLabel('报价验收牛骨单价',{exact:true}).fill('1600');await row.getByRole('button',{name:'保存报价',exact:true}).click();
 assert.ok((await row.locator('.saved-unit-quotes').innerText()).includes('1,600'));
 await page.screenshot({path:'tmp/release-review/quotes-desktop.png'});
 await page.getByRole('button',{name:'门店与账号',exact:true}).click();await page.screenshot({path:'tmp/release-review/stores-desktop.png'});
 const heights=await page.locator('.store-card').evaluateAll(nodes=>nodes.map(n=>Math.round(n.getBoundingClientRect().height)));console.log('Store card heights',heights);
 for(const key of ['overview','orders','delivery','costs','documents']){
  await page.goto('http://127.0.0.1:4173/?page='+key);await page.locator('.page-content').waitFor();
  await page.screenshot({path:`tmp/release-review/${key}-desktop.png`});
 }
 for(const width of [1024,390]){
  await page.setViewportSize({width,height:900});await page.goto('http://127.0.0.1:4173/?page=stores');await page.locator('.store-card').first().waitFor();
  await page.screenshot({path:`tmp/release-review/stores-${width}.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 assert.deepEqual(errors,[]);console.log('Add/select/save/edit unit quote workflow and responsive pages PASS.');
}catch(e){await page.screenshot({path:'tmp/release-review/ui-failure.png'});console.log('Browser errors:',errors);console.log('Toast:',await page.locator('.toast').allTextContents());console.log('Rows:',(await page.locator('.catalog-table').innerText()).slice(-1200));throw e;}finally{await browser.close();}
