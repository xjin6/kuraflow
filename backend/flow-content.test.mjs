import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeFlowSVG,cleanFlowMessages,safeFlowImage} from './flow-content.js';
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" fill="#fff"/><text x="40" y="60" font-size="24">库存 &amp; 配货</text></svg>';
test('safe SVG is reconstructed, dimensions normalized and entities remain text',()=>{
  const result=sanitizeFlowSVG(svg);assert.match(result,/width="800"/);assert.match(result,/height="500"/);assert.match(result,/库存 &amp; 配货/);
  const escaped=sanitizeFlowSVG(svg.replace('库存 &amp; 配货','<![CDATA[<script>alert(1)</script>]]>'));assert.match(escaped,/&lt;script&gt;/);assert.ok(!escaped.includes('<script>'));
  const gradient=svg.replace('<rect','<defs><linearGradient id="a"><stop offset="0" stop-color="#abc"/><stop offset="1" stop-color="#def"/></linearGradient></defs><rect').replace('fill="#fff"','fill="url(#a)"');assert.match(sanitizeFlowSVG(gradient),/linearGradient id="a"/);
});
test('SVG rejects active content, foreign namespaces, external resources and entity expansion',()=>{
  for(const unsafe of [
    svg.replace('<rect','<script>alert(1)</script><rect'),svg.replace('<rect','<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject><rect'),
    svg.replace('fill="#fff"','fill="url(https://evil.test/x)"'),svg.replace('<rect','<image href="https://evil.test/x"/><rect'),svg.replace('<rect','<rect onload="alert(1)"'),
    '<!DOCTYPE svg [<!ENTITY a "xxxxxxxx">]>'+svg,svg.replace('800 500','99999 500'),svg.replace('<rect','<style>body{background:url(https://evil.test)}</style><rect'),
    svg.replace('<rect','<use href="#x"/><rect'),svg.replace('font-size="24"','font-size="24" style="font-size:24px"'),svg.replace('<rect','<svg xmlns="http://www.w3.org/2000/svg"></svg><rect'),
    svg.replace('<rect','<g xmlns="https://evil.test"/><rect'),svg.replace('<rect','<a:rect xmlns:a="http://www.w3.org/2000/svg"/><rect'),
    svg.replace('<rect','<rect id="same"/><rect id="same"/><rect'),svg.replace('fill="#fff"','fill="url(&#104;ttps://evil.test/x)"'),
    '<?xml version="1.0"?>'+svg,svg.replace('库存 &amp; 配货','&external;'),svg+'<svg xmlns="http://www.w3.org/2000/svg"/>',svg.replace('</svg>',''),
    svg.replace('<rect','<rect href="javascript:alert(1)"/><rect'),svg.replace('font-size="24"','font-size="url(https://evil.test/x)"')
  ])assert.throws(()=>sanitizeFlowSVG(unsafe),{status:400});
});
test('SVG size, depth, element and attribute limits are enforced',()=>{
  assert.throws(()=>sanitizeFlowSVG(svg.replace('<rect','<g>'.repeat(125)+'</g>'.repeat(125)+'<rect')),{status:400});
  assert.throws(()=>sanitizeFlowSVG(svg.replace('<rect','<circle/>'.repeat(1201)+'<rect')),{status:400});
  assert.throws(()=>sanitizeFlowSVG(svg.replace('库存 &amp; 配货','x'.repeat(60000))),{status:400});
  assert.throws(()=>sanitizeFlowSVG(svg.replace('<rect','<path d="'+'M '.repeat(6000)+'"/><rect')),{status:400});
});
test('message metadata keeps only safe business paths, public step kinds and image URLs',()=>{
  const image='/api/flow/artifacts/'+crypto.randomUUID();
  const rows=cleanFlowMessages([{role:'assistant',text:'result',steps:[{id:'tool-1',label:'查询订单',status:'done'},{id:'analysis',label:'hidden',status:'done'}],images:[{url:image,title:'业务图'},{url:'data:image/svg+xml,evil'}],sources:[{url:'/?page=orders&order=test',title:'货单'},{url:'/?page=platform',title:'bad'},{url:'/?page=orders&token=secret',title:'bad'},{url:'https://evil.test',title:'bad'}]}]);
  assert.equal(rows[0].steps.length,1);assert.equal(rows[0].sources.length,1);assert.equal(rows[0].images.length,1);
  assert.equal(safeFlowImage('/public/product-images/12.jpg'),'/public/product-images/12.jpg');assert.equal(safeFlowImage('/api/flow/artifacts/../../private'),null);assert.equal(safeFlowImage('//evil.test/a'),null);
  assert.throws(()=>cleanFlowMessages(Array.from({length:121},()=>({role:'user',text:'x'}))),{status:400});
  assert.throws(()=>cleanFlowMessages([{role:'system',text:'bad'}]),{status:400});
});
