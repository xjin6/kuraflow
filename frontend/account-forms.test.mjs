import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM, VirtualConsole} from 'jsdom';
import {createAccountsUI} from '../accounts-ui.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundles = await Promise.all(['platform-app.js', 'cloud-bootstrap.js'].map(async entry => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    // Login tests stay unauthenticated. Leave workbench loading outside this unit.
    external: entry === 'cloud-bootstrap.js' ? ['./app.js', './platform-app.js'] : [],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}));

const kitchen = {
  id: 'tenant-test', name: '测试中央厨房', owner_name: '测试负责人',
  contact: 'owner@example.test', active: 1, seats: 0, plan: '标准版', expires_on: '',
};
const owner = {
  id: 'owner-test', name: '测试负责人', accountRole: 'owner',
  role: 'admin', status: 'active', contact: 'owner@example.test',
};
const member = (index, status = 'active') => ({
  id: `member-${index}`, name: `测试管理员 ${index}`, username: `test_admin_${index}`,
  accountRole: 'member', role: 'admin', status, contact: '',
});
const team = (accounts = [owner], tenant = kitchen, storeId = null) => ({
  accounts, organization: {id: tenant.id, name: tenant.name},
  stores: [{id: 'store-test', name: '测试门店'}], storeId,
  canManage: true, needsSetup: false, limit: 3,
});
const jsonResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => data,
});

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await nextTurn();
  }
  assert.fail(message);
}

async function fixture(t, {entry = 0, url = 'https://accounts.example.test/?login=platform', route}) {
  const errors = [], calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="overlay-root"></div><div id="toast-container"></div>', {
    url, runScripts: 'outside-only', virtualConsole,
  });
  t.after(() => {
    dom.window.close();
    assert.deepEqual(errors, [], 'the DOM must not raise an exception or attempt native navigation');
  });
  const {window} = dom;
  window.__KURAFLOW_ACCOUNT_PRINCIPAL__ = {role: 'platform', displayName: '测试平台负责人'};
  window.fetch = async (path, options = {}) => {
    const call = {
      path: String(path), method: options.method || 'GET',
      body: options.body === undefined ? undefined : JSON.parse(options.body), options,
    };
    calls.push(call);
    return route(call);
  };
  await window.eval(`(async () => {\n${bundles[entry]}\n})()`);
  return {window, document: window.document, calls};
}

function click(document, selector) {
  const element = document.querySelector(selector);
  assert.ok(element, `missing clickable element: ${selector}`);
  element.click();
  return element;
}

function fill(form, values) {
  for (const [name, value] of Object.entries(values)) {
    const input = form.elements.namedItem(name);
    assert.ok(input, `missing form field: ${name}`);
    input.value = value;
  }
}

function submit(window, form) {
  const event = new window.Event('submit', {bubbles: true, cancelable: true});
  const allowed = form.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'preventDefault must run synchronously before the first request');
  assert.equal(allowed, false, 'the browser must not perform native form navigation');
}

function assertCustomerLoginLinks(document, portal) {
  assert.equal(document.querySelector('.accounts-login-links'), null,
    'customer login pages must not offer any cross-portal navigation');
  assert.equal(document.querySelector('a[href*="login="]'), null);
  assert.equal(document.querySelector('h1').textContent, portal === 'kitchen' ? '管理端登录' : '门店端登录');
  assert.equal(document.title, `${portal === 'kitchen' ? '管理端登录' : '门店端登录'} | 倉流 KURAFLOW`);
  assert.doesNotMatch(document.querySelector('.accounts-login').textContent, /平台|厨房端/);
}

function clobberFormId(window, form) {
  const legacy = window.document.createElement('input');
  legacy.type = 'hidden';
  legacy.name = 'id';
  legacy.value = '';
  form.append(legacy);
  // Browsers expose named controls on HTMLFormElement before its inherited id.
  // jsdom 26 omits that legacy behavior, so install its observable result here.
  Object.defineProperty(form, 'id', {configurable: true, value: legacy});
  assert.equal(form.id, legacy);
  assert.equal(form.getAttribute('id'), 'accounts-kitchen-form');
  assert.throws(() => form.id.startsWith('accounts-'), TypeError);
}

