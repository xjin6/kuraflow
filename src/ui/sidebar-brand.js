import {t, tx, ta, setI18nText} from "../i18n/index.js";
import { portalBrandColor } from './portal-icon.js';

// The sidebar and login share the approved colour mapping; both now use a light surface.
// Keep the surrounding link and its existing action in each application shell.
export function sidebarBrandMarkup(portal = 'kitchen') {
  const color = portalBrandColor(portal);
  const base = `/public/brand/kuraflow-${color}`;
  return `<span class="sidebar-brand" role="img" ${ta("aria-label", "倉流 KuraFlow")}><img class="sidebar-brand-icon" src="${base}.svg" width="34" height="34" alt="" aria-hidden="true"><span class="sidebar-brand-wordmarks"><img class="sidebar-brand-kanji" src="${base}-kanji.svg" width="36" height="18" alt="" aria-hidden="true"><img class="sidebar-brand-english" src="${base}-english.svg" width="112" height="21" alt="" aria-hidden="true"></span></span>`;
}
