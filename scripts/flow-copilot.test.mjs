import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFlowCopilot, safeFlowError } from './flow-copilot.mjs';

const definition = { name: 'flow_search', description: '只读查询', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flow-copilot-test-'));
  let clientOptions;
  const configs = [], sessions = [], deleted = [], flow = { steps: [], canceled: [] };
  const client = {
    start: async () => {}, stop: async () => {},
    getAuthStatus: async () => ({ isAuthenticated: true, login: 'tester', token: 'secret-must-not-return', statusMessage: 'secret-must-not-return' }),
    listModels: async () => { throw new Error('Do not use the lifetime-cached SDK model list'); },
    rpc: {models:{list:async()=>({models:[{ id: 'gpt-4.1', name: 'GPT-4.1' }, { id: 'blocked', policy: { state: 'disabled' } }]})}},
    deleteSession: async id => { deleted.push(id); },
    createSession: async config => {
      configs.push(config);
      let listener;
      const session = {
        sessionId: `test-${sessions.length}`, aborted: 0, disconnected: false,
        on(handler) { listener = handler; return () => { listener = undefined; }; },
        emit: event => listener?.(event),
        abort: async () => { session.aborted++; },
        disconnect: async () => { session.disconnected = true; },
        rpc: { accounts: { login: {
          begin: async () => ({ flowId: 'sdk-secret-flow', step: { kind: 'open-url', url: 'https://github.com/login/device?user_code=ABCD-EFGH' } }),
          advance: async () => flow.steps.shift() || { kind: 'awaiting' },
          cancel: async ({ flowId }) => { flow.canceled.push(flowId); },
        } } },
        sendAndWait: async () => {
          session.emit({ type: 'assistant.message_delta', data: { deltaContent: '已查询。' } });
          return { data: { content: '已查询。' } };
        },
      };
      sessions.push(session);
      if (overrides.setupSession) await overrides.setupSession(session, config);
      return session;
    },
    ...overrides.client,
  };
  const service = createFlowCopilot({ privateDir: directory, now: overrides.now, gitHubToken: overrides.gitHubToken, clientFactory: options => { clientOptions = options; return client; } });
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, client, configs, sessions, flow, deleted, directory, options: () => clientOptions };
}

test('status excludes raw auth data and disabled models, isolates runtime and environment', async t => {
  const h = await setup(t);
  const status = await h.service.status();
  assert.equal(status.connected, true);
  assert.equal(status.login, 'tester');
  assert.deepEqual(status.models, [{ id: 'gpt-4.1', name: 'GPT-4.1' }]);
  assert.doesNotMatch(JSON.stringify(status), /secret-must-not-return|token|statusMessage/);
  const options = h.options();
  assert.equal(options.mode, 'empty');
  assert.equal(options.enableRemoteSessions, false);
  assert.equal(options.useLoggedInUser, false);
  assert.ok(options.baseDirectory.startsWith(h.directory));
  assert.ok(options.workingDirectory.startsWith(h.directory));
  assert.equal(options.env.COPILOT_GITHUB_TELEMETRY_DISABLED, 'true');
  assert.equal(options.env.GITHUB_TOKEN, undefined);
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.ok(options.env.GH_CONFIG_DIR.startsWith(h.directory));
  assert.equal((await stat(h.directory)).mode & 0o777, 0o700);
});

test('tenant token is passed explicitly to isolated SDK and omitted from public status', async t => {
  const credential = 'fake-test-github-credential';
  const h = await setup(t, {gitHubToken: credential});
  const status = await h.service.status();
  assert.equal(h.options().gitHubToken, credential);
  assert.equal(h.options().useLoggedInUser, false);
  assert.doesNotMatch(JSON.stringify(status), /fake-test-github-credential/);
});

test('manual refresh bypasses SDK model cache and a removed selected model is refused on the next turn', async t => {
  let rows=[{id:'gpt-4.1',name:'GPT-4.1'}],requests=0,time=1_000_000;
  const h=await setup(t,{now:()=>time,client:{rpc:{models:{list:async()=>{requests++;return {models:rows};}}}}});
  const first=await h.service.status();
  assert.equal(requests,1);assert.equal(first.modelSource,'github-copilot');
  rows=[{id:'new-upstream-model',name:'New upstream model'}];time++;
  assert.equal((await h.service.status()).models[0].id,'gpt-4.1');assert.equal(requests,1);
  const refreshed=await h.service.status({refresh:true});
  assert.equal(requests,2);assert.equal(refreshed.models[0].id,'new-upstream-model');assert.notEqual(refreshed.fetchedAt,first.fetchedAt);
  await assert.rejects(h.service.chat({message:'查一下',model:'gpt-4.1',toolDefinitions:[definition],runTool:async()=>({})}),/没有可用的 Copilot 模型/);
  assert.equal(h.configs.length,0,'no session runs with a model absent from the refreshed catalogue');
});

