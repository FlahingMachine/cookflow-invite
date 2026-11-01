// Pure logic of the web guest page (no DOM, no network): reading the invite token, the per-field last-writer-wins merge
// (the same rules as src/features/shopping/sync.ts and the server's shared_list_apply), and filing items by category.
import { CATEGORY_DATA } from './categories.js';

/** Whitespace, line breaks and the invisible direction marks messengers add inside long strings. */
const NOISE = /[\s​-‏‪-‮⁦-⁩﻿]/g;
const HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/;

/** The invitation token from a URL fragment or path (`#<token>`, `/join/<token>`), or null unless it is 64 hex characters. */
export function tokenFromLocation(hash = '', pathname = '') {
  const cleaned = `${hash.replace(/^#/, '')} ${pathname}`.replace(NOISE, '').toLowerCase();
  const m = cleaned.match(/(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/);
  return m ? m[1] : null;
}

/** Whatever a person pasted (the bare code, a link or a whole message) to the token, or null. */
export function tokenFromText(input = '') {
  const cleaned = String(input).replace(NOISE, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(cleaned)) return cleaned;
  const linked = cleaned.match(/join[/#]([0-9a-f]{64})(?![0-9a-f])/);
  if (linked) return linked[1];
  const loose = String(input).toLowerCase().match(HEX64);
  return loose ? loose[0] : null;
}

/** `a` is newer than `b` (a missing stamp is older than anything). Lamport first, then the client id by plain byte order. */
export const newer = (a, b) => !b || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

export const makeId = (prefix = '') =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

/** The local copy of one shared list: the list's own fields, the items by id, and the logical clock. */
export class ListState {
  constructor(client) {
    this.client = client;
    this.lamport = 0;
    this.list = { _ts: {} };
    this.items = {};
    this.pending = [];
  }

  /** Applies one operation; true when a field changed. Safe to apply twice or out of order. */
  apply(op) {
    if (op.ts[0] > this.lamport) this.lamport = op.ts[0];
    const target = op.k === 'list' ? this.list : (this.items[op.id] ??= { id: op.id, _ts: {} });
    let changed = false;
    for (const [field, value] of Object.entries(op.set)) {
      if (newer(op.ts, target._ts[field])) {
        target[field] = value;
        target._ts[field] = op.ts;
        changed = true;
      }
    }
    return changed;
  }

  /** Stored rows ({ k, id, fields, ts }) from shared_list_load, merged in. */
  receiveRows(rows) {
    let any = false;
    for (const row of rows) {
      const k = row.k ?? row.kind;
      const id = row.id ?? row.item_id;
      if ((k !== 'list' && k !== 'item') || typeof id !== 'string') continue;
      for (const [field, ts] of Object.entries(row.ts ?? {})) {
        if (!Array.isArray(ts) || ts.length !== 2) continue;
        if (this.apply({ k, id, set: { [field]: (row.fields ?? {})[field] }, ts })) any = true;
      }
    }
    return any;
  }

  /** A local change: applied at once and queued until the server has it. */
  change(k, id, set) {
    const op = { k, id, set, ts: [++this.lamport, this.client] };
    this.apply(op);
    this.pending.push(op);
    return op;
  }

  liveItems() {
    return Object.values(this.items).filter(
      (it) => it.deleted !== true && typeof it.name === 'string',
    );
  }
}

const IDS = new Set(CATEGORY_DATA.categories.map((c) => c.id));
const BY_NAME = new Map();
for (const [cat, names] of Object.entries(CATEGORY_DATA.dict))
  for (const n of names) BY_NAME.set(n, cat);
/** The aisle keys older lists use, as the app maps them. */
const LEGACY = { veg: 'produce', dairy: 'dairy', meat: 'meat', pantry: 'pantry', bakery: 'pantry' };

/** The category an item shows under: the picked one, else the dictionary by name (longest prefix), else its aisle, else "misc". */
export function categoryOf(item) {
  if (item.cat && IDS.has(item.cat)) return item.cat;
  if (item.cat && CATEGORY_DATA.merged[item.cat]) return CATEGORY_DATA.merged[item.cat];
  const name = String(item.name ?? '').trim();
  let found = BY_NAME.get(name);
  if (!found) {
    let best = null;
    for (const [word, cat] of BY_NAME)
      if (name.startsWith(`${word} `) && (!best || word.length > best[0].length))
        best = [word, cat];
    found = best ? best[1] : null;
  }
  return found ?? LEGACY[item.g] ?? 'misc';
}

/** Categories that have at least one item, in the app's order; open items first, bought ones after. */
export function groupItems(items) {
  const groups = [];
  for (const c of CATEGORY_DATA.categories) {
    const inCat = items.filter((it) => categoryOf(it) === c.id);
    if (!inCat.length) continue;
    groups.push({
      id: c.id,
      label: c.label,
      open: inCat.filter((x) => !x.done),
      bought: inCat.filter((x) => x.done),
      total: inCat.length,
      got: inCat.filter((x) => x.done).length,
    });
  }
  return groups;
}

/** The fields a new item travels with (the same set the app sends). */
export function newItemFields(name, qty = 1, unit = '') {
  const clean = String(name).trim().slice(0, 80);
  return { name: clean, qty, unit, g: 'pantry', done: false, note: null, cat: null };
}

/** A plain-text copy of the list, bought items marked. */
export function listAsText(title, items) {
  const lines = [`*${title}*`];
  for (const g of groupItems(items)) {
    lines.push('', `*${g.label}*`);
    for (const it of [...g.open, ...g.bought]) {
      const amount = it.qty && it.qty !== 1 ? ` ${it.qty}${it.unit ? ` ${it.unit}` : ''}` : '';
      lines.push(`${it.done ? '✔' : '•'} ${it.name}${amount}${it.note ? ` (${it.note})` : ''}`);
    }
  }
  return lines.join('\n');
}

/** The `finished` field of the list (written by shared_list_finish), or null while the shopping is still going. */
export function finishedOf(list) {
  const f = list && list.finished;
  if (!f || typeof f !== 'object' || typeof f.at !== 'string') return null;
  return {
    at: f.at,
    store: typeof f.store === 'string' && f.store ? f.store : null,
    totalAgorot: typeof f.total_agorot === 'number' ? f.total_agorot : null,
    byRole: f.by_role === 'owner' || f.by_role === 'editor' ? f.by_role : null,
  };
}

export const formatShekels = (agorot) => {
  const shekels = agorot / 100;
  return `₪${Number.isInteger(shekels) ? shekels : shekels.toFixed(2)}`;
};

/** A typed amount in shekels ("123.5", "123,50", "₪ 99") to agorot, or null when it is not a usable number. */
export function parseShekels(text) {
  const cleaned = String(text).replace(/[₪\s]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const agorot = Math.round(Number(cleaned) * 100);
  return agorot <= 100000000 ? agorot : null;
}

/** The sentence every member reads when the shopping ended. */
export function finishedSentence(info, mine = false) {
  const who = mine
    ? 'סיימתם'
    : info.byRole === 'owner'
      ? 'המארח סיים'
      : info.byRole === 'editor'
        ? 'אחד המשתתפים סיים'
        : 'סיימו';
  return `${who} את הקנייה${info.store ? ` ב${info.store}` : ''}${info.totalAgorot != null ? `, וזה יצא ${formatShekels(info.totalAgorot)}` : ''}.`;
}

/** The list as text for a message, with where it was bought and the total at the end. */
export function finishedAsText(title, items, info) {
  const lines = [listAsText(title, items)];
  const tail = [];
  if (info.store) tail.push(`נקנה ב${info.store}`);
  if (info.totalAgorot != null) tail.push(`סכום: ${formatShekels(info.totalAgorot)}`);
  if (tail.length) lines.push('', tail.join(' · '));
  return lines.join('\n');
}

/** Server error text to a sentence the guest can read (one answer for every kind of invalid invitation). */
export function friendlyError(message = '') {
  const m = String(message);
  if (/invite invalid or expired/i.test(m))
    return 'ההזמנה לא תקפה: היא פגה, בוטלה או שכבר נוצלה. בקשו מהשולח הזמנה חדשה.';
  if (/too many members/i.test(m)) return 'הרשימה הגיעה למספר המשתתפים המרבי.';
  if (/already finished|list finished/i.test(m)) return 'הקנייה המשותפת כבר הסתיימה.';
  if (/list not found/i.test(m)) return 'הרשימה לא נמצאה, או שההצטרפות אליה בוטלה.';
  if (/read-only/i.test(m)) return 'יש לכם הרשאת צפייה בלבד ברשימה הזו.';
  if (/anonymous|signups? not allowed|disabled/i.test(m))
    return 'ההצטרפות מהדפדפן עדיין לא פעילה. בקשו מהשולח להצטרף דרך האפליקציה.';
  return 'משהו השתבש. בדקו את החיבור ונסו שוב.';
}
