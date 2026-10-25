import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setImmediate as nextTurn} from 'node:timers/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source=await readFile(new URL('../../src/app/app.js',import.meta.url),'utf8');
const refreshCode=source.slice(source.indexOf('if (isCloud) {\n  let expired'));
function fixture(t,refresh) {
  const dom=new JSDOM('<div id="app"><input id="business-draft" value="未提交资料"></div><div id="overlay-root"></div><textarea id="flow-message">正在输入下一条消息</textarea>',{pretendToBeVisual:true,url:'http://localhost:8787'});
  const {window}=dom,document=window.document,ui={page:'stores',orderId:null};let renders=0;
  vm.runInNewContext(refreshCode,{isCloud:true,window,document,ui,app:document.getElementById('app'),overlay:document.getElementById('overlay-root'),model:{pending:0,refresh,save(){}},
    syncNotificationBadge(){},syncClientIdentity(){},render(){renders++;},updatePacking(){renders++;},closeOverlay(){},hasLocalDraftEditor(){return false;},setInterval(){},setTimeout(callback){queueMicrotask(callback);},
  });
  t.after(()=>window.close());
  return {window,document,ui,notify:()=>window.dispatchEvent(new window.Event('kuraflow-flow-data-changed')),renders:()=>renders};
}
test('Flow writes arriving during an in-flight refresh schedule another refresh and preserve the chat draft',async t=>{
  let release,calls=0;
  const h=fixture(t,async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return true;});
  const input=h.document.getElementById('flow-message');input.focus();
  h.notify();h.notify();assert.equal(calls,1);
  release();await nextTurn();await nextTurn();
  assert.equal(calls,2);assert.equal(h.renders(),2);
  assert.equal(h.document.activeElement,input);assert.equal(input.value,'正在输入下一条消息');
});
test('Flow refresh does not redraw an active business editor and resumes after a blocking dialog closes',async t=>{
  let calls=0;const h=fixture(t,async()=>{calls++;return true;});
  const input=h.document.getElementById('business-draft');input.focus();h.notify();await nextTurn();
  assert.equal(calls,1);assert.equal(h.renders(),0);assert.equal(h.ui.cloudRefreshPending,true);assert.equal(input.value,'未提交资料');
  const overlay=h.document.getElementById('overlay-root');overlay.append(h.document.createElement('div'));h.notify();assert.equal(calls,1);
  overlay.replaceChildren();input.blur();await nextTurn();await nextTurn();
  assert.equal(calls,2);assert.ok(h.renders()>0);
});
