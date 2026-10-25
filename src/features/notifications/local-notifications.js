import { deriveNotificationEvents, notificationCurrentStatus } from '../../shared/notification-domain.js';

export const LOCAL_NOTIFICATIONS_KEY = 'kuraflow-notification-journal-v1';
const hubs = new WeakMap();
const observers = new Set();
const clone = value => JSON.parse(JSON.stringify(value));
const positive = value => Number.isSafeInteger(value) && value > 0;
const blank = () => ({ version: 1, seq: 0, events: [], reads: Object.create(null) });

function validJournal(value) {
  return value?.version === 1 && Array.isArray(value.events) && value.reads && typeof value.reads === 'object';
}

// Storage may be unavailable in a private/embedded browser. Keep this session
// usable and explicitly report persistence failure; never discard unread events
// to make space for new ones.
export function createLocalNotifications({ model, actorId = 'local-admin', actorName = '本地管理员', storage = globalThis.localStorage, onChange = () => {} }) {
  let journal = blank(), persistenceWarning = '', disposed = false;
  const actor = String(actorId || 'local-admin');
  const notify = () => { if (!disposed) { try { onChange(); } catch { /* A badge render must not interrupt a saved business command. */ } } };
  function merge() {
    try {
      const raw = storage?.getItem(LOCAL_NOTIFICATIONS_KEY);
      if (!raw) return;
      const incoming = JSON.parse(raw);
      if (!validJournal(incoming)) { persistenceWarning = '本地通知存储格式异常，当前通知暂存于本次会话。'; return; }
      const byKey = new Map(journal.events.map(event => [event.eventKey, event]));
      for (const event of incoming.events) if (positive(event.id) && typeof event.eventKey === 'string') byKey.set(event.eventKey, event);
      journal.events = [...byKey.values()].sort((a, b) => a.id - b.id);
      journal.seq = journal.events.reduce((maximum, event) => Math.max(maximum, event.id), Math.max(journal.seq, Number(incoming.seq) || 0));
      for (const [id, reads] of Object.entries(incoming.reads)) {
        if (!Array.isArray(reads)) continue;
        journal.reads[id] = [...new Set([...(journal.reads[id] || []), ...reads.filter(positive)])];
      }
    } catch { persistenceWarning = '本地通知暂时无法保存，请勿关闭当前页面。'; }
  }
  function persist() {
    try {
      if (!storage?.setItem) throw new Error('storage unavailable');
      storage.setItem(LOCAL_NOTIFICATIONS_KEY, JSON.stringify(journal));
      persistenceWarning = '';
    } catch { persistenceWarning = '本地通知暂时无法保存，请勿关闭当前页面。'; }
    for (const observer of observers) observer();
  }
  function publish(before, after) {
    const eventKey = `local:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const events = deriveNotificationEvents(before, after, { eventKey, actorId: actor, actorName });
    if (!events.length) return;
    merge();
    const keys = new Set(journal.events.map(event => event.eventKey));
    for (const event of events) if (!keys.has(event.eventKey)) {
      journal.events.push({ ...event, id: ++journal.seq }); keys.add(event.eventKey);
    }
    persist();
  }
  merge();
  let hub = hubs.get(model);
  if (!hub) {
    hub = { original: model.save, baseline: clone(model.state), subscribers: new Map() };
    hub.wrapper = function (...args) {
      const result = hub.original.apply(this, args);
      const before = hub.baseline, after = clone(this.state);
      hub.baseline = after;
      hub.subscribers.values().next().value?.(before, after);
      return result;
    };
    model.save = hub.wrapper; hubs.set(model, hub);
  }
  const subscriber = {}; hub.subscribers.set(subscriber, publish); observers.add(notify);
  const handleStorage = event => { if (event.key === LOCAL_NOTIFICATIONS_KEY) { merge(); notify(); } };
  globalThis.addEventListener?.('storage', handleStorage);

  function list({ filter = 'all', before, includeDemo = false, limit = 50 } = {}) {
    merge();
    const read = new Set(journal.reads[actor] || []);
    const visible = journal.events.filter(event => includeDemo || !event.isDemo);
    const unreadCount = visible.filter(event => !read.has(event.id)).length;
    const pageSize = Math.min(50, Math.max(1, Math.floor(Number(limit) || 50)));
    const cursor = Number(before);
    const filtered = visible.filter(event => (filter !== 'unread' || !read.has(event.id)) && (!positive(cursor) || event.id < cursor)).sort((a, b) => b.id - a.id);
    const selected = filtered.slice(0, pageSize);
    return { items: selected.map(event => ({ ...clone(event), read: read.has(event.id), currentStatus: notificationCurrentStatus(event, model.state) })),
      unreadCount, latestId: visible.reduce((maximum, event) => Math.max(maximum, event.id), 0),
      hasMore: filtered.length > selected.length, nextCursor: filtered.length > selected.length ? selected.at(-1).id : null,
      ...(persistenceWarning ? { persistenceWarning } : {}) };
  }
  function markRead(body = {}) {
    merge();
    const includeDemo = body.includeDemo === true;
    const visible = journal.events.filter(event => includeDemo || !event.isDemo);
    let ids;
    if (Array.isArray(body.ids) && body.through === undefined) {
      if (body.ids.length > 100 || body.ids.some(id => !positive(id))) throw new Error('请选择有效的通知。');
      const owned = new Set(journal.events.map(event => event.id));
      if (body.ids.some(id => !owned.has(id))) throw new Error('通知不存在。');
      ids = body.ids;
    } else if (positive(body.through) && body.ids === undefined) {
      ids = visible.filter(event => event.id <= body.through).map(event => event.id);
    } else if (body.through === 0 && body.ids === undefined) ids = [];
    else throw new Error('请选择有效的通知。');
    journal.reads[actor] = [...new Set([...(journal.reads[actor] || []), ...ids])];
    persist();
    return { unreadCount: list({ includeDemo }).unreadCount, ...(persistenceWarning ? { persistenceWarning } : {}) };
  }
  function refresh() { merge(); hub.baseline = clone(model.state); notify(); return list(); }
  function dispose() {
    if (disposed) return;
    disposed = true; observers.delete(notify); hub.subscribers.delete(subscriber);
    globalThis.removeEventListener?.('storage', handleStorage);
    if (!hub.subscribers.size) {
      if (model.save === hub.wrapper) model.save = hub.original;
      hubs.delete(model);
    }
  }
  return { list, markRead, refresh, dispose };
}
