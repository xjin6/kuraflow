import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KitchenModel, STORAGE_KEY } from '../data.js';
import { createCloudModel } from '../cloud-client.js';

const storage = () => {
  const records = new Map();
  return { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
};

test('locally entered manual tasks survive reload, completion and restore without changing orders', t => {
  const saved = storage(), oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: saved });
  t.after(() => oldStorage ? Object.defineProperty(globalThis, 'localStorage', oldStorage) : delete globalThis.localStorage);
  const model = new KitchenModel(), orders = structuredClone(model.state.orders);
  const task = model.addManualTask({ title: '联系供应商', note: '确认下一次到货', dueDate: '2026-10-25' });
  assert.equal(task.dueDate, '2026-10-25');
  const reloaded = new KitchenModel();
  assert.deepEqual(reloaded.state.manualTasks, [task]);
  assert.deepEqual(reloaded.state.orders, orders);
  reloaded.setManualTaskDone(task.id, true);
  assert.ok(new KitchenModel().state.manualTasks[0].completedAt);
  reloaded.setManualTaskDone(task.id, false);
  assert.equal(new KitchenModel().state.manualTasks[0].completedAt, null);
  assert.equal(new KitchenModel().state.manualTasks[0].dueDate, '2026-10-25');
  const originalTitle=reloaded.state.manualTasks[0].title;
  reloaded.setManualTaskDueDate(task.id, '2026-10-28');
  assert.equal(new KitchenModel().state.manualTasks[0].dueDate, '2026-10-28');
  assert.equal(reloaded.state.manualTasks[0].title, originalTitle);
  assert.equal(JSON.parse(saved.getItem(STORAGE_KEY)).manualTasks[0].source, 'manual');
  assert.throws(() => reloaded.addManualTask({ title: '伪造来源', source: 'system' }), /格式不正确/);
});

test('manual task deadlines are required real date-only values while old records remain unchanged', () => {
  const model = new KitchenModel(); model.storage = null;
  for (const dueDate of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-20T00:00:00Z', '2026-1-2', ' 2026-10-20 ', 20261020, {}]) {
    assert.throws(() => model.addManualTask({ title: '确认到货', dueDate }), /截止日期/);
  }
  assert.throws(() => model.addManualTask({ title: '未设期限' }), /截止日期/);
  assert.throws(() => model.addManualTask({ title: '空期限', dueDate: null }), /截止日期/);
  assert.equal(model.addManualTask({ title: '闰日', dueDate: '2028-02-29' }).dueDate, '2028-02-29');
  const old={id:'old', title:'旧待办', source:'manual', completedAt:null};model.state.manualTasks.push(old);
  model.setManualTaskDueDate('old','2026-10-30');assert.equal(old.dueDate,'2026-10-30');assert.equal(old.completedAt,null);
  assert.throws(()=>model.setManualTaskDueDate('old','2026-02-29'),/截止日期/);assert.equal(old.dueDate,'2026-10-30');
});

test('cloud manual task writes wait for the server and keep only business drafts in local storage', async t => {
  const saved = storage(), oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = new EventTarget(); window.localStorage = saved;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  t.after(() => oldWindow ? Object.defineProperty(globalThis, 'window', oldWindow) : delete globalThis.window);
  const initial = new KitchenModel(); initial.state.manualTasks = [];
  const task = { id: 'todo-server-id', title: '确认配送', note: '', dueDate: '2026-10-23', source: 'manual', completedAt: null, deletedAt: null, createdAt: '2026-10-20T01:00:00.000Z' };
  let respond, request;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    request = { path, body: JSON.parse(options.body) };
    return new Promise(resolve => { respond = result => resolve(new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })); });
  });
  const model = createCloudModel({ principal: { role: 'admin', tenantId: 'tenant-a', userId: 'person-a' }, state: initial.state, revision: 0 });
  const pending = model.addManualTask({ title: '确认配送', dueDate: '2026-10-23' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.path, '/api/commands');
  assert.equal(request.body.type, 'addManualTask');
  assert.deepEqual(request.body.args, [{ title: '确认配送', dueDate: '2026-10-23' }]);
  assert.deepEqual(model.state.manualTasks, []);
  respond({ result: task, state: { ...initial.state, manualTasks: [task] }, revision: 1 });
  assert.deepEqual(await pending, task);
  assert.deepEqual(model.state.manualTasks, [task]);
  assert.equal(model.revision, 1);
  assert.equal(JSON.parse(saved.getItem('kuraflow-draft:tenant-a:person-a')).manualTasks, undefined);
  const complete = model.setManualTaskDone(task.id, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.body.type, 'setManualTaskDone');
  assert.deepEqual(request.body.args, [task.id, true]);
  const completed = { ...task, completedAt: '2026-10-20T01:05:00.000Z' };
  respond({ result: completed, state: { ...initial.state, manualTasks: [completed] }, revision: 2 });
  await complete;
  assert.equal(model.state.manualTasks[0].completedAt, completed.completedAt);
  assert.equal(model.state.manualTasks[0].dueDate, '2026-10-23');
  const reschedule=model.setManualTaskDueDate(task.id,'2026-10-26');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(request.body.type,'setManualTaskDueDate');assert.deepEqual(request.body.args,[task.id,'2026-10-26']);
  const changed={...completed,dueDate:'2026-10-26'};respond({result:changed,state:{...initial.state,manualTasks:[changed]},revision:3});
  await reschedule;assert.equal(model.state.manualTasks[0].completedAt,completed.completedAt);assert.equal(model.state.manualTasks[0].dueDate,'2026-10-26');
});