test('platform create intercepts a clobbered form ID and sends one JSON POST with the original fields', async t => {
  let releaseCreate;
  const createPending = new Promise(resolve => { releaseCreate = resolve; });
  const created = {...kitchen, id: 'tenant-created', name: '测试厨房 & 配送', owner_name: '测试负责人甲'};
  const {window, document, calls} = await fixture(t, {
    route: call => {
      if (call.path === '/api/platform/kitchens') return jsonResponse({kitchens: [created]});
      if (call.path === '/api/platform/create') return createPending;
      if (call.path === '/api/team/list?tenant=tenant-created') return jsonResponse(team([owner], created));
      throw new Error(`Unexpected request: ${call.path}`);
    },
  });
  await until(() => document.querySelector('[data-action="accounts-kitchen-new"]'), 'kitchen list did not load');
  click(document, '[data-action="accounts-kitchen-new"]');
  const form = document.getElementById('accounts-kitchen-form');
  assert.equal(form.method, 'post');
  assert.ok(form.elements.namedItem('tenantId'));
  assert.equal(form.elements.namedItem('id'), null, 'new forms must avoid a control named id');
  fill(form, {name: created.name, ownerName: created.owner_name, contact: 'owner+test@example.test'});
  const requestId = form.elements.namedItem('requestId').value;
  assert.match(requestId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  const originalUrl = window.location.href;
  clobberFormId(window, form);

  submit(window, form);
  assert.equal(form.querySelector('[type="submit"]').disabled, true);
  submit(window, form);
  const writes = calls.filter(call => call.path === '/api/platform/create');
  assert.equal(writes.length, 1, 'a second submit while pending must not create another customer');
  const [write] = writes;
  assert.equal(write.method, 'POST');
  assert.equal(write.options.credentials, 'same-origin');
  assert.equal(write.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(write.body, {
    tenantId: '', operation: 'create', requestId, name: created.name,
    ownerName: created.owner_name, contact: 'owner+test@example.test',
    plan: '标准版', expiresOn: '', id: '',
  });

  releaseCreate(jsonResponse({tenantId: created.id, account: owner, masterCode: 'TEST-ONLY-0000-0001'}, 201));
  await until(() => document.getElementById('account-master-code'), 'owner code handoff did not open');
  await until(() => document.querySelector('.accounts-seat'), 'created kitchen team did not load');
  assert.equal(document.getElementById('account-master-code').value, 'TEST-ONLY-0000-0001');
  assert.equal(document.querySelector('.account-handoff a').search, '?login=kitchen');
  assert.match(document.querySelector('.account-handoff').textContent, /管理端/);
  assert.deepEqual([...document.querySelectorAll('.topbar-right a')].map(a => a.textContent), ['管理端', '门店端']);
  assert.equal(document.querySelector('[data-action="platform-kitchens"]').classList.contains('active'), true);
  assert.equal(document.querySelector('.accounts-seat').textContent, '负责人独立 · 管理员 0 人');
  assert.equal(window.location.href, originalUrl, 'private values must not become URL query parameters');
});

test('failed kitchen creation preserves fields and request ID for a safe retry', async t => {
  let attempts = 0;
  const {window, document, calls} = await fixture(t, {
    route: call => {
      if (call.path === '/api/platform/kitchens') return jsonResponse({kitchens: [kitchen]});
      if (call.path === '/api/platform/create') {
        attempts++;
        return attempts === 1
          ? jsonResponse({error: '测试：请求未完成，请重试。'}, 503)
          : jsonResponse({tenantId: kitchen.id, account: owner, masterCode: 'TEST-ONLY-0000-0002'}, 201);
      }
      if (call.path === '/api/team/list?tenant=tenant-test') return jsonResponse(team());
      throw new Error(`Unexpected request: ${call.path}`);
    },
  });
  await until(() => document.querySelector('[data-action="accounts-kitchen-new"]'), 'kitchen list did not load');
  click(document, '[data-action="accounts-kitchen-new"]');
  const form = document.getElementById('accounts-kitchen-form');
  fill(form, {name: '待重试测试厨房', ownerName: '测试负责人乙', contact: 'retry@example.test'});
  const originalData = Object.fromEntries(new window.FormData(form));
  submit(window, form);
  await until(() => form.querySelector('.accounts-form-error').textContent, 'submission error was not displayed');
  assert.equal(form.querySelector('.accounts-form-error').textContent, '测试：请求未完成，请重试。');
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
  assert.deepEqual(Object.fromEntries(new window.FormData(form)), originalData);
  assert.equal(window.location.search, '?login=platform');

  submit(window, form);
  await until(() => document.getElementById('account-master-code'), 'retry did not complete');
  const writes = calls.filter(call => call.path === '/api/platform/create');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].body, writes[0].body, 'retry must reuse the idempotency request ID and draft');
});

