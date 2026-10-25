import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM, VirtualConsole} from 'jsdom';

const localScript = await readFile(new URL('../../scripts/dev/local-preview-entry.js', import.meta.url), 'utf8');
const {outputFiles} = await build({
  entryPoints: [fileURLToPath(new URL('../../src/app/cloud-bootstrap.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', target: 'es2022',
  external: ['./app.js', './platform-app.js'], logLevel: 'silent',
});

async function fixture(t, {url, authenticated = false}) {
  const calls = [], errors = [], observers = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {url, runScripts:'outside-only', virtualConsole});
  const {window} = dom;
  Object.assign(window, {Headers, Request, Response});
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const nativeFetch = window.fetch = async (path, options = {}) => {
    calls.push({path:String(path), options});
    return new Response(JSON.stringify({authenticated, principal:{role:'admin'}}), {headers:{'Content-Type':'application/json'}});
  };
  t.after(() => {
    observers.forEach(observer => observer.disconnect());
    window.close();
    assert.deepEqual(errors, []);
  });
  window.eval(localScript);
  return {
    window, document:window.document, calls, nativeFetch,
    async render() {
      await window.eval(`(async () => {\n${outputFiles[0].text}\n})()`);
      await nextTurn();
    },
  };
}

for (const portal of ['kitchen', 'store']) {
  test(`${portal} local login review leaves the session untouched and preserves real tabs`, async t => {
    const {window, document, calls, render} = await fixture(t, {
      url:`http://localhost:8787/?login=${portal}&loginPreview=1`, authenticated:true,
    });
    document.cookie = 'preview_test=preserve';
    await render();
    assert.equal(calls.length, 0, 'login review must not log out or fetch private business state');
    assert.equal(document.cookie, 'preview_test=preserve');
    assert.equal(document.querySelector('.cloud-entry').dataset.portal, portal);
    assert.equal(document.getElementById('login-code').closest('.field').hidden, false);
    assert.equal(document.querySelector('.cloud-login-button').textContent, '登录');
    document.querySelector('[data-login-tab="admin"]').click();
    await nextTurn();
    assert.ok(document.getElementById('login-password'));
    assert.equal(document.querySelector('.account-login-tabs').hidden, false);
    assert.equal(new URLSearchParams(window.location.search).get('loginPreview'), '1');
    assert.equal(document.activeElement.dataset.loginTab, 'admin');
    document.querySelector('[data-login-tab="owner"]').click();
    await nextTurn();
    assert.ok(document.getElementById('login-code'));
    assert.equal(document.getElementById('login-password'), null);
    assert.equal(calls.length, 0);
  });
}

test('ordinary local login retains one-click entry and scoped requests', async t => {
  const {document, calls, render} = await fixture(t, {url:'http://localhost:8787/?login=store'});
  await render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/accounts/session');
  assert.equal(calls[0].options.headers.get('X-Kuraflow-Preview-Portal'), 'store');
  assert.equal(document.querySelector('.account-login-fields').hidden, true);
  assert.equal(document.querySelector('.account-login-tabs').hidden, true);
  assert.equal(document.querySelector('.cloud-login-button').textContent, '一键进入演示');
});

test('login review query has no effect on a public origin', async t => {
  const {window, document, nativeFetch, calls, render} = await fixture(t, {
    url:'https://accounts.example.test/?login=kitchen&loginPreview=1',
  });
  assert.equal(window.fetch, nativeFetch);
  assert.equal(window.__KURAFLOW_FLOW_ENABLED__, undefined);
  await render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/accounts/session');
  assert.equal(document.querySelector('.cloud-login-button').textContent, '登录');
  assert.equal(document.querySelector('.account-login-fields').hidden, false);
});
