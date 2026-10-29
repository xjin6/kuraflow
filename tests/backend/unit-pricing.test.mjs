import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveUnitPrice} from '../../src/shared/unit-pricing.js';

const units=[{unit:'箱',perBase:1},{unit:'KG',perBase:15},{unit:'500g',perBase:30}];
const quote=(price,taxBasis='exclusive',taxRate=.08)=>({price,taxBasis,taxRate,kind:'manual',source:'saved'});
test('unit conversion is bidirectional, preserves tax basis and rounds only the target price',()=>{
  const q={KG:quote(123.45)},before=structuredClone(q);
  assert.equal(resolveUnitPrice(units,q,'箱').price,1851.75);
  assert.equal(resolveUnitPrice(units,q,'500g').price,61.73);
  assert.equal(resolveUnitPrice(units,{箱:quote(1000)},'KG').price,66.67);
  const derived=resolveUnitPrice(units,q,'箱');assert.equal(derived.taxBasis,'exclusive');assert.equal(derived.taxRate,.08);assert.equal(derived.derivedFrom.unit,'KG');
  assert.deepEqual(q,before);derived.price=1;assert.deepEqual(q,before);
});
test('explicit prices win and conflicting rates or tax bases leave missing units unpriced',()=>{
  assert.equal(resolveUnitPrice(units,{箱:quote(1000),KG:quote(100)},'箱').price,1000);
  assert.equal(resolveUnitPrice(units,{箱:quote(1000),KG:quote(100)},'500g').price,null);
  assert.equal(resolveUnitPrice(units,{箱:quote(1500),KG:quote(100,'inclusive')},'500g').price,null);
  assert.equal(resolveUnitPrice(units,{箱:quote(1500),KG:quote(100)},'500g').price,50);
});
test('missing conversion, absent prices, disabled source units and non-finite results never invent prices',()=>{
  assert.equal(resolveUnitPrice([{unit:'箱',perBase:1},{unit:'KG'}],{KG:quote(100)},'箱').price,null);
  assert.equal(resolveUnitPrice(units,{},'箱').price,null);
  assert.equal(resolveUnitPrice(units,{袋:quote(100)},'箱').price,null);
  assert.equal(resolveUnitPrice(units,{KG:quote(0)},'箱').price,null);
  assert.equal(resolveUnitPrice(units,{KG:quote(Number.MAX_SAFE_INTEGER/100)},'箱').price,null);
});