test('failed catalogue refresh does not return old models as newly fetched',async t=>{
  let fail=false;
  const h=await setup(t,{client:{rpc:{models:{list:async()=>{if(fail)throw new Error('secret upstream failure');return {models:[{id:'gpt-4.1'}]};}}}}});
  assert.equal((await h.service.status()).models.length,1);fail=true;
  const state=await h.service.status({refresh:true});
  assert.deepEqual(state.models,[]);assert.equal(state.fetchedAt,undefined);assert.match(state.message,/无法刷新/);
  assert.doesNotMatch(JSON.stringify(state),/secret upstream failure/);
});

test('independent Copilot sessions permit only exact custom tools', async t => {
  let observation;
  const h = await setup(t, { setupSession(session, config) {
    session.sendAndWait = async () => {
      observation = await config.tools[0].handler({ query: '待配货' });
      session.emit({ type: 'assistant.reasoning_delta', data: { deltaContent: 'hidden chain' } });
      session.emit({ type: 'assistant.message_delta', data: { deltaContent: '有 2 单待配货。' } });
      return { data: { content: '有 2 单待配货。' } };
    };
  } });
  const events = [];
  const result = await h.service.chat({ message: '待配货有几单', model: 'gpt-4.1', toolDefinitions: [definition], runTool: async (name, args) => ({ data: { count: 2 }, sources: [] }), onEvent: event => events.push(event) });
  assert.equal(result.text, '有 2 单待配货。');
  const config = h.configs[0];
  assert.equal(config.provider, undefined);
  assert.deepEqual(config.availableTools, ['custom:flow_search']);
  assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*']);
  assert.equal(config.enableConfigDiscovery, false);
  assert.equal(config.skipCustomInstructions, true);
  assert.equal(config.memory.enabled, false);
  assert.equal(config.largeToolOutput.enabled, false);
  assert.equal(config.onPermissionRequest({ kind: 'custom-tool', toolName: 'flow_search' }).kind, 'approve-once');
  for (const request of [{ kind: 'shell' }, { kind: 'read' }, { kind: 'write' }, { kind: 'url' }, { kind: 'mcp', toolName: 'flow_search' }, { kind: 'custom-tool', toolName: 'bash' }, { kind: 'custom-tool', toolName: 'flow_search', managedApprovalRequired: true }]) {
    assert.equal(config.onPermissionRequest(request).kind, 'reject');
  }
  assert.equal(observation.resultType, 'success');
  assert.doesNotMatch(JSON.stringify(events), /hidden chain|reasoning/);
  assert.equal(h.sessions[0].disconnected, true);
  assert.deepEqual(h.deleted, ['test-0']);
});

test('unauthenticated direct Copilot fails without creating an answer or session', async t => {
  const h = await setup(t, { client: { getAuthStatus: async () => ({ isAuthenticated: false }) } });
  const events = [];
  await assert.rejects(h.service.chat({ message: '经营情况', toolDefinitions: [definition], runTool: async () => ({}), onEvent: e => events.push(e) }), /请先连接 GitHub Copilot/);
  assert.equal(h.configs.length, 0);
  assert.deepEqual(events, []);
});

test('alternate providers cannot bypass independent GitHub authentication',async t=>{
  const provider={type:'openai',baseUrl:'https://api.example.test/v1'};
  assert.throws(()=>createFlowCopilot({privateDir:os.tmpdir(),provider}),/independent GitHub Copilot/);
  const h=await setup(t,{client:{getAuthStatus:async()=>({isAuthenticated:false})}});
  await assert.rejects(h.service.chat({message:'test',model:'external-model',provider,toolDefinitions:[definition],runTool:async()=>({})}));
  assert.equal(h.configs.length,0);
});

test('auth offers official URL/code and opaque ID, polls completion without exposing SDK flow or token', async t => {
  const h = await setup(t);
  const auth = await h.service.startAuth();
  assert.equal(auth.connected, false);
  assert.equal(auth.pending, true);
  assert.equal(auth.userCode, 'ABCD-EFGH');
  assert.equal(auth.verificationUri, 'https://github.com/login/device?user_code=ABCD-EFGH');
  assert.notEqual(auth.authId, 'sdk-secret-flow');
  h.flow.steps.push({ kind: 'completed', result: { status: 'completed', login: 'tester', token: 'hidden-token' } });
  assert.equal((await h.service.pollAuth(auth.authId)).pending, true);
  await tick();
  const result = await h.service.pollAuth(auth.authId);
  assert.equal(result.connected, true);
  assert.doesNotMatch(JSON.stringify(result), /hidden-token|sdk-secret-flow/);
});

