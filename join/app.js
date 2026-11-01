// The web guest page: someone invited to a shared CookFlow list opens the link in a browser and joins, reads and (if the
// invitation allows) edits the list, with no app and no account. Every text from another person is put on the page with
// textContent, never as HTML.
import { GuestApi } from './api.js';
import config from './config.js';
import { CATEGORY_DATA } from './categories.js';
import {
  ListState,
  categoryOf,
  friendlyError,
  groupItems,
  listAsText,
  makeId,
  newItemFields,
  tokenFromLocation,
  tokenFromText,
  finishedAsText,
  finishedOf,
  finishedSentence,
  parseShekels,
} from './core.js';

const LIST_KEY = 'cookflow.guest.list.v1';
const CLIENT_KEY = 'cookflow.guest.client.v1';
const POLL_MS = 6000;
const BATCH = 200;

const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
const api = new GuestApi(config);

const store = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
const keep = (k) => {
  try {
    return store?.getItem(k) ?? null;
  } catch {
    return null;
  }
};
const put = (k, v) => {
  try {
    if (v === null) store?.removeItem(k);
    else store?.setItem(k, v);
  } catch {
    // storage blocked: the guest keeps access until the tab closes
  }
};

/** Builds an element; strings become text nodes, so nothing from the server is ever parsed as HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

let toastTimer = 0;
function toast(text, undo) {
  toastEl.replaceChildren(h('span', {}, text));
  if (undo) {
    toastEl.append(
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            undo();
            hideToast();
          },
        },
        'ביטול',
      ),
    );
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 6000 : 3500);
}
function hideToast() {
  toastEl.hidden = true;
}

const brandline = () =>
  h('div', { class: 'brandline' }, h('span', { class: 'dot' }), 'CookFlow · רשימת קניות משותפת');

// --- state -----------------------------------------------------------------------------------------------------------
const clientId = keep(CLIENT_KEY) || makeId('w');
put(CLIENT_KEY, clientId);
let token = tokenFromLocation(location.hash, location.pathname);
const view = {
  listId: null,
  role: null,
  state: new ListState(clientId),
  status: 'synced',
  pollId: 0,
  flushing: false,
};
const saved = (() => {
  try {
    return JSON.parse(keep(LIST_KEY) || 'null');
  } catch {
    return null;
  }
})();

// --- screens ---------------------------------------------------------------------------------------------------------
function show(...nodes) {
  root.replaceChildren(...nodes.filter(Boolean));
}

function screenNotConfigured() {
  show(
    brandline(),
    h('h1', {}, 'הדף עוד לא מוכן'),
    h(
      'p',
      { class: 'muted' },
      'הכתובת של השרת עוד לא הוגדרה בדף הזה. בקשו מהשולח להצטרף דרך האפליקציה.',
    ),
  );
}

function screenNoToken() {
  const input = h('input', {
    type: 'text',
    dir: 'ltr',
    inputmode: 'text',
    autocomplete: 'off',
    placeholder: 'הדביקו כאן את הקוד או הקישור',
    'aria-label': 'קוד הזמנה',
  });
  const err = h(
    'p',
    { class: 'notice', hidden: true },
    'לא מצאנו קוד תקין. הקוד הוא 64 תווים של 0-9 ו-a-f.',
  );
  show(
    brandline(),
    h('h1', {}, 'הצטרפות לרשימת קניות'),
    h('p', { class: 'muted' }, 'פתחו את הקישור שקיבלתם בהודעה, או הדביקו כאן את הקוד.'),
    input,
    err,
    h(
      'button',
      {
        type: 'button',
        onclick: () => {
          const t = tokenFromText(input.value);
          if (!t) return void (err.hidden = false);
          token = t;
          screenReady();
        },
      },
      'המשך',
    ),
  );
}

function openInAppHref() {
  const android = /android/i.test(navigator.userAgent);
  return android
    ? `intent://join/${token}#Intent;scheme=${config.appScheme};package=${config.androidPackage};S.browser_fallback_url=${encodeURIComponent(location.href.split('#')[0])};end`
    : `${config.appScheme}://join/${token}`;
}

function screenReady(errorText) {
  show(
    brandline(),
    h('h1', {}, 'הוזמנתם לרשימת קניות משותפת'),
    h(
      'p',
      { class: 'muted' },
      'אפשר להצטרף ישר מהדפדפן, בלי להתקין כלום. בלחיצה תיווצר לכם גישה לרשימה הזו בלבד.',
    ),
    errorText ? h('p', { class: 'notice', role: 'alert' }, errorText) : null,
    h(
      'button',
      { type: 'button', class: 'highlight', onclick: (e) => void join(e.currentTarget) },
      'הצטרפות לרשימה',
    ),
    h(
      'div',
      { class: 'card soft' },
      h('h2', {}, 'יש לכם את האפליקציה?'),
      h('a', { class: 'btn secondary', href: openInAppHref() }, 'פתיחה ב-CookFlow'),
      h(
        'p',
        { class: 'muted' },
        'או פתחו את CookFlow ← רשימת קניות ← הצטרפות עם קוד, והדביקו את הקוד:',
      ),
      h('div', { class: 'code' }, token),
    ),
  );
}

async function join(btn) {
  btn.disabled = true;
  btn.textContent = 'מצטרפים…';
  try {
    const res = await api.join(token);
    // the invitation is a secret: take it out of the address bar and the history as soon as it has been used
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      // not essential
    }
    token = null;
    view.listId = res.list_id;
    view.role = res.role;
    put(LIST_KEY, JSON.stringify({ listId: res.list_id, role: res.role }));
    await openList();
  } catch (e) {
    screenReady(friendlyError(e.message));
  }
}

async function resume() {
  view.listId = saved.listId;
  view.role = saved.role;
  try {
    await openList();
  } catch (e) {
    // the list is gone or access was withdrawn: forget it and start over
    if (/list not found/i.test(e.message)) {
      put(LIST_KEY, null);
      show(
        brandline(),
        h('h1', {}, 'אין לכם יותר גישה לרשימה'),
        h('p', { class: 'muted' }, friendlyError(e.message)),
      );
    } else {
      show(
        brandline(),
        h('h1', {}, 'אין חיבור'),
        h('p', { class: 'muted' }, friendlyError(e.message)),
        h('button', { type: 'button', onclick: () => void resume() }, 'ניסיון חוזר'),
      );
    }
  }
}

// --- the list --------------------------------------------------------------------------------------------------------
const ui = {};

async function openList() {
  await pull();
  if (finishedOf(view.state.list)) return showFinished();
  buildListScreen();
  paint();
  startPolling();
}

async function pull() {
  const data = await api.load(view.listId);
  view.role = data.role;
  put(LIST_KEY, JSON.stringify({ listId: view.listId, role: data.role }));
  view.state.receiveRows(data.ops ?? []);
  view.title = view.state.list.title || data.title || 'רשימת קניות';
}

const canEdit = () => view.role === 'editor' || view.role === 'owner';

function buildListScreen() {
  ui.title = h('h1', {});
  ui.badge = h('span', { class: 'badge' });
  ui.status = h('span', { class: 'status' });
  ui.bar = h('span');
  ui.progressText = h('span', { class: 'muted' });
  ui.groups = h('div', { class: 'groups' });
  ui.addName = h('input', {
    type: 'text',
    maxlength: '80',
    placeholder: 'מוצר חדש לרשימה',
    'aria-label': 'מוצר חדש לרשימה',
    autocomplete: 'off',
  });
  ui.add = h(
    'form',
    {
      class: 'add',
      onsubmit: (e) => {
        e.preventDefault();
        addItem();
      },
    },
    ui.addName,
    h('button', { type: 'submit', class: 'highlight' }, 'הוספה'),
  );
  ui.empty = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'הרשימה ריקה'),
    h('p', { class: 'muted' }, 'עוד לא נוסף כאן שום דבר.'),
  );
  ui.openGroups = ui.openGroups || {};

  show(
    brandline(),
    h('div', { class: 'row spread' }, ui.title, ui.badge),
    h('div', { class: 'row spread' }, ui.status, ui.progressText),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'התקדמות הקנייה' }, ui.bar),
    canEdit()
      ? ui.add
      : h(
          'p',
          { class: 'notice' },
          'יש לכם הרשאת צפייה בלבד: אפשר לראות את הרשימה, בלי לשנות אותה.',
        ),
    ui.groups,
    canEdit()
      ? h(
          'div',
          { class: 'card' },
          h('h2', {}, 'סיימתם לקנות?'),
          h('p', { class: 'muted' }, 'הקנייה תסתיים לכל המשתתפים והרשימה המשותפת תיסגר.'),
          h('button', { type: 'button', class: 'highlight', onclick: finishDialog }, 'סיום הקנייה'),
        )
      : null,
    h(
      'div',
      { class: 'card soft' },
      h('h2', {}, 'עוד מהרשימה'),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'secondary', onclick: copyList }, 'העתקת הרשימה'),
        h('button', { type: 'button', class: 'danger', onclick: leaveList }, 'יציאה מהרשימה'),
      ),
      h('p', { class: 'muted' }, 'הגישה נשמרת בדפדפן הזה. אחרי יציאה צריך הזמנה חדשה כדי לחזור.'),
    ),
  );
}

function paint() {
  const items = view.state.liveItems();
  ui.title.textContent = view.title;
  ui.badge.textContent = canEdit() ? 'אפשר לערוך' : 'צפייה בלבד';
  const got = items.filter((x) => x.done).length;
  ui.progressText.textContent = items.length ? `${got} מתוך ${items.length} נקנו` : '';
  ui.bar.style.width = items.length ? `${Math.round((got / items.length) * 100)}%` : '0%';
  paintStatus();
  const groups = groupItems(items);
  const nodes = groups.map((g) => groupNode(g));
  ui.groups.replaceChildren(...(nodes.length ? nodes : [ui.empty]));
}

function paintStatus() {
  const map = {
    synced: 'הכול שמור',
    saving: 'שומרים…',
    offline: 'אין חיבור, השינויים ימתינו',
    error: 'השמירה נכשלה, ננסה שוב',
  };
  ui.status.textContent = map[view.status];
  ui.status.className = `status ${view.status}`;
}

function groupNode(g) {
  // a category opens when the person opens it and stays that way; they start collapsed like in the app
  const open = ui.openGroups[g.id] === true;
  const d = h(
    'details',
    { class: 'cat', open: open || false },
    h('summary', {}, g.label, h('span', { class: 'count' }, `${g.got}/${g.total}`)),
    h(
      'div',
      { class: 'items' },
      g.open.map(itemNode),
      g.bought.length ? h('div', { class: 'sub' }, 'נקנו') : null,
      g.bought.map(itemNode),
    ),
  );
  d.addEventListener('toggle', () => {
    ui.openGroups[g.id] = d.open;
  });
  return d;
}

function itemNode(it) {
  const amount = it.qty && it.qty !== 1 ? `${it.qty}${it.unit ? ` ${it.unit}` : ''}` : '';
  const meta = [amount, it.note].filter(Boolean).join(' · ');
  const tick = h(
    'button',
    {
      type: 'button',
      class: 'tick',
      role: 'checkbox',
      'aria-checked': String(!!it.done),
      disabled: !canEdit(),
      onclick: () => change(it.id, { done: !it.done }),
    },
    h('span', { class: 'box', 'aria-hidden': 'true' }, it.done ? '✓' : ''),
    h(
      'span',
      {},
      h('span', { class: 'name' }, it.name),
      meta ? h('span', { class: 'meta' }, ` ${meta}`) : null,
    ),
  );
  return h(
    'div',
    { class: `item${it.done ? ' done' : ''}` },
    tick,
    canEdit()
      ? h(
          'button',
          {
            type: 'button',
            class: 'edit',
            'aria-label': `עריכת ${it.name}`,
            onclick: () => editDialog(it),
          },
          'עריכה',
        )
      : null,
  );
}

function addItem() {
  if (!canEdit()) return;
  const name = ui.addName.value.trim();
  if (!name) return;
  const dup = view.state.liveItems().find((x) => x.name.trim() === name);
  if (dup) {
    toast(`"${name}" כבר ברשימה`);
    ui.addName.value = '';
    return;
  }
  view.state.change('item', makeId('i'), newItemFields(name));
  ui.addName.value = '';
  changed();
}

function change(id, set) {
  if (!canEdit()) return;
  view.state.change('item', id, set);
  changed();
}

function changed() {
  paint();
  void flush();
}

function editDialog(it) {
  const name = h('input', { type: 'text', maxlength: '80', value: it.name, 'aria-label': 'שם' });
  const qty = h('input', {
    type: 'number',
    min: '0',
    step: 'any',
    value: String(it.qty ?? 1),
    inputmode: 'decimal',
  });
  const unit = h(
    'select',
    {},
    h('option', { value: '' }, 'ללא'),
    CATEGORY_DATA.units.map((u) => h('option', { value: u, selected: u === it.unit }, u)),
  );
  const note = h('input', { type: 'text', maxlength: '120', value: it.note || '' });
  const cat = h(
    'select',
    {},
    CATEGORY_DATA.categories.map((c) =>
      h('option', { value: c.id, selected: c.id === categoryOf(it) }, c.label),
    ),
  );
  const dlg = h(
    'dialog',
    { 'aria-label': 'עריכת מוצר' },
    h(
      'form',
      {
        method: 'dialog',
        onsubmit: (e) => {
          e.preventDefault();
          const nm = name.value.trim();
          if (!nm) return;
          const set = {};
          const q = Number(qty.value);
          if (nm !== it.name) set.name = nm.slice(0, 80);
          if (Number.isFinite(q) && q !== it.qty) set.qty = q;
          if (unit.value !== (it.unit || '')) set.unit = unit.value;
          if ((note.value.trim() || null) !== (it.note || null))
            set.note = note.value.trim() || null;
          if (cat.value !== categoryOf(it)) set.cat = cat.value;
          if (Object.keys(set).length) change(it.id, set);
          dlg.close();
        },
      },
      h('h2', {}, 'עריכת מוצר'),
      h('label', {}, 'שם', name),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'grow' }, 'כמות', qty),
        h('label', { class: 'grow' }, 'יחידה', unit),
      ),
      h('label', {}, 'הערה', note),
      h('label', {}, 'קטגוריה', cat),
      h(
        'div',
        { class: 'row spread' },
        h('button', { type: 'submit' }, 'שמירה'),
        h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'ביטול'),
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: () => {
              change(it.id, { deleted: true });
              dlg.close();
              toast(`${it.name} נמחק`, () => change(it.id, { deleted: false }));
            },
          },
          'מחיקה',
        ),
      ),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function copyList() {
  const text = listAsText(view.title, view.state.liveItems());
  try {
    await navigator.clipboard.writeText(text);
    toast('הרשימה הועתקה');
  } catch {
    toast('לא הצלחנו להעתיק');
  }
}

async function leaveList() {
  if (!window.confirm('לצאת מהרשימה? כדי לחזור תצטרכו הזמנה חדשה.')) return;
  try {
    await api.leave(view.listId);
  } catch (e) {
    // an owner cannot leave; any other failure leaves access as it was
    toast(friendlyError(e.message));
    return;
  }
  stopPolling();
  put(LIST_KEY, null);
  api.signOut();
  show(
    brandline(),
    h('h1', {}, 'יצאתם מהרשימה'),
    h('p', { class: 'muted' }, 'הגישה בדפדפן הזה הוסרה.'),
  );
}

// --- the end of the shopping ----------------------------------------------------------------------------------------
function finishDialog() {
  const store = h('input', {
    type: 'text',
    maxlength: '80',
    placeholder: 'שם החנות או הרשת',
    'aria-label': 'איפה קניתם?',
  });
  const total = h('input', {
    type: 'text',
    inputmode: 'decimal',
    placeholder: 'סכום בשקלים',
    'aria-label': 'כמה יצא בסוף?',
  });
  const err = h('p', { class: 'notice', role: 'alert', hidden: true });
  const go = h('button', { type: 'submit' }, 'לסיים את הקנייה');
  const dlg = h(
    'dialog',
    { 'aria-label': 'סיום הקנייה' },
    h(
      'form',
      {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const typed = total.value.trim();
          const agorot = typed ? parseShekels(typed) : null;
          if (typed && agorot === null) {
            err.textContent = 'הסכום לא נראה תקין. כתבו מספר, למשל 245.90, או השאירו ריק.';
            err.hidden = false;
            return;
          }
          go.disabled = true;
          try {
            await api.finish(view.listId, store.value.trim().slice(0, 80), agorot);
            dlg.close();
            await pull();
            showFinished(true);
          } catch (error) {
            go.disabled = false;
            if (/list finished|already finished/i.test(error.message)) {
              dlg.close();
              await pull();
              return showFinished();
            }
            err.textContent = friendlyError(error.message);
            err.hidden = false;
          }
        },
      },
      h('h2', {}, 'סיום הקנייה'),
      h(
        'p',
        { class: 'muted' },
        'כל המשתתפים יקבלו הודעה, והרשימה המשותפת תיסגר ולא תהיה זמינה יותר.',
      ),
      h('label', {}, 'איפה קניתם?', store),
      h('label', {}, 'כמה יצא בסוף?', total),
      err,
      h(
        'div',
        { class: 'row spread' },
        go,
        h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'ביטול'),
      ),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/** The end of the shared shopping: who, where, how much; keep the list as a message, then the session closes. */
