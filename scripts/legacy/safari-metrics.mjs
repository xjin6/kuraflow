// Read aggregate CPU/error metrics in the already-open approved dashboard tab.
import { execFileSync } from 'node:child_process';
import { ACCOUNT } from './safari-bridge.mjs';

function dashboard(js) {
  const apple=`tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with "https://dash.cloudflare.com/${ACCOUNT}/" then
          return do JavaScript ${JSON.stringify(js)} in t
        end if
      end repeat
    end repeat
    error "Approved Cloudflare dashboard tab is not open."
  end tell`;
  return execFileSync('osascript',['-e',apple],{encoding:'utf8'}).trim();
}
const end=new Date().toISOString(),start=new Date(Date.now()-3600000).toISOString();
const query=`query { viewer { accounts(filter: {accountTag: "${ACCOUNT}"}) { workersInvocationsAdaptive(limit: 20, filter: {datetime_geq: "${start}", datetime_leq: "${end}", scriptName: "kuraflow-kitchen"}) { dimensions { status } sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } } } } }`;
dashboard(`window.__kfMetrics={pending:true};fetch('/api/v4/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({query})})}).then(async r=>window.__kfMetrics={status:r.status,data:await r.json()}).catch(e=>window.__kfMetrics={error:e.message});'started'`);
for(let i=0;i<60;i++) {
  await new Promise(resolve=>setTimeout(resolve,500));
  const result=JSON.parse(dashboard('JSON.stringify(window.__kfMetrics)'));
  if(!result.pending){console.log(JSON.stringify(result,null,2));process.exit(result.error||result.data?.errors?1:0);}
}
throw new Error('Metrics request timed out.');
