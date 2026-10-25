// Finite interface feedback. Data edits and background refreshes never replay page entry.
export function createUIMotion(root) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const running = new Set();
  let pageKey = '', filterKey = '', resizeFrame = 0;
  const ease = 'cubic-bezier(.22,1,.36,1)';

  function animate(element, frames, options = {}) {
    if (!element || reduced.matches || !element.animate) return;
    const animation = element.animate(frames, { duration: 220, easing: ease, ...options });
    running.add(animation);
    animation.finished.catch(() => {}).finally(() => running.delete(animation));
  }

  function groups() {
    return [...root.querySelectorAll('.nav-list, .management-tabs, .tabs, .category-chips')].map((element, index) => {
      const first = element.querySelector('button');
      const nav = element.classList.contains('nav-list');
      return { element, nav, active: element.querySelector('button.active'),
        key: nav ? 'navigation' : (first?.dataset.group || first?.dataset.action || 'selection') + ':' + index };
    }).filter(group => group.active);
  }

  function capture() {
    const selections = new Map();
    let focused = null;
    for (const group of groups()) {
      const rect = group.active.getBoundingClientRect();
      selections.set(group.key, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollLeft: group.element.scrollLeft });
      if (group.element.contains(document.activeElement)) focused = group.key;
    }
    return { pageKey, filterKey, selections, focused };
  }

  function placeIndicators(previous = null) {
    const sameWorkspace = previous?.pageKey.split(':').slice(0, 2).join(':') === pageKey.split(':').slice(0, 2).join(':');
    for (const group of groups()) {
      const old = previous?.selections.get(group.key);
      if (old) group.element.scrollLeft = old.scrollLeft;
      const host = group.element.getBoundingClientRect();
      let active = group.active.getBoundingClientRect();
      if (!group.nav && group.element.scrollWidth > group.element.clientWidth) {
        if (active.left < host.left) group.element.scrollLeft += active.left - host.left - 8;
        else if (active.right > host.right) group.element.scrollLeft += active.right - host.right + 8;
        active = group.active.getBoundingClientRect();
      }
      if (!host.width || !active.width) continue;
      let ink = group.element.querySelector(':scope > .selection-ink');
      if (!ink) {
        ink = document.createElement('i'); ink.className = 'selection-ink'; ink.setAttribute('aria-hidden', 'true');
        group.element.append(ink);
      }
      group.element.classList.add('has-selection-ink');
      if (group.nav) {
        Object.assign(ink.style, { left: '0px', top: `${active.top - host.top + 11}px`, width: '2px', height: `${Math.max(16, active.height - 22)}px` });
      } else {
        Object.assign(ink.style, { left: `${active.left - host.left + group.element.scrollLeft + 10}px`, top: `${active.bottom - host.top + group.element.scrollTop - 2}px`, width: `${Math.max(12, active.width - 20)}px`, height: '2px' });
      }
      if (old && (group.nav || sameWorkspace)) {
        const deltaX = group.nav ? 0 : old.x - active.x;
        const deltaY = old.y - active.y;
        const scale = group.nav ? 1 : Math.max(12, old.width - 20) / Math.max(12, active.width - 20);
        if (Math.abs(deltaX) > .5 || Math.abs(deltaY) > .5 || Math.abs(scale - 1) > .02) {
          animate(ink, [{ transform: `translate(${deltaX}px,${deltaY}px) scaleX(${scale})` }, { transform: 'translate(0,0) scaleX(1)' }], { duration: 260 });
        }
      }
      if (previous?.focused === group.key) group.active.focus({ preventScroll: true });
    }
  }

  function afterRender(key, filter, previous) {
    const changed = pageKey !== key;
    pageKey = key; filterKey = filter;
    placeIndicators(previous);
    if (changed) {
      const surfaces = root.querySelectorAll('.page-content > .page-heading, .page-content > .overview-toolbar, .page-content > .stat-grid, .page-content > .section-card, .overview-grid > *, .stores-grid, .fulfillment-list, .order-detail-heading, .order-detail-summary, .order-packing-panel, .business-overview > .business-heading, .business-overview > .business-metrics, .business-overview > .business-trend, .business-rankings > *');
      [...surfaces].slice(0, 7).forEach((surface, index) => {
        // Opacity-only: transforms on ancestors change fixed calendar/menu coordinates.
        animate(surface, [{ opacity: .25 }, { opacity: 1 }], { duration: 210, delay: Math.min(index * 18, 72) });
      });
    } else if (previous?.filterKey !== filterKey) {
      animate(root.querySelector('.fulfillment-list'), [{ opacity: .45 }, { opacity: 1 }], { duration: 150 });
    }
  }

  const seen = new WeakSet();
  const popupSelector = '.modal-overlay, .ui-select-menu, .ui-calendar, .toast';
  function reveal(element) {
    if (seen.has(element)) return;
    seen.add(element);
    animate(element, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.matches('.order-context-bar') && !record.target.hidden) reveal(record.target);
        continue;
      }
      for (const node of record.addedNodes) if (node.nodeType === 1) {
        if (node.matches(popupSelector)) reveal(node);
        node.querySelectorAll(popupSelector).forEach(reveal);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });

  function scheduleLayout() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; placeIndicators(); });
  }
  window.addEventListener('resize', scheduleLayout);
  document.fonts?.ready.then(scheduleLayout);
  document.fonts?.addEventListener('loadingdone', scheduleLayout);
  reduced.addEventListener('change', () => { if (reduced.matches) running.forEach(animation => animation.cancel()); });
  return { capture, afterRender };
}