for (const scenario of [
  {name: 'owner plus three enabled administrators', accounts: [owner, member(1), member(2), member(3)], used: 3},
  {name: 'disabled administrator frees a seat independently of the owner', accounts: [owner, member(1), member(2), member(3, 'disabled')], used: 2},
]) {
  test(`employee management from its kitchen: ${scenario.name}`, async t => {
    const {document, calls} = await fixture(t, {
      route: call => {
        if (call.path === '/api/platform/kitchens') return jsonResponse({kitchens: [kitchen]});
        if (call.path === '/api/team/list?tenant=tenant-test') return jsonResponse(team(scenario.accounts));
        throw new Error(`Unexpected request: ${call.path}`);
      },
    });
    await until(() => document.querySelector('[data-action="accounts-kitchen-new"]'), 'kitchen list did not load');
    click(document, '[data-action="accounts-kitchen-team"]');
    await until(() => document.querySelector('.accounts-seat'), 'employee management did not load from its sidebar entry');
    assert.equal(document.querySelector('h1').textContent, '员工管理');
    assert.equal(document.querySelector('[data-action="platform-kitchens"]').classList.contains('active'), true);
    assert.equal(document.getElementById('accounts-tenant').value, kitchen.id);
    assert.ok(calls.some(call => call.path === '/api/team/list?tenant=tenant-test'));
    assert.equal(document.querySelector('.accounts-seat').textContent, `负责人独立 · 管理员 ${scenario.used} 人`);
    assert.equal(document.querySelectorAll('tbody tr').length, 4, 'owner remains visible alongside three administrators');
    assert.match(document.querySelector('tbody tr').textContent, /负责人码登录/);
    assert.equal(document.querySelectorAll('[data-action="accounts-staff-edit"]').length, 3);
    assert.equal(document.querySelector('[data-action="accounts-staff-new"]').disabled, false);
  });
}