test('auth rejects unexpected destination and never grants plaintext credential storage', async t => {
  const h = await setup(t);
  const auth = await h.service.startAuth();
  h.flow.steps.push({ kind: 'completed', result: { status: 'needs-plaintext-consent' } });
  await h.service.pollAuth(auth.authId); await tick();
  const result = await h.service.pollAuth(auth.authId);
  assert.equal(result.connected, false);
  assert.match(result.error, /钥匙串/);
  assert.deepEqual(h.flow.steps, []);
  h.sessions[0].rpc.accounts.login.begin = async () => ({ flowId: 'bad-flow', step: { kind: 'open-url', url: 'https://untrusted.example/login/oauth' } });
  await assert.rejects(h.service.startAuth(), /无法开始 GitHub 授权/);
  assert.ok(h.flow.canceled.includes('bad-flow'));
});

test('aborting a query aborts model, keeps partial output, disconnects and deletes session', async t => {
  const controller = new AbortController();
  const h = await setup(t, { setupSession(session) {
    session.sendAndWait = () => new Promise((resolve, reject) => {
      session.emit({ type: 'assistant.message_delta', data: { deltaContent: '正在' } });
      session.abort = async () => { session.aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      queueMicrotask(() => controller.abort());
    });
  } });
  const events = [];
  await assert.rejects(h.service.chat({ message: '查一下', toolDefinitions: [definition], runTool: async () => ({}), signal: controller.signal, onEvent: e => events.push(e) }), /已停止回答/);
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), '正在');
  assert.ok(h.sessions[0].aborted >= 1);
  assert.equal(h.sessions[0].disconnected, true);
  assert.deepEqual(h.deleted, ['test-0']);
});

test('raw SDK errors and provider secrets never reach chat clients', async t => {
  const h = await setup(t, { setupSession(session) { session.sendAndWait = async () => { throw new Error('Bearer secret-token /Users/person/private API_KEY=secret'); }; } });
  await assert.rejects(h.service.chat({ message: '查一下', toolDefinitions: [definition], runTool: async () => ({}) }), error => {
    assert.doesNotMatch(error.message, /secret-token|\/Users|API_KEY/);
    assert.equal(error.message, safeFlowError(new Error('arbitrary')));
    return true;
  });
});

test('query tool budget blocks thirteenth retrieval and selected unavailable model is not substituted', async t => {
  let runs = 0;
  const h = await setup(t, { setupSession(session, config) { session.sendAndWait = async () => { for (let i = 0; i < 13; i++) await config.tools[0].handler({ query: 'test' }); }; } });
  await assert.rejects(h.service.chat({ message: '查全部', toolDefinitions: [definition], runTool: async () => { runs++; return {}; } }), /工具调用上限/);
  assert.equal(runs, 12);
  await assert.rejects(h.service.chat({ message: '查一下', model: 'disabled-or-nonexistent', toolDefinitions: [definition], runTool: async () => ({}) }), /没有可用的 Copilot 模型/);
});

test('phased analysis never enters public deltas or the final answer', async t => {
  const h=await setup(t,{setupSession(session){session.sendAndWait=async()=>{
    session.emit({type:'assistant.message_start',data:{messageId:'a',phase:'analysis'}});
    session.emit({type:'assistant.message_delta',data:{messageId:'a',deltaContent:'private phase content'}});
    session.emit({type:'assistant.message',data:{messageId:'a',phase:'analysis',content:'private phase content'}});
    session.emit({type:'assistant.message_start',data:{messageId:'f',phase:'final'}});
    session.emit({type:'assistant.message_delta',data:{messageId:'f',deltaContent:'共有 5 家门店。'}});
    session.emit({type:'assistant.message',data:{messageId:'f',phase:'final',content:'共有 5 家门店。'}});
    return{data:{messageId:'f',phase:'final',content:'共有 5 家门店。'}};
  };}});
  const events=[];const result=await h.service.chat({message:'有几家门店',model:'gpt-4.1',toolDefinitions:[definition],runTool:async()=>({}),onEvent:event=>events.push(event)});
  assert.equal(result.text,'共有 5 家门店。');assert.doesNotMatch(JSON.stringify(events),/private phase content/);
  assert.deepEqual(events.at(-1),{type:'message',text:'共有 5 家门店。'});
});
