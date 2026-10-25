import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFlowArchive,flowActorKey,sanitizeFlowSVG,safeFlowImage} from '../../scripts/flow/flow-archive.mjs';
const actor={role:'admin',tenantId:'kitchen-a',userId:'owner-a'};
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" fill="#fff"/><text x="40" y="60" font-size="24">库存概览</text></svg>';
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-archive-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,store:createFlowArchive({privateDir:dir})};}
test('local archive retains pending confirmation cards across restart without executable commands',async t=>{
 const {dir,store}=await fixture(t),requestId=crypto.randomUUID();
 const proposal={id:crypto.randomUUID(),requestId,operation:'flow_create_task',label:'新增待办',recordLabel:'事项',status:'pending',details:[{label:'截止日期',value:'2026-12-01'}],impact:'确认后保存',command_json:'forged-command'};
 const saved=await store.save(actor,{messages:[{role:'user',text:'新增待办',requestId},{role:'assistant',text:'请确认',proposals:[proposal]}]});
 const restored=await createFlowArchive({privateDir:dir}).get(actor,saved.id);
 assert.equal(restored.messages[1].proposals[0].id,proposal.id);assert.equal(restored.messages[1].proposals[0].status,'pending');assert.doesNotMatch(JSON.stringify(restored),/forged-command/);
});
test('local archive preserves request IDs and write receipts for a later reconnect',async t=>{
 const {dir,store}=await fixture(t),requestId=crypto.randomUUID();
 const mutation={id:`flow:${requestId}:flow_create_task:${'c'.repeat(64)}`,operation:'flow_create_task',label:'新增待办',recordId:'todo-test',recordLabel:'测试待办',href:'/?page=tasks&tab=manual',revision:1,status:'saved'};
 const saved=await store.save(actor,{messages:[{role:'user',text:'新增待办',requestId},{role:'assistant',text:'已保存',mutations:[mutation]}]});
 const restored=await createFlowArchive({privateDir:dir}).get(actor,saved.id);
 assert.equal(restored.messages[0].requestId,requestId);assert.equal(restored.messages[1].mutations[0].recordId,'todo-test');
});
test('conversation history survives restart and isolates tenant and individual management user',async t=>{
 const {dir,store}=await fixture(t),row=await store.save(actor,{messages:[{role:'user',text:'查看库存'},{role:'assistant',text:'已查询',steps:[{id:'prepare',label:'准备业务数据',status:'done'},{id:'private-reasoning',label:'not a public step',status:'done'}],sources:[{title:'商品',url:'/?page=catalogue'},{title:'恶意',url:'javascript:alert(1)'}]}],draft:'下一个问题'});
 const reloaded=createFlowArchive({privateDir:dir});assert.equal((await reloaded.get(actor,row.id)).draft,'下一个问题');assert.equal((await reloaded.list(actor)).conversations[0].title,'查看库存');
 assert.deepEqual(row.messages[1].sources,[{label:'商品',href:'/?page=catalogue'}]);assert.deepEqual(row.messages[1].steps,[{id:'prepare',label:'准备业务数据',status:'done'}]);
 for(const other of [{...actor,tenantId:'kitchen-b'},{...actor,userId:'member-b'}]){assert.equal((await store.list(other)).conversations.length,0);await assert.rejects(store.get(other,row.id),{status:404});}
 for(const bad of [null,{...actor,role:'store'},{...actor,role:'platform'},{...actor,storeId:'store-a'}])assert.throws(()=>flowActorKey(bad),{status:403});
 await assert.rejects(store.get(actor,'../../secrets'),{status:404});
 const file=path.join(dir,'flow-conversations',flowActorKey(actor),row.id+'.json');assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('soft deletion hides history, prevents stale resurrection, and restores all content',async t=>{
 const {store}=await fixture(t),row=await store.save(actor,{messages:[{role:'user',text:'保留内容'}]});
 await store.remove(actor,row.id);await store.remove(actor,row.id);assert.equal((await store.list(actor)).conversations.length,0);
 await assert.rejects(store.get(actor,row.id),{status:410});await assert.rejects(store.save(actor,{...row,draft:'stale'}),{status:410});
 const restored=await store.restore(actor,row.id);assert.equal(restored.messages[0].text,'保留内容');assert.ok(restored.version>row.version);assert.equal((await store.list(actor)).conversations.length,1);
});
test('concurrent saves use optimistic versions and do not silently overwrite a newer window',async t=>{
 const {store}=await fixture(t),row=await store.save(actor,{messages:[],draft:'初始'});
 const results=await Promise.allSettled(['one','two'].map(draft=>store.save(actor,{...row,draft})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
 assert.equal((await store.get(actor,row.id)).draft,'one');
});
test('visuals are private, inert SVG and can be saved with conversation history',async t=>{
 const {store}=await fixture(t),image=await store.createArtifact(actor,{svg,title:'库存概览'});
 assert.match(await store.getArtifact(actor,image.id),/库存概览/);
 await assert.rejects(store.getArtifact({...actor,userId:'another'},image.id),{status:404});
 const row=await store.save(actor,{messages:[{role:'assistant',text:'图片如下',images:[image,{url:'https://evil.test/pixel.png'},{url:'data:image/svg+xml,evil'}]}]});
 assert.equal(row.messages[0].images.length,1);assert.equal(row.messages[0].images[0].url,image.url);
 assert.equal(safeFlowImage('javascript:alert(1)'),null);assert.equal(safeFlowImage('/api/flow/artifacts/../../secret'),null);
});
test('SVG validation rejects active content, external resources and expansion payloads',()=>{
 for(const unsafe of [
  svg.replace('<rect','<script>alert(1)</script><rect'),svg.replace('<rect','<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject><rect'),
  svg.replace('fill="#fff"','fill="url(https://evil.test/x)"'),svg.replace('<rect','<image href="https://evil.test/x"/><rect'),svg.replace('<rect','<rect onload="alert(1)"'),
  '<!DOCTYPE svg [<!ENTITY a "xxxxxxxx">]>'+svg,svg.replace('800 500','99999 500'),svg.replace('<rect','<style>body{background:url(https://evil.test)}</style><rect'),
  svg.replace('<rect','<use href="#x"/><rect'),svg.replace('font-size="24"','font-size="24" style="font-size:24px"')
 ])assert.throws(()=>sanitizeFlowSVG(unsafe),{status:400});
 assert.match(sanitizeFlowSVG(svg),/width="800"/);
});