test('administrator creation and editing use accountId and keep the selected organization scope', async t => {
  const accounts = [owner];
  let selectedStore = null;
  const {window, document, calls} = await fixture(t, {
    route: call => {
      if (call.path === '/api/platform/kitchens') return jsonResponse({kitchens: [kitchen]});
      if (call.path.startsWith('/api/team/list?')) {
        selectedStore = new URL(call.path, window.location.origin).searchParams.get('store');
        return jsonResponse(team(accounts, kitchen, selectedStore));
      }
      if (call.path === '/api/team/create') {
        accounts.push({...member(1), username: call.body.username, name: call.body.name});
        return jsonResponse({account: accounts.at(-1)}, 201);
      }
      if (call.path === '/api/team/update') return jsonResponse({ok: true});
      throw new Error(`Unexpected request: ${call.path}`);
    },
  });
  await until(() => document.querySelector('[data-action="accounts-kitchen-team"]'), 'kitchen list did not load');
  click(document, '[data-action="accounts-kitchen-team"]');
  await until(() => document.getElementById('accounts-store'), 'team did not load');
  const storePicker = document.getElementById('accounts-store');
  storePicker.value = 'store-test';
  storePicker.dispatchEvent(new window.Event('change', {bubbles: true}));
  await until(() => selectedStore === 'store-test' && document.querySelector('[data-action="accounts-staff-new"]'), 'store scope did not load');
  click(document, '[data-action="accounts-staff-new"]');
  const create = document.getElementById('accounts-staff-form');
  assert.equal(create.elements.namedItem('id'), null);
  assert.equal(create.elements.namedItem('accountId').value, '');
  fill(create, {username: 'synthetic_admin', password: 'Synthetic test password!', name: '测试管理员', contact: 'admin@example.test'});
  const requestId = create.elements.namedItem('requestId').value;
  submit(window, create);
  await until(() => document.querySelector('[data-action="accounts-staff-edit"]'), 'created administrator did not appear');
  const write = calls.find(call => call.path === '/api/team/create');
  assert.equal(write.method, 'POST');
  assert.deepEqual(write.body, {
    accountId: '', requestId, username: 'synthetic_admin', password: 'Synthetic test password!',
    name: '测试管理员', contact: 'admin@example.test', action: 'edit', tenantId: kitchen.id, storeId: 'store-test',
  });

  click(document, '[data-action="accounts-staff-edit"]');
  const edit = document.getElementById('accounts-staff-form');
  assert.equal(edit.elements.namedItem('accountId').value, 'member-1');
  assert.equal(edit.elements.namedItem('password').required, false);
  assert.equal(edit.elements.namedItem('password').value, '', 'existing password is never rendered back into the form');
  fill(edit, {username: 'renamed_admin'});
  submit(window, edit);
  await until(() => calls.some(call => call.path === '/api/team/update'), 'administrator edit did not submit');
  const update = calls.find(call => call.path === '/api/team/update');
  assert.equal(update.method, 'POST');
  assert.equal(update.body.accountId, 'member-1');
  assert.equal(update.body.username, 'renamed_admin');
  assert.equal(update.body.password, '');
  assert.equal(update.body.tenantId, kitchen.id);
  assert.equal(update.body.storeId, 'store-test');
  await until(() => document.getElementById('toast-container').textContent.includes('管理员已更新。')
    && document.querySelector('.accounts-seat'), 'administrator edit did not finish refreshing the team');
});

test('platform login exposes only a complex key field and posts it to the platform endpoint', async t => {
  const {window, document, calls} = await fixture(t, {
    entry: 1,
    route: call => {
      if (call.path === '/api/accounts/session') return jsonResponse({authenticated: false});
      if (call.path === '/api/accounts/platform-login') return jsonResponse({error: '测试密钥未通过'}, 401);
      throw new Error(`Unexpected request: ${call.path}`);
    },
  });
  assert.equal(document.querySelector('h1').textContent, '平台登录');
  assert.equal(document.querySelector('[role="tablist"]'), null);
  assert.deepEqual([...document.querySelectorAll('.accounts-login-links a')].map(a => a.search),
    ['?login=kitchen', '?login=store']);
  assert.deepEqual([...document.querySelectorAll('.accounts-login-links a')].map(a => a.textContent),
    ['管理端', '门店端']);
  const form = document.getElementById('account-login');
  assert.equal(form.method, 'post');
  assert.deepEqual([...form.querySelectorAll('input')].map(input => input.name), ['key']);
  assert.equal(form.elements.namedItem('key').type, 'password');
  const key = 'Synthetic-platform-key-!8&Qx_ThisIsNotARealCredential';
  fill(form, {key});
  submit(window, form);
  await until(() => document.querySelector('.cloud-login-error').textContent, 'login failure did not render');
  const write = calls.find(call => call.path === '/api/accounts/platform-login');
  assert.equal(write.method, 'POST');
  assert.deepEqual(write.body, {key, portal: 'platform'});
  assert.equal(document.getElementById('login-key').value, '', 'a rejected platform key is not rendered back into the document');
  assert.equal(window.location.search, '?login=platform');
});

