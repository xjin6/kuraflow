import {t, tx, ta, setI18nText, getLocale} from "../i18n/index.js";
let selectInitialized=false,dateInitialized=false;
// Keep native form values and validation while rendering one shared select UI.
export function initSelectControls() {
  if(selectInitialized)return;selectInitialized=true;
  initDateControls();
  const controls = new Map();
  let sequence = 0, opened = null, typeBuffer = '', typeTimer;
  const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const chevron = svg('<path d="m6 9 6 6 6-6"/>');
  const check = svg('<path d="m5 12 4 4L19 6"/>');

  function close(restoreFocus = false) {
    if (!opened) return;
    const control = opened;
    opened = null;
    control.menu.remove();
    control.menu = null;
    control.trigger.setAttribute('aria-expanded', 'false');
    control.trigger.removeAttribute('aria-activedescendant');
    control.wrapper.classList.remove('is-open');
    if (restoreFocus && control.trigger.isConnected) control.trigger.focus({ preventScroll: true });
  }

  function sync(control) {
    const { select, trigger, text, wrapper } = control;
    const option = select.selectedOptions[0];
    const label = select.getAttribute('aria-label') || [...select.labels].map(el => el.textContent.trim()).join(' ') || '选择';
    control.label = label;
    setI18nText(text, () => (option?.textContent || t("请选择")), "textContent");
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-required', String(select.required));
    if (select.hasAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    if (select.hasAttribute('aria-invalid')) trigger.setAttribute('aria-invalid', select.getAttribute('aria-invalid'));
    else trigger.removeAttribute('aria-invalid');
    wrapper.classList.toggle('is-placeholder', !select.value);
    wrapper.classList.toggle('is-disabled', select.disabled);
    if (opened === control) {
      if (select.disabled || !select.isConnected) close();
      else renderOptions(control);
    }
  }

  function position(control) {
    const rect = control.trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const gap = 6, margin = 12;
    const availableBelow = topEdge + height - rect.bottom - gap - margin;
    const availableAbove = rect.top - topEdge - gap - margin;
    const compact = control.select.closest('.sale-unit-picker');
    const heightLimit = compact ? 224 : 320;
    const desired = Math.min(heightLimit, control.list.scrollHeight + (control.search ? 54 : 0) + (compact ? 8 : 12));
    const above = availableBelow < Math.min(desired, 180) && availableAbove > availableBelow;
    const maxHeight = Math.max(64, Math.min(heightLimit, above ? availableAbove : availableBelow));
    const naturalWidth = compact ? Math.min(160, Math.max(rect.width, 80, control.list.scrollWidth + 8)) : Math.max(rect.width, 180);
    const menuWidth = Math.min(naturalWidth, width - margin * 2);
    Object.assign(control.menu.style, {
      width: `${menuWidth}px`, maxHeight: `${maxHeight}px`,
      left: `${Math.max(leftEdge + margin, Math.min(rect.left, leftEdge + width - menuWidth - margin))}px`,
      top: `${above ? rect.top - gap : rect.bottom + gap}px`,
      transform: above ? 'translateY(-100%)' : 'none',
    });
  }

  function activate(control, index, scroll = true) {
    const items = [...control.list.querySelectorAll('[role="option"]')];
    const item = items.find(el => Number(el.dataset.index) === index && el.getAttribute('aria-disabled') !== 'true');
    if (!item) { control.active = -1; control.trigger.removeAttribute('aria-activedescendant'); control.search?.removeAttribute('aria-activedescendant'); return; }
    control.active = index;
    items.forEach(el => el.classList.toggle('is-active', el === item));
    control.trigger.setAttribute('aria-activedescendant', item.id);
    control.search?.setAttribute('aria-activedescendant', item.id);
    if (scroll) {
      const row = item.getBoundingClientRect(), list = control.list.getBoundingClientRect();
      if (row.top < list.top) control.list.scrollTop += row.top - list.top;
      else if (row.bottom > list.bottom) control.list.scrollTop += row.bottom - list.bottom;
    }
  }

  function renderOptions(control) {
    const query = control.search?.value.trim().toLocaleLowerCase() || '';
    control.list.replaceChildren();
    [...control.select.options].forEach((option, index) => {
      if (option.hidden || (!option.value && (option.disabled || control.select.required)) || !option.textContent.toLocaleLowerCase().includes(query)) return;
      const item = document.createElement('div');
      item.className = 'ui-select-option';
      item.id = `${control.uid}-option-${index}`;
      item.dataset.index = index;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.setAttribute('aria-disabled', String(option.disabled || option.parentElement.disabled === true));
      const label = document.createElement('span'); label.textContent = option.textContent;
      const tick = document.createElement('span'); tick.className = 'ui-select-check'; tick.innerHTML = check;
      item.append(label, tick);
      item.addEventListener('pointermove', () => activate(control, index, false));
      item.addEventListener('pointerdown', event => event.preventDefault());
      item.addEventListener('click', () => commit(control, index));
      control.list.append(item);
    });
    const enabled = [...control.list.querySelectorAll('[role="option"]:not([aria-disabled="true"])')];
    if (!control.list.childElementCount) {
      const empty = document.createElement('div'); empty.className = 'ui-select-empty'; setI18nText(empty, () => t("没有匹配项"), "textContent");
      control.list.append(empty);
    }
    const next = enabled.find(el => Number(el.dataset.index) === control.active) || enabled.find(el => el.getAttribute('aria-selected') === 'true') || enabled[0];
    activate(control, next ? Number(next.dataset.index) : -1, false);
    position(control);
  }

  function open(control, focusSearch = false) {
    if (control.select.disabled) return;
    close();
    opened = control;
    const menu = document.createElement('div'); menu.className = 'ui-select-menu';
    if (control.select.closest('.sale-unit-picker')) menu.classList.add('ui-select-menu-unit');
    const list = document.createElement('div'); list.className = 'ui-select-options'; list.id = `${control.uid}-list`;
    list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', control.label);
    control.menu = menu; control.list = list; control.search = null;
    control.active = control.select.selectedIndex;
    if (control.select.options.length > 10) {
      const searchWrap = document.createElement('div'); searchWrap.className = 'ui-select-search';
      searchWrap.innerHTML = svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>');
      const search = document.createElement('input'); search.type = 'search'; setI18nText(search, () => t("搜索选项"), "placeholder");
      search.setAttribute('aria-label', t('搜索{0}',[control.label])); search.setAttribute('role', 'combobox');
      search.setAttribute('aria-controls', list.id); search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-autocomplete', 'list');
      search.addEventListener('input', () => renderOptions(control));
      search.addEventListener('keydown', event => keydown(event, control));
      searchWrap.append(search); menu.append(searchWrap); control.search = search;
    }
    menu.append(list); (control.trigger.closest('[role="dialog"]') || document.body).append(menu);
    control.trigger.setAttribute('aria-expanded', 'true');
    control.wrapper.classList.add('is-open');
    renderOptions(control);
    activate(control, control.active);
    if (focusSearch) control.search?.focus({ preventScroll: true });
  }

  function commit(control, index) {
    const option = control.select.options[index];
    if (!option || option.disabled || option.parentElement.disabled || control.select.disabled) return;
    const previous = control.select.value;
    control.select.selectedIndex = index;
    control.select.removeAttribute('aria-invalid');
    close(true); sync(control);
    if (control.select.value !== previous) {
      control.select.dispatchEvent(new Event('input', { bubbles: true }));
      control.select.dispatchEvent(new Event('change', { bubbles: true }));
      // Some screens render again when the selection changes. Keep keyboard focus.
      queueMicrotask(() => {
        if (control.trigger.isConnected) return;
        const replacement = control.select.id ? document.getElementById(control.select.id) : control.select.dataset.cartUnit ? document.querySelector(`select[data-cart-unit="${CSS.escape(control.select.dataset.cartUnit)}"]`) : null;
        controls.get(replacement)?.trigger.focus({ preventScroll: true });
      });
    }
  }

  function keydown(event, control) {
    if (event.isComposing || event.keyCode === 229) return;
    const { key } = event;
    if (key === 'Escape' && opened === control) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (key === 'Tab') {
      if (opened === control && control.search && event.target === control.trigger && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); control.search.focus({ preventScroll: true });
      } else if (opened === control) close(event.target === control.search);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key) && !(event.target === control.search && key === ' ')) {
      event.preventDefault(); event.stopPropagation();
      if (opened !== control) { open(control, true); return; }
      if (key === 'Enter' || key === ' ') { commit(control, control.active); return; }
      const enabled = [...control.list.querySelectorAll('[role="option"]:not([aria-disabled="true"])')].map(el => Number(el.dataset.index));
      const current = enabled.indexOf(control.active);
      const next = key === 'Home' ? 0 : key === 'End' ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, current + (key === 'ArrowDown' ? 1 : -1)));
      activate(control, enabled[next]);
    } else if (event.target !== control.search && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); if (opened !== control) open(control, true);
      if (control.search) { control.search.value += key; control.search.focus({ preventScroll: true }); renderOptions(control); return; }
      clearTimeout(typeTimer); typeBuffer += key.toLocaleLowerCase();
      typeTimer = setTimeout(() => { typeBuffer = ''; }, 700);
      const candidate = [...control.select.options].findIndex(option => !option.disabled && option.textContent.trim().toLocaleLowerCase().startsWith(typeBuffer));
      if (candidate >= 0) activate(control, candidate);
    }
  }

  function enhance(select) {
    if (controls.has(select) || select.multiple || select.size > 1) return;
    const uid = `ui-select-${++sequence}`;
    const wrapper = document.createElement('div'); wrapper.className = 'ui-select';
    if (select.classList.contains('quote-select')) wrapper.classList.add('ui-select-store');
    if (select.classList.contains('sale-unit-select') || select.closest('.unit-equation-side')) wrapper.classList.add('ui-select-unit');
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'ui-select-trigger';
    trigger.id = `${uid}-trigger`; trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${uid}-list`);
    const text = document.createElement('span'); text.className = 'ui-select-value';
    const arrow = document.createElement('span'); arrow.className = 'ui-select-arrow'; arrow.innerHTML = chevron;
    trigger.append(text, arrow);
    select.before(wrapper); wrapper.append(select, trigger);
    select.classList.add('ui-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    const control = { select, wrapper, trigger, text, uid, active: -1 };
    controls.set(select, control);
    trigger.addEventListener('click', () => opened === control ? close() : open(control));
    trigger.addEventListener('keydown', event => keydown(event, control));
    select.addEventListener('focus', () => trigger.focus({ preventScroll: true }));
    select.addEventListener('invalid', event => {
      event.preventDefault(); select.setAttribute('aria-invalid', 'true'); sync(control);
      const first = select.form?.querySelector('select:invalid');
      if (!first || first === select) trigger.focus();
    });
    sync(control);
  }

  function scan(root) {
    if (root.matches?.('select')) enhance(root);
    root.querySelectorAll?.('select').forEach(enhance);
  }
  scan(document.body);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(node => { if (node.nodeType === 1) scan(node); });
      const select = record.target.closest?.('select');
      if (controls.has(select)) sync(controls.get(select));
    }
    for (const [select, control] of controls) if (!select.isConnected) {
      if (opened === control) close();
      controls.delete(select);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'required', 'selected', 'aria-label', 'aria-invalid', 'label'] });
  document.addEventListener('change', event => { if (controls.has(event.target)) sync(controls.get(event.target)); }, true);
  document.addEventListener('reset', () => queueMicrotask(() => controls.forEach(sync)));
  document.addEventListener('kuraflow:language-change',()=>{close();controls.forEach(sync);});
  document.addEventListener('pointerdown', event => { if (opened && !opened.wrapper.contains(event.target) && !opened.menu.contains(event.target)) close(); }, true);
  document.addEventListener('focusin', event => { if (opened && !opened.wrapper.contains(event.target) && !opened.menu.contains(event.target)) close(); });
  document.addEventListener('click', event => {
    const label = event.target.closest('label');
    const control = controls.get(label?.control);
    if (control && !control.wrapper.contains(event.target)) { event.preventDefault(); control.trigger.focus(); }
  });
  document.addEventListener('scroll', event => {
    if (opened && !opened.menu.contains(event.target)) position(opened);
  }, true);
  window.addEventListener('resize', () => { if (opened) position(opened); });
  window.visualViewport?.addEventListener('resize', () => { if (opened) position(opened); });
}

// A shared calendar keeps date entry consistent with the rest of the interface.
// Native inputs remain the source of truth for forms and existing change handlers.
export function initDateControls() {
  if(dateInitialized)return;dateInitialized=true;
  if (document.documentElement.dataset.dateControlsReady) return;
  document.documentElement.dataset.dateControlsReady = 'true';
  const controls = new Map();
  let opened = null, sequence = 0;
  const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const calendarIcon = svg('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18"/>');
  const arrowIcon = direction => svg(`<path d="${direction < 0 ? 'm14 6-6 6 6 6' : 'm10 6 6 6-6 6'}"/>`);
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const parse = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day, 12);
    return iso(date) === value ? date : null;
  };
  const today = () => {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
  };
  const allowed = (control, value) => (!control.input.min || value >= control.input.min) && (!control.input.max || value <= control.input.max);
  const clamp = (control, value) => control.input.min && value < control.input.min ? control.input.min : control.input.max && value > control.input.max ? control.input.max : value;
  const dateLabel = value => {
    const date = parse(value);
    return date ? new Intl.DateTimeFormat(getLocale(),{year:'numeric',month:'long',day:'numeric'}).format(date) : '';
  };

  function close(restoreFocus = false) {
    if (!opened) return;
    const control = opened;
    opened = null;
    control.menu.remove();
    control.menu = null;
    control.trigger.setAttribute('aria-expanded', 'false');
    control.wrapper.classList.remove('is-open');
    if (restoreFocus && control.trigger.isConnected) control.trigger.focus({ preventScroll: true });
  }

  function sync(control) {
    const { input, trigger, wrapper } = control;
    const label = input.getAttribute('aria-label') || [...input.labels].map(el => {
      const copy = el.cloneNode(true); copy.querySelectorAll('.ui-date, input, svg').forEach(node => node.remove());
      return copy.textContent.trim();
    }).join(' ') || '选择日期';
    control.label = label;
    setI18nText(control.text, () => (input.value ? input.value.replaceAll('-', ' / ') : t("选择日期")), "textContent");
    trigger.disabled = input.disabled || input.readOnly;
    trigger.setAttribute('aria-label', `${label}${input.value ? '，' + dateLabel(input.value) : ''}`);
    trigger.setAttribute('aria-required', String(input.required));
    if (input.hasAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', input.getAttribute('aria-describedby'));
    else trigger.removeAttribute('aria-describedby');
    if (input.hasAttribute('aria-invalid')) trigger.setAttribute('aria-invalid', input.getAttribute('aria-invalid'));
    else trigger.removeAttribute('aria-invalid');
    wrapper.classList.toggle('is-placeholder', !input.value);
    if (opened === control && (trigger.disabled || !input.isConnected)) close();
  }

  function position(control) {
    const rect = control.trigger.getBoundingClientRect(), viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const margin = 12, gap = 8, menuWidth = Math.min(308, width - margin * 2);
    control.menu.style.width = `${menuWidth}px`;
    const menuHeight = Math.min(control.menu.scrollHeight, height - margin * 2);
    const below = topEdge + height - rect.bottom - margin - gap, above = rect.top - topEdge - margin - gap;
    const top = below >= menuHeight || below >= above ? rect.bottom + gap : rect.top - menuHeight - gap;
    Object.assign(control.menu.style, {
      left: `${Math.max(leftEdge + margin, Math.min(rect.left, leftEdge + width - menuWidth - margin))}px`,
      top: `${Math.max(topEdge + margin, Math.min(top, topEdge + height - menuHeight - margin))}px`,
      maxHeight: `${height - margin * 2}px`,
    });
  }

  function moveMonth(control, amount, focusDay = false) {
    const date = parse(control.active) || parse(control.input.value) || parse(today());
    const month = new Date(control.month.getFullYear(), control.month.getMonth() + amount, 1, 12);
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const target = new Date(month.getFullYear(), month.getMonth(), Math.min(date.getDate(), lastDay), 12);
    const next = parse(clamp(control, iso(target)));
    if (!next) return;
    control.month = new Date(next.getFullYear(), next.getMonth(), 1, 12);
    control.active = iso(next);
    renderCalendar(control, focusDay);
  }

  function renderCalendar(control, focusDay = false) {
    const { input, menu, month } = control;
    const year = month.getFullYear(), monthIndex = month.getMonth(), todayValue = today();
    const monthLabel = new Intl.DateTimeFormat(getLocale(),{year:'numeric',month:'long'}).format(month);
    const prevEnd = iso(new Date(year, monthIndex, 0, 12));
    const nextStart = iso(new Date(year, monthIndex + 1, 1, 12));
    const previouslyFocused = menu.contains(document.activeElement) ? document.activeElement.dataset.calendarAction : null;
    menu.innerHTML = `<div class="ui-calendar-header"><button type="button" class="ui-calendar-nav" data-calendar-action="previous" ${ta("aria-label", "上个月")} ${input.min && prevEnd < input.min ? 'disabled' : ''}>${arrowIcon(-1)}</button><strong id="${control.uid}-title" aria-live="polite">${monthLabel}</strong><button type="button" class="ui-calendar-nav" data-calendar-action="next" ${ta("aria-label", "下个月")} ${input.max && nextStart > input.max ? 'disabled' : ''}>${arrowIcon(1)}</button></div><div class="ui-calendar-grid" role="grid" aria-labelledby="${control.uid}-title"><div class="ui-calendar-week" role="row">${[0,1,2,3,4,5,6].map(index=>{const day=new Date(2026,9,19+index,12);return `<span role="columnheader" aria-label="${new Intl.DateTimeFormat(getLocale(),{weekday:'long'}).format(day)}">${new Intl.DateTimeFormat(getLocale(),{weekday:'short'}).format(day)}</span>`;}).join('')}</div></div><div class="ui-calendar-footer">${(input.required ? '' : `<button type="button" data-calendar-action="clear" ${!input.value ? 'disabled' : ''}>${tx("清空")}</button>`)}<button type="button" data-calendar-action="today" ${allowed(control, todayValue) ? '' : 'disabled'}>${tx("今天")}</button></div>`;
    const grid = menu.querySelector('.ui-calendar-grid');
    const first = new Date(year, monthIndex, 1, 12), offset = (first.getDay() + 6) % 7;
    for (let week = 0; week < 6; week += 1) {
      const row = document.createElement('div'); row.className = 'ui-calendar-week'; row.setAttribute('role', 'row');
      for (let day = 0; day < 7; day += 1) {
        const date = new Date(year, monthIndex, 1 - offset + week * 7 + day, 12), value = iso(date);
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'ui-calendar-day'; button.textContent = date.getDate();
        button.dataset.date = value; button.setAttribute('role', 'gridcell');
        button.setAttribute('aria-label',new Intl.DateTimeFormat(getLocale(),{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(date));
        button.setAttribute('aria-selected', String(value === input.value));
        button.disabled = !allowed(control, value); button.tabIndex = value === control.active ? 0 : -1;
        if (value === todayValue) button.setAttribute('aria-current', 'date');
        if (date.getMonth() !== monthIndex) button.classList.add('is-outside');
        button.addEventListener('click', () => commit(control, value));
        button.addEventListener('keydown', event => dayKeydown(event, control, value));
        row.append(button);
      }
      grid.append(row);
    }
    menu.querySelector('[data-calendar-action="previous"]').addEventListener('click', () => moveMonth(control, -1));
    menu.querySelector('[data-calendar-action="next"]').addEventListener('click', () => moveMonth(control, 1));
    menu.querySelector('[data-calendar-action="clear"]')?.addEventListener('click', () => commit(control, ''));
    menu.querySelector('[data-calendar-action="today"]').addEventListener('click', () => commit(control, today()));
    position(control);
    if (focusDay) menu.querySelector(`[data-date="${control.active}"]`)?.focus({ preventScroll: true });
    else if (previouslyFocused) (menu.querySelector(`[data-calendar-action="${previouslyFocused}"]:not(:disabled)`) || menu.querySelector(`[data-date="${control.active}"]`))?.focus({ preventScroll: true });
  }

  function dayKeydown(event, control, value) {
    const movements = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); moveMonth(control, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1), true); return;
    }
    if (!(event.key in movements) && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const date = parse(value), weekday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() + (event.key === 'Home' ? -weekday : event.key === 'End' ? 6 - weekday : movements[event.key]));
    const next = parse(clamp(control, iso(date)));
    control.active = iso(next); control.month = new Date(next.getFullYear(), next.getMonth(), 1, 12);
    renderCalendar(control, true);
  }

  function open(control) {
    if (control.trigger.disabled) return;
    close(); opened = control;
    control.active = clamp(control, control.input.value || today());
    const selected = parse(control.active) || parse(today());
    control.month = new Date(selected.getFullYear(), selected.getMonth(), 1, 12);
    const menu = document.createElement('div'); menu.className = 'ui-calendar'; menu.id = `${control.uid}-calendar`;
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', control.label);
    control.menu = menu;
    (control.trigger.closest('[role="dialog"]') || document.body).append(menu);
    control.trigger.setAttribute('aria-expanded', 'true'); control.wrapper.classList.add('is-open');
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === 'Tab') {
        const focusable = [...menu.querySelectorAll('button:not(:disabled)')].filter(button => button.tabIndex >= 0);
        const index = focusable.indexOf(document.activeElement);
        if ((event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
          // Returning to the trigger lets the next Tab continue through the page.
          event.preventDefault(); close(true);
        }
      }
    });
    renderCalendar(control, true);
  }

  function commit(control, value) {
    if (control.input.disabled || control.input.readOnly || (value && !allowed(control, value)) || (!value && control.input.required)) return;
    const previous = control.input.value;
    control.input.value = value; control.input.removeAttribute('aria-invalid');
    close(true); sync(control);
    if (value !== previous) {
      control.input.dispatchEvent(new Event('input', { bubbles: true }));
      control.input.dispatchEvent(new Event('change', { bubbles: true }));
      queueMicrotask(() => {
        if (control.trigger.isConnected || !control.input.id) return;
        controls.get(document.getElementById(control.input.id))?.trigger.focus({ preventScroll: true });
      });
    }
  }

  function enhance(input) {
    if (controls.has(input)) return;
    const uid = `ui-date-${++sequence}`, wrapper = document.createElement('div'); wrapper.className = 'ui-date';
    const trigger = document.createElement('button'); trigger.className = 'ui-date-trigger'; trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${uid}-calendar`);
    const icon = document.createElement('span'); icon.className = 'ui-date-icon'; icon.innerHTML = calendarIcon;
    const text = document.createElement('span'); text.className = 'ui-date-value';
    trigger.append(icon, text); input.before(wrapper); wrapper.append(input, trigger);
    input.classList.add('ui-date-native'); input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
    const control = { input, wrapper, trigger, text, uid }; controls.set(input, control);
    trigger.addEventListener('click', () => opened === control ? close() : open(control));
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(control); }
      if (event.key === 'Escape' && opened === control) { event.preventDefault(); event.stopPropagation(); close(true); }
    });
    input.addEventListener('focus', () => trigger.focus({ preventScroll: true }));
    input.addEventListener('invalid', event => { event.preventDefault(); input.setAttribute('aria-invalid', 'true'); sync(control); trigger.focus(); });
    sync(control);
  }

  function scan(root) {
    if (root.matches?.('input[type="date"]')) enhance(root);
    root.querySelectorAll?.('input[type="date"]').forEach(enhance);
  }
  scan(document.body);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(node => { if (node.nodeType === 1) scan(node); });
      if (controls.has(record.target)) sync(controls.get(record.target));
    }
    for (const [input, control] of controls) if (!input.isConnected) {
      if (opened === control) close(); controls.delete(input);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'readonly', 'required', 'value', 'min', 'max', 'aria-label', 'aria-invalid', 'aria-describedby'] });
  document.addEventListener('change', event => { if (controls.has(event.target)) sync(controls.get(event.target)); }, true);
  document.addEventListener('reset', () => queueMicrotask(() => controls.forEach(sync)));
  document.addEventListener('kuraflow:language-change',()=>{close();controls.forEach(sync);});
  document.addEventListener('pointerdown', event => { if (opened && !opened.wrapper.contains(event.target) && !opened.menu.contains(event.target)) close(); }, true);
  document.addEventListener('focusin', event => { if (opened && !opened.wrapper.contains(event.target) && !opened.menu.contains(event.target)) close(); });
  document.addEventListener('click', event => {
    const label = event.target.closest('label'), control = controls.get(label?.control);
    if (control && !control.wrapper.contains(event.target)) { event.preventDefault(); control.trigger.focus(); }
  });
  document.addEventListener('scroll', event => { if (opened && !opened.menu.contains(event.target)) position(opened); }, true);
  window.addEventListener('resize', () => { if (opened) position(opened); });
  window.visualViewport?.addEventListener('resize', () => { if (opened) position(opened); });
}