function showFinished(mine = false) {
  stopPolling();
  const info = finishedOf(view.state.list);
  const text = finishedAsText(view.title, view.state.liveItems(), info);
  const shareText = async () => {
    try {
      if (navigator.share) return await navigator.share({ text });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  };
  show(
    brandline(),
    h('h1', {}, 'הקנייה הסתיימה'),
    h('p', {}, finishedSentence(info, mine)),
    h(
      'p',
      { class: 'muted' },
      'אחרי האישור הרשימה המשותפת תיסגר ולא תהיה זמינה יותר. אפשר לשמור את הרשימה בהודעה לפני כן.',
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'button',
        { type: 'button', class: 'secondary', onclick: () => void shareText() },
        'שמירה בהודעה (וואטסאפ ועוד)',
      ),
      h(
        'button',
        { type: 'button', class: 'secondary', onclick: copyFinished(text) },
        'העתקת הרשימה',
      ),
    ),
    h(
      'button',
      { type: 'button', class: 'highlight', onclick: () => void closeSession() },
      'אישור וסגירה',
    ),
  );
}

function copyFinished(text) {
  return async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('הרשימה הועתקה');
    } catch {
      toast('לא הצלחנו להעתיק');
    }
  };
}

async function closeSession() {
  try {
    await api.leave(view.listId);
  } catch {
    // the host's list stays on the server until deleted; either way this browser is done with it
  }
  put(LIST_KEY, null);
  api.signOut();
  view.listId = null;
  show(
    brandline(),
    h('h1', {}, 'הרשימה המשותפת נסגרה'),
    h('p', { class: 'muted' }, 'הגישה בדפדפן הזה הוסרה. תודה שקניתם יחד!'),
  );
}

