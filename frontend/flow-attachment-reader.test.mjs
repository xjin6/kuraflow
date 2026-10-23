import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {zipSync,strToU8} from 'fflate';
import {readWorkbook,readDelimited} from '../flow-attachment-reader.js';
import {formatFlowText} from '../flow-ui.js';
const workbook=(sheet,shared='')=>zipSync({
 'xl/workbook.xml':strToU8('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="报价" r:id="rId1"/></sheets></workbook>'),
 'xl/_rels/workbook.xml.rels':strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
 'xl/worksheets/sheet1.xml':strToU8(sheet),...(shared?{'xl/sharedStrings.xml':strToU8(shared)}:{}),
});

test('CSV keeps quoted cells, embedded newlines and zero; rejects incomplete quoting',()=>{
 const data=readDelimited('商品,价格,备注\r\n"牛肉,冷冻",0,"第一行\n第二行"\r\n');
 assert.match(data,/行 2: 牛肉,冷冻 \| 0 \| 第一行\n第二行/);
 assert.throws(()=>readDelimited('name,"unfinished'),/引号未闭合/);
});

test('xlsx uses saved values, retains source row numbers, and never evaluates formulas or XML entities',()=>{
 const dom=new JSDOM('');globalThis.DOMParser=dom.window.DOMParser;
 try{
  const parts=readWorkbook(workbook('<worksheet><sheetData><row r="4"><c r="A4" t="s"><v>0</v></c><c r="B4"><v>0</v></c><c r="C4"><f>HYPERLINK("https://bad")</f></c></row></sheetData></worksheet>','<sst><si><t>测试商品</t></si></sst>'));
  assert.equal(parts[0].label,'工作表 1 · 报价');assert.match(parts[0].text,/行 4: A4=测试商品 \| B4=0 \| C4=\[公式无已保存结果\]/);assert.doesNotMatch(parts[0].text,/https/);
  assert.throws(()=>readWorkbook(workbook('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><worksheet/>')),/外部实体/);
  assert.throws(()=>readWorkbook(zipSync({'xl/sharedStrings.xml':new Uint8Array(2000001)})),/解压后过大/);
 }finally{dom.window.close();delete globalThis.DOMParser;}
});

test('attachment recognition tables render readable cells while model HTML remains escaped',()=>{
 const output=formatFlowText('| 商品 | 单价 |\n|---|---:|\n| <img src=x onerror=bad()> | 1200 |');
 assert.match(output,/<table>/);assert.match(output,/&lt;img/);assert.doesNotMatch(output,/<img/);assert.match(output,/<td>1200<\/td>/);
});
