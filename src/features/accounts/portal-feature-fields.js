import {tx,ta,mp} from '../../i18n/index.js';
const names={admin:{flowEnabled:'flowEnabled',multilingualEnabled:'multilingualEnabled',notificationsEnabled:'adminNotificationsEnabled'},store:{flowEnabled:'storeFlowEnabled',multilingualEnabled:'storeMultilingualEnabled',notificationsEnabled:'storeNotificationsEnabled'}};
export function createPortalFeatureDraft(data={}) {
  return structuredClone(data.portals||{admin:{flowEnabled:data.flow?.enabled===true,multilingualEnabled:data.multilingual?.enabled===true,notificationsEnabled:true},store:{flowEnabled:false,multilingualEnabled:data.multilingual?.enabled===true,notificationsEnabled:true}});
}
/** Use inside the existing form; existing management Flow/language field names remain stable. */
export function renderPortalFeatureFields(data={}) {
  const draft=createPortalFeatureDraft(data),labels={flowEnabled:'Flow AI',multilingualEnabled:'多语言',notificationsEnabled:'通知'};
  return `<div class="portal-feature-matrix"><div class="portal-feature-matrix-heading"><span>${tx('功能')}</span><strong>${tx('管理端')}</strong><strong>${tx('门店端')}</strong></div>${Object.keys(labels).map(feature=>`<div class="portal-feature-matrix-row"><span>${feature==='flowEnabled'?'Flow AI':tx(labels[feature])}</span>${['admin','store'].map(role=>`<label class="accounts-feature-switch"><input type="checkbox" role="switch" name="${names[role][feature]}" ${ta('aria-label',role==='admin'?'管理端：{0}':'门店端：{0}',[mp(labels[feature])])} ${draft[role][feature]?'checked':''} disabled><span class="accounts-switch-track" aria-hidden="true"></span></label>`).join('')}</div>`).join('')}</div>`;
}
export function readPortalFeatureFields(form,fallback={}) {
  const draft=createPortalFeatureDraft(fallback);
  for(const role of ['admin','store'])for(const feature of Object.keys(names[role])){const input=form.elements.namedItem(names[role][feature]);if(input)draft[role][feature]=input.checked;}
  return draft;
}
export function patchPortalFeatureFields(form,draft,{disabled=false}={}) {
  for(const role of ['admin','store'])for(const feature of Object.keys(names[role])){const input=form.elements.namedItem(names[role][feature]);if(input){input.checked=draft[role][feature];input.disabled=disabled;input.setAttribute('aria-checked',String(input.checked));}}
}
export function serializePortalFeatureFields(draft) {return {enabled:draft.admin.flowEnabled,multilingualEnabled:draft.admin.multilingualEnabled,portals:structuredClone(draft)};}
