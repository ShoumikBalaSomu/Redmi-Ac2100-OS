/**
 * dom.js — tiny DOM helpers
 * ==========================
 * Deliberately minimal. The reason this exists at all, rather than using
 * innerHTML, is security: this dashboard renders data that originates from the
 * network — DHCP hostnames, mDNS names, NetFlow-derived strings, vendor OUI
 * text from a downloaded database. Any of those can contain markup. Assigning
 * them via innerHTML is a stored-XSS vulnerability on a device whose web UI is
 * reachable from the LAN, and on a router that is a serious one: XSS there
 * means an attacker can reconfigure the network or read the admin session.
 *
 * So every helper below creates text nodes through the DOM API, never by
 * string interpolation. `h()` is the only sanctioned way to build markup.
 */

/**
 * Create an element.
 *
 * @param {string} tag
 * @param {object|Array|string|null} [props] attributes/props, or children when
 *        an array/string is passed. A `ref` key may hold a callback that
 *        receives the created element; it is invoked once, after other props.
 * @param {...(Node|string|Array|number|null|undefined)} children
 * @returns {HTMLElement}
 *
 * Examples:
 *   h('div')                                  -> <div></div>
 *   h('div', 'text')                          -> <div>text</div>
 *   h('div', ['a', 'b'])                      -> <div>ab</div>
 *   h('span', { class: 'badge' }, 'OK')       -> <span class="badge">OK</span>
 *   h('input', { type: 'text', value: v })    -> property assignment for value
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);

  // Allow h(tag, children) without a props object.
  let kids = children;
  if (props !== null && props !== undefined) {
    if (Array.isArray(props) || typeof props === 'string' || typeof props === 'number' ||
        props instanceof Node) {
      kids = [props, ...children];
    } else {
      applyProps(el, props);
    }
  }

  append(el, kids);
  return el;
}

/** Attributes vs properties: `value`, `checked`, `disabled` must be properties. */
const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'textContent', 'innerHTML']);

function applyProps(el, props) {
  for (const [key, val] of Object.entries(props)) {
    // `ref` is not an attribute: it hands the created element back to the
    // caller so canvas-based widgets can be drawn into after mount. It is
    // invoked after all other props are applied, and only once per element.
    if (key === 'ref') {
      if (typeof val === 'function') val(el);
      continue;
    }

    if (val === undefined || val === null || val === false) {
      // Explicitly clear boolean attributes that are false, so re-rendering a
      // node does not leave a stale `disabled` behind.
      if (key === 'disabled' || key === 'checked' || key === 'selected') el[key] = false;
      else if (key.startsWith('data-') || key.startsWith('aria-')) el.removeAttribute(key);
      continue;
    }

    if (key === 'class' || key === 'className') {
      el.className = Array.isArray(val) ? val.filter(Boolean).join(' ') : String(val);
    } else if (key === 'style' && typeof val === 'object') {
      Object.assign(el.style, val);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, val);
    } else if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (PROPERTY_KEYS.has(key)) {
      el[key] = val;
    } else {
      el.setAttribute(key, val === true ? '' : String(val));
    }
  }
}

/** Append a heterogeneous list of children, tolerating null/undefined/arrays. */
function append(parent, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue;
    parent.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

/**
 * Mount content into a container, replacing whatever was there.
 * @param {HTMLElement} container
 * @param {...(Node|string|Array|number|null)} children
 */
export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
  return container;
}

/** Shorthand for a text node. Makes intent explicit at call sites. */
export const t = (s) => document.createTextNode(s ?? '');

/** Find within a root, defaulting to document. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Instantiate a <template> by id and return its first element. */
export function fromTemplate(id) {
  const tpl = document.getElementById(id);
  if (!tpl) throw new Error(`missing template #${id}`);
  return tpl.content.firstElementChild.cloneNode(true);
}

// ── Component helpers ───────────────────────────────────────────────────────

/**
 * A confidence badge. This is a core honesty mechanism in the UI, not
 * decoration: most published router throughput figures come from single
 * anecdotal forum reports, and presenting them as fact leads people to make
 * wrong decisions about their own network.
 *
 * @param {'confirmed'|'anecdotal'|'indicative'|'info'|'warn'|'err'|'neutral'} kind
 * @param {string} label
 * @param {string} [title] tooltip with the source or caveat
 */