for (const portal of ['kitchen', 'store']) {
  test(`${portal} login switches between owner code and administrator credentials with separate endpoints`, async t => {
    const {window, document, calls} = await fixture(t, {
      entry: 1, url: `https://accounts.example.test/?login=${portal}`,
      route: call => {
        if (call.path === '/api/accounts/session') return jsonResponse({authenticated: false});
        if (['/api/accounts/master-login', '/api/accounts/login'].includes(call.path)) return jsonResponse({error: '测试登录未通过'}, 401);
        throw new Error(`Unexpected request: ${call.path}`);
      },
    });
    assert.equal(document.querySelectorAll('[role="tab"]').length, 2);
    assert.equal(document.querySelector('[data-login-tab="owner"]').getAttribute('aria-selected'), 'true');
    assertCustomerLoginLinks(document, portal);
    let form = document.getElementById('account-login');
    assert.deepEqual([...form.querySelectorAll('input')].map(input => input.name), ['code']);
    fill(form, {code: 'TEST-ONLY-0000-0003'});
    submit(window, form);
    await until(() => document.querySelector('.cloud-login-error').textContent, 'owner login failure did not render');
    const ownerWrite = calls.find(call => call.path === '/api/accounts/master-login');
    assert.equal(ownerWrite.method, 'POST');
    assert.deepEqual(ownerWrite.body, {code: 'TEST-ONLY-0000-0003', portal});
    assert.equal(document.getElementById('login-code').value, 'TEST-ONLY-0000-0003');
    assertCustomerLoginLinks(document, portal);

    click(document, '[data-login-tab="admin"]');
    form = document.getElementById('account-login');
    assert.deepEqual([...form.querySelectorAll('input')].map(input => input.name), ['username', 'password']);
    assert.equal(document.querySelector('[data-login-tab="admin"]').getAttribute('aria-selected'), 'true');
    assert.equal(document.getElementById('login-password').type, 'password');
    assert.equal(window.location.search, `?login=${portal}&tab=admin`);
    assertCustomerLoginLinks(document, portal);
    fill(form, {username: 'synthetic_admin', password: 'Synthetic test password!'});
    submit(window, form);
    await until(() => document.querySelector('.cloud-login-error').textContent, 'administrator login failure did not render');
    const adminWrite = calls.find(call => call.path === '/api/accounts/login');
    assert.equal(adminWrite.method, 'POST');
    assert.deepEqual(adminWrite.body, {username: 'synthetic_admin', password: 'Synthetic test password!', portal});
    assert.equal(document.getElementById('login-username').value, 'synthetic_admin');
    assert.equal(document.getElementById('login-password').value, '', 'a rejected password must not be rendered back');
    assertCustomerLoginLinks(document, portal);

    click(document, '[data-login-tab="owner"]');
    assert.equal(document.getElementById('login-password'), null);
    assert.ok(document.getElementById('login-code'));
    assert.equal(window.location.search, `?login=${portal}&tab=owner`);
    assertCustomerLoginLinks(document, portal);
  });
}

test('administrator login deep link selects the credential tab on initial render', async t => {
  const {document} = await fixture(t, {
    entry: 1, url: 'https://accounts.example.test/?login=store&tab=admin',
    route: call => {
      assert.equal(call.path, '/api/accounts/session');
      return jsonResponse({authenticated: false});
    },
  });
  assert.equal(document.querySelector('[data-login-tab="admin"]').getAttribute('aria-selected'), 'true');
  assert.ok(document.getElementById('login-username'));
  assert.ok(document.getElementById('login-password'));
  assert.equal(document.getElementById('login-code'), null);
  assertCustomerLoginLinks(document, 'store');
});


test('customer owner-code dialogs have no cross-portal entry', async t => {
  const dom = new JSDOM('<div id="dialog"></div>');
  t.after(() => dom.window.close());
  const dialog = dom.window.document.getElementById('dialog');
  for (const role of ['admin', 'store']) {
    const accounts = createAccountsUI({
      principal: {role, tenantId: kitchen.id, storeId: role === 'store' ? 'store-test' : null},
      request: async (path, body) => {
        assert.equal(path, '/api/team/master-key');
        assert.equal(body.tenantId, kitchen.id);
        return {account: {name: '测试负责人', role}, masterCode: 'TEST-ONLY-0000-0004'};
      },
      escape: String, button: () => '', icon: () => '',
      modal: (_title, contents) => { dialog.innerHTML = contents; },
      closeOverlay: () => {}, toast: () => {}, render: () => {},
    });
    await accounts.handleAction('accounts-scope-key', {dataset: {}});
    assert.ok(dialog.querySelector('#account-master-code'));
    assert.equal(dialog.querySelector('a'), null, `${role} owner dialog must not expose another portal`);
    assert.match(dialog.textContent, role === 'store' ? /门店端/ : /管理端/);
  }
});