// --- sync ------------------------------------------------------------------------------------------------------------
async function flush() {
  if (view.flushing || !view.state.pending.length) {
    if (!view.state.pending.length && view.status !== 'synced') setStatus('synced');
    return;
  }
  view.flushing = true;
  setStatus('saving');
  try {
    while (view.state.pending.length) {
      const batch = view.state.pending.slice(0, BATCH);
      await api.apply(view.listId, batch);
      view.state.pending = view.state.pending.filter((o) => !batch.includes(o));
    }
    setStatus('synced');
  } catch (e) {
    if (/read-only/i.test(e.message)) {
      view.role = 'viewer';
      view.state.pending = [];
      buildListScreen();
      paint();
      toast(friendlyError(e.message));
    } else if (/list finished/i.test(e.message)) {
      // somebody ended the shopping while this change was waiting: read how it ended
      view.state.pending = [];
      void tick();
    } else if (/list not found/i.test(e.message)) {
      stopPolling();
      put(LIST_KEY, null);
      show(
        brandline(),
        h('h1', {}, 'אין לכם יותר גישה לרשימה'),
        h('p', { class: 'muted' }, friendlyError(e.message)),
      );
    } else {
      setStatus(e.code === 'network' ? 'offline' : 'error');
    }
  } finally {
    view.flushing = false;
  }
}

