import {languagePicker,t} from '../i18n/index.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// One source controls the ordering and notification glyph in all three portals.
export function topbarTools(flow,notifications) {
  return flow+languagePicker()+notifications;
}

export function notificationTool({count=0,label,disabled=false,action='notifications'}={}) {
  const name=disabled?t('通知已停用'):label||t('通知中心');
  return `<button type="button" class="icon-button topbar-tool notification-button ${count&&!disabled?'has-notifications':''}" data-action="${escape(action)}" aria-label="${escape(name)}" title="${escape(name)}" aria-haspopup="dialog" ${disabled?'disabled':''}><span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></span>${count&&!disabled?`<span class="notification-badge" aria-hidden="true">${count>99?'99+':Number(count)}</span>`:''}</button>`;
}
