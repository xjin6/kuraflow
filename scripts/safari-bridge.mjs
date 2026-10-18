import { execFileSync } from 'node:child_process';

export const ACCOUNT = '416d8e8c519ddc0a60ead4fc98a2ae14';
export const DB = 'c7bea510-68e6-4cc3-a746-794987746d80';
export const MEDIA = 'e8d6be95cdaf4221a88b803ece150354';
export const ORIGIN = 'https://kuraflow-kitchen.xjin-general.workers.dev';
export const API = `/api/v4/accounts/${ACCOUNT}`;

export function safari(js) {
  return execFileSync('osascript', [], {input:'tell application "Safari" to do JavaScript ' + JSON.stringify(js) + ' in front document',encoding:'utf8', maxBuffer:4*1024*1024}).trim();
}
export function guardDashboard() {
  const url = safari('location.href');
  if (!url.startsWith(`https://dash.cloudflare.com/${ACCOUNT}/`)) throw new Error('Open the approved Kuraflow Cloudflare account in Safari before deploying.');
}
export function putPayload(value) {
  const text = JSON.stringify(value);
  safari('window.__kfPayloadText=""; "ready"');
  for (let start=0; start<text.length; start+=24000) {
    safari(`window.__kfPayloadText+=${JSON.stringify(text.slice(start,start+24000))}; "chunk received"`);
  }
  safari('window.__kfPayload=JSON.parse(window.__kfPayloadText); delete window.__kfPayloadText; "payload ready"');
}
export async function runPage(script) {
  safari(`window.__kfResult={pending:true}; (async()=>{${script}})().then(result=>window.__kfResult={result}).catch(e=>window.__kfResult={error:e.message}); "started"`);
  const start=Date.now();
  while (Date.now()-start<55000) {
    await new Promise(resolve=>setTimeout(resolve,400));
    const value=JSON.parse(safari('JSON.stringify(window.__kfResult)'));
    if(value.error) throw new Error(value.error);
    if(!value.pending) return value.result;
  }
  throw new Error('Safari request still running; inspect __kfResult before retrying.');
}
export async function apiRequest(path, method='GET', body) {
  guardDashboard();
  putPayload(body ?? null);
  return runPage(`
    const response=await fetch(${JSON.stringify(API+path)}, {method:${JSON.stringify(method)}, headers:{'Content-Type':'application/json'}, ${body===undefined?'':'body:JSON.stringify(window.__kfPayload),'}});
    const data=await response.json();
    if(!response.ok||data.success===false) throw new Error('Cloudflare '+response.status+': '+JSON.stringify(data.errors));
    return data.result;
  `);
}