function setStatus(next) {
  view.status = next;
  if (ui.status) paintStatus();
}

async function tick() {
  if (document.hidden) return;
  try {
    await flush();
    const data = await api.load(view.listId);
    const roleChanged = data.role !== view.role;
    view.role = data.role;
    const any = view.state.receiveRows(data.ops ?? []);
    view.title = view.state.list.title || data.title || view.title;
    if (finishedOf(view.state.list)) return showFinished();
    if (roleChanged) buildListScreen();
    if (any || roleChanged) paint();
    if (!view.state.pending.length) setStatus('synced');
  } catch (e) {
    if (/list not found/i.test(e.message)) {
      stopPolling();
      put(LIST_KEY, null);
      show(
        brandline(),
        h('h1', {}, 'אין לכם יותר גישה לרשימה'),
        h('p', { class: 'muted' }, friendlyError(e.message)),
      );
    } else {
      setStatus(e.code === 'network' ? 'offline' : 'error');
    }
  }
}

function startPolling() {
  stopPolling();
  view.pollId = setInterval(() => void tick(), POLL_MS);
}
function stopPolling() {
  clearInterval(view.pollId);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && view.listId) void tick();
});
window.addEventListener('online', () => view.listId && void tick());

// --- start -----------------------------------------------------------------------------------------------------------
if (!api.configured) screenNotConfigured();
else if (token) screenReady();
else if (saved?.listId) void resume();
else screenNoToken();