export function badge(kind, label, title) {
  const map = {
    confirmed:  'badge--ok badge--confirmed',
    anecdotal:  'badge--warn badge--anecdotal',
    indicative: 'badge--warn',
    info:       'badge--info',
    warn:       'badge--warn',
    err:        'badge--err',
    ok:         'badge--ok',
    neutral:    'badge--neutral',
  };
  return h('span', { class: ['badge', map[kind] ?? map.neutral], ...(title ? { title } : {}) }, label);
}

/** A card with title, optional note and body content. */
export function card({ title, note, body, foot, variant, headExtra }) {
  const el = h('section', { class: ['card', variant && `card--${variant}`] });
  const head = h('header', { class: 'card__head' },
    h('div', {}, title ? h('h2', { class: 'card__title' }, title) : null,
                 note ? h('p', { class: 'card__note' }, note) : null),
    headExtra ?? null);
  el.appendChild(head);
  el.appendChild(h('div', { class: 'card__body' }, body));
  if (foot) el.appendChild(h('div', { class: 'card__foot' }, foot));
  return el;
}

/** A big-number metric tile. */
export function metric({ label, value, unit, sub, variant }) {
  return h('div', { class: ['metric', variant && `metric--${variant}`] },
    h('div', { class: 'metric__k' }, label),
    h('div', { class: 'metric__v' },
      String(value ?? '—'),
      unit ? h('span', { class: 'metric__u' }, unit) : null),
    sub ? h('div', { class: 'metric__s' }, sub) : null);
}

/** A key/value grid. Pass an array of [key, valueNode] pairs. */
export function kv(rows) {
  return h('div', { class: 'kv' },
    rows.filter(Boolean).map(([k, v]) =>
      h('div', { class: 'kv__row' },
        h('div', { class: 'kv__k' }, k),
        h('div', { class: 'kv__v' }, v))));
}

/**
 * A data table.
 * @param {Array<{key:string,label:string,num?:boolean,render?:(row:any)=>Node|string}>} cols
 * @param {Array<object>} rows
 * @param {string} [emptyText]
 */
export function table(cols, rows, emptyText = 'No data.') {
  if (!rows || !rows.length) {
    return h('div', { class: 'empty' },
      h('span', { class: 'empty__ico', 'aria-hidden': 'true' }, '∅'), emptyText);
  }
  const head = h('tr', {}, cols.map(c => h('th', { class: c.num ? 'n' : null }, c.label)));
  const body = rows.map(row => h('tr', {}, cols.map(c => {
    const content = c.render ? c.render(row) : row[c.key];
    return h('td', { class: c.num ? 'n' : null },
      content instanceof Node ? content : String(content ?? '—'));
  })));
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table' },
      h('thead', {}, head),
      h('tbody', {}, body)));
}

/** A callout box for warnings and explanations. */
export function callout(kind, icon, ...content) {
  return h('div', { class: ['callout', `callout--${kind}`], role: kind === 'err' ? 'alert' : null },
    h('span', { class: 'callout__ico', 'aria-hidden': 'true' }, icon),
    h('div', {}, content));
}

/** A labelled toggle bound to a boolean. */
export function toggle({ label, checked, disabled, hint, onChange }) {
  const input = h('input', {
    type: 'checkbox',
    checked: !!checked,
    disabled: !!disabled,
    onchange: (e) => onChange?.(e.target.checked),
  });
  return h('label', { class: 'toggle', title: hint ?? null },
    input,
    h('span', { class: 'toggle__track' }, h('span', { class: 'toggle__thumb' })),
    h('span', { class: 'toggle__label' }, label,
      hint ? h('span', { class: 'field__hint', style: { display: 'block' } }, hint) : null));
}

/** A horizontal meter bar. */
export function bar(pct, variant) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return h('div', { class: 'bar', role: 'progressbar',
                    'aria-valuenow': String(Math.round(p)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('div', { class: ['bar__fill', variant && `bar__fill--${variant}`], style: { width: `${p}%` } }));
}

/** Skeleton placeholder rows for loading states. */
export function skeleton(lines = 3) {
  return h('div', { class: 'stack', style: { gap: 'var(--sp-2)' } },
    Array.from({ length: lines }, (_, i) =>
      h('div', { class: 'skel', style: { height: '0.9rem', width: `${92 - i * 13}%` } })));
}

/** Empty-state block. */
export function empty(icon, text) {
  return h('div', { class: 'empty' },
    h('span', { class: 'empty__ico', 'aria-hidden': 'true' }, icon), text);
}
