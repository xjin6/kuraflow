// Create/open the initial owner's one-time invitation. The user completes WebAuthn.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInvite } from '../backend/auth.js';
import { apiRequest, guardDashboard, DB, ORIGIN } from './safari-bridge.mjs';

guardDashboard();
const target=new URL('../private-deploy/owner-invite.json',import.meta.url);
const query=async(sql,params=[])=>apiRequest(`/d1/database/${DB}/query`,'POST',{sql,params});
const owners=await query("SELECT COUNT(*) AS n FROM users WHERE tenant_id=? AND role='admin'",['maido-kitchen']);
if(owners[0].results[0].n)throw new Error('An administrator is already registered; use normal login.');
let invite;
if(fs.existsSync(target)) {
  invite=JSON.parse(fs.readFileSync(target,'utf8'));
  if(Date.parse(invite.expiresAt)<=Date.now())throw new Error('Saved owner invitation has expired; explicitly replace before opening.');
} else {
  const db={prepare(sql){const statement=(params=[])=>({bind:(...values)=>statement(values),first:async()=>(await query(sql,params))[0].results[0]||null,run:async()=>(await query(sql,params))[0]});return statement();}};
  invite=await createInvite(db,{tenantId:'maido-kitchen',role:'admin',displayName:'倉流管理员',expiresInSeconds:14400});
  fs.writeFileSync(target,JSON.stringify(invite),{mode:0o600});
}
// Keep the Cloudflare dashboard tab available for subsequent read-only diagnostics.
execFileSync('osascript',['-e','tell application "Safari"\nset ownerTab to make new tab at end of tabs of front window with properties {URL:'+JSON.stringify(ORIGIN+'/#invite='+invite.token)+'}\nset current tab of front window to ownerTab\nactivate\nend tell']);
console.log('Owner enrollment opened in Safari; expires '+invite.expiresAt+'.');
