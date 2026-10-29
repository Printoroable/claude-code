'use strict';

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PALETTE = ['#3eb370', '#2f9bdc', '#f5a623', '#e9546b', '#9b59b6', '#1abc9c', '#ff7f50', '#607d8b', '#f06292', '#8bc34a', '#3f51b5', '#795548'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const REPEAT_LABELS = { none: 'Nie', daily: 'Täglich', weekly: 'Wöchentlich', monthly: 'Monatlich', yearly: 'Jährlich' };
const DAY = 86400000;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Datumswerte werden als "YYYY-MM-DD" gehandhabt und intern als UTC gerechnet.
const toMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => fromMs(toMs(d) + n * DAY);
const diffDays = (a, b) => Math.round((toMs(a) - toMs(b)) / DAY);
const weekdayMon = (d) => (new Date(toMs(d)).getUTCDay() + 6) % 7; // 0 = Montag
function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function nowTime() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
}
const fmt = (d, opts) => new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', ...opts }).format(new Date(toMs(d)));
const initials = (name) => (name || '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

// Bundesweite gesetzliche Feiertage in Deutschland
const holidayCache = new Map();
function holidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  // Ostersonntag (Gauß/Anonymer gregorianischer Algorithmus)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const map = new Map([
    [`${year}-01-01`, 'Neujahr'],
    [addDays(easter, -2), 'Karfreitag'],
    [easter, 'Ostersonntag'],
    [addDays(easter, 1), 'Ostermontag'],
    [`${year}-05-01`, 'Tag der Arbeit'],
    [addDays(easter, 39), 'Christi Himmelfahrt'],
    [addDays(easter, 49), 'Pfingstsonntag'],
    [addDays(easter, 50), 'Pfingstmontag'],
    [`${year}-10-03`, 'Tag der Deutschen Einheit'],
    [`${year}-12-24`, 'Heiligabend'],
    [`${year}-12-25`, '1. Weihnachtstag'],
    [`${year}-12-26`, '2. Weihnachtstag'],
    [`${year}-12-31`, 'Silvester'],
  ]);
  holidayCache.set(year, map);
  return map;
}
const holidayName = (d) => holidays(+d.slice(0, 4)).get(d);

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('fp:' + key));
    localStorage.setItem('fp:' + key, JSON.stringify(value));
  } catch { /* privater Modus o. ä. */ }
  return undefined;
}

// ---------------------------------------------------------------------------
// Zustand & API
// ---------------------------------------------------------------------------

const state = {
  settings: {},
  members: [],
  calendars: [],
  events: [],
  memos: [],
  view: 'calendar',
  month: todayStr().slice(0, 7),
  selected: todayStr(),
  hidden: new Set(store('hiddenCalendars') || []),
  me: store('me') || null,
};

async function api(method, url, body) {
  const res = await fetch('api/' + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin();
    throw new Error(data.error || 'Bitte anmelden');
  }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

async function uploadFile(eventId, file) {
  const maxMb = state.settings.max_upload_mb || 25;
  if (file.size > maxMb * 1024 * 1024) throw new Error(`„${file.name}“ ist zu groß (max. ${maxMb} MB)`);
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Filename': encodeURIComponent(file.name || 'Dokument'),
  };
  if (state.me) headers['X-Member-Id'] = String(state.me);
  const res = await fetch(`api/events/${eventId}/attachments`, { method: 'POST', headers, body: file, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error('Bitte anmelden'); }
  if (!res.ok) throw new Error(data.error || `Upload fehlgeschlagen (${res.status})`);
  return data;
}

async function uploadAll(eventId, files) {
  let ok = 0;
  for (const f of files) {
    toast(`Lade „${f.name}“ hoch …`);
    if (await guarded(() => uploadFile(eventId, f))) ok++;
  }
  if (ok) toast(ok === 1 ? 'Dokument hinzugefügt' : `${ok} Dokumente hinzugefügt`);
  return ok;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
function fileIcon(mime, name) {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return '📕';
  if (/word|\.docx?$/i.test(mime + name)) return '📘';
  if (/sheet|excel|\.xlsx?$|\.csv$/i.test(mime + name)) return '📗';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('text/')) return '📝';
  return '📄';
}
const PREVIEW_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message);
    return undefined;
  }
}

const memberById = (id) => state.members.find((m) => m.id === id);
const calendarById = (id) => state.calendars.find((c) => c.id === id);
function eventColor(ev) {
  if (ev.color) return ev.color;
  const first = ev.member_ids.map(memberById).find(Boolean);
  if (first) return first.color;
  return calendarById(ev.calendar_id)?.color || PALETTE[0];
}
const visibleEvents = () => state.events.filter((e) => !state.hidden.has(e.calendar_id));

function avatarsHtml(ids, cls = '') {
  return `<span class="avatars">${ids.map(memberById).filter(Boolean).map((m) =>
    `<span class="avatar ${cls}" style="background:${m.color}" title="${esc(m.name)}">${esc(initials(m.name))}</span>`).join('')}</span>`;
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

function monthRange() {
  const first = state.month + '-01';
  const start = addDays(first, -weekdayMon(first));
  const nextMonth = fromMs(Date.UTC(+state.month.slice(0, 4), +state.month.slice(5, 7), 1));
  const lastDay = addDays(nextMonth, -1);
  const end = addDays(lastDay, 6 - weekdayMon(lastDay));
  return { start, end };
}

async function loadBootstrap() {
  const data = await api('GET', 'bootstrap');
  state.settings = data.settings;
  state.members = data.members;
  state.calendars = data.calendars;
  if (state.me && !memberById(state.me)) state.me = null;
}

async function loadEvents() {
  const { start, end } = monthRange();
  // Für die Listenansicht laden wir zusätzlich die nächsten 60 Tage ab heute.
  const from = start < todayStr() ? start : todayStr();
  const listEnd = addDays(todayStr(), 60);
  const to = end > listEnd ? end : listEnd;
  state.events = await api('GET', `events?from=${from}T00:00&to=${to}T23:59`);
}

async function loadMemos() {
  state.memos = await api('GET', 'memos');
}

async function reloadAll() {
  await loadBootstrap();
  await Promise.all([loadEvents(), loadMemos()]);
  renderAll();
}

// ---------------------------------------------------------------------------
// Darstellung: Kalender
// ---------------------------------------------------------------------------

function renderHeader() {
  $('#familyName').textContent = state.settings.family_name || '';
  const [y, m] = state.month.split('-');
  $('#monthLabel').textContent = `${fmt(state.month + '-01', { month: 'long' })} ${y}`;
  $('#monthLabel').dataset.m = m;
  document.title = `${state.settings.family_name || 'Familienplaner'} – Familienplaner`;
}

function eventDays(ev) {
  return { s: ev.start.slice(0, 10), e: ev.end.slice(0, 10) };
}

function renderMonth() {
  $('#weekdays').innerHTML = WEEKDAYS.map((d, i) => `<div class="${i === 5 ? 'sat' : i === 6 ? 'sun' : ''}">${d}</div>`).join('');

  const { start, end } = monthRange();
  const today = todayStr();
  const weeks = [];
  for (let w = start; w <= end; w = addDays(w, 7)) weeks.push(w);

  const container = $('#weeks');
  container.innerHTML = weeks.map((ws) => {
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const cls = ['day'];
      if (d.slice(0, 7) !== state.month) cls.push('other');
      if (i === 5) cls.push('sat');
      if (i === 6) cls.push('sun');
      if (holidayName(d)) cls.push('holiday');
      if (d === today) cls.push('today');
      if (d === state.selected) cls.push('selected');
      cells += `<button class="${cls.join(' ')}" data-date="${d}" title="${esc(holidayName(d) || '')}"><span class="num">${+d.slice(8)}</span><span class="more"></span></button>`;
    }
    return `<div class="week" data-start="${ws}">${cells}<div class="bars"></div></div>`;
  }).join('');

  layoutBars();
}

// Termine als Balken über die Wochenzeilen legen (wie bei TimeTree).
function layoutBars() {
  const events = visibleEvents();
  const wide = window.matchMedia('(min-width: 900px)').matches;
  const laneH = wide ? 20 : 17;

  for (const weekEl of $$('#weeks .week')) {
    const ws = weekEl.dataset.start;
    const we = addDays(ws, 6);
    const barsEl = $('.bars', weekEl);
    const maxLanes = Math.max(1, Math.floor(barsEl.clientHeight / laneH));

    const segs = events
      .map((ev) => {
        const { s, e } = eventDays(ev);
        if (e < ws || s > we) return null;
        const multi = s !== e;
        return {
          ev,
          from: Math.max(0, diffDays(s, ws)),
          to: Math.min(6, diffDays(e, ws)),
          contLeft: s < ws,
          contRight: e > we,
          solid: ev.all_day || multi,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || (b.solid - a.solid) || (a.ev.start < b.ev.start ? -1 : 1));

    // Jedem Termin die erste freie Spur geben.
    const lanes = [];
    for (const seg of segs) {
      let lane = lanes.findIndex((occ) => occ.every((x, i) => i < seg.from || i > seg.to || !x));
      if (lane === -1) { lane = lanes.length; lanes.push(new Array(7).fill(false)); }
      for (let i = seg.from; i <= seg.to; i++) lanes[lane][i] = true;
      seg.lane = lane;
    }
    // Passt nicht alles, bleibt die letzte Spur für „+n“ frei.
    const shown = lanes.length <= maxLanes ? maxLanes : maxLanes - 1;

    const hiddenPerDay = new Array(7).fill(0);
    let html = '';
    for (const seg of segs) {
      const lane = seg.lane;
      if (lane >= shown) {
        for (let i = seg.from; i <= seg.to; i++) hiddenPerDay[i]++;
        continue;
      }
      const c = eventColor(seg.ev);
      const cls = ['bar'];
      if (!seg.solid) cls.push('timed');
      if (seg.contLeft) cls.push('cont-left');
      if (seg.contRight) cls.push('cont-right');
      const left = (seg.from / 7) * 100;
      const width = ((seg.to - seg.from + 1) / 7) * 100;
      html += `<div class="${cls.join(' ')}" data-key="${seg.ev.id}|${seg.ev.occurrence}" style="--c:${c};background:${c};top:${lane * laneH}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px)">${esc(seg.ev.title)}</div>`;
    }
    barsEl.innerHTML = html;

    $$('.day', weekEl).forEach((cell, i) => {
      $('.more', cell).textContent = hiddenPerDay[i] ? `+${hiddenPerDay[i]}` : '';
    });
  }
}

function eventsOnDay(d) {
  return visibleEvents()
    .filter((ev) => { const { s, e } = eventDays(ev); return s <= d && e >= d; })
    .sort((a, b) => (b.all_day - a.all_day) || (a.start < b.start ? -1 : 1));
}

function timeLabel(ev, day) {
  const { s, e } = eventDays(ev);
  if (ev.all_day) return s === e ? 'Ganztägig' : 'Ganztägig<br>' + (s === day ? 'Beginn' : e === day ? 'Ende' : '');
  const st = ev.start.slice(11), en = ev.end.slice(11);
  if (s === e) return `${st}<br>${en}`;
  if (day === s) return `${st}<br>→`;
  if (day === e) return `→<br>${en}`;
  return 'ganzer Tag';
}

function eventItemHtml(ev, day) {
  const cal = calendarById(ev.calendar_id);
  const meta = [];
  if (ev.location) meta.push(`📍 ${esc(ev.location)}`);
  if (ev.repeat !== 'none') meta.push(`🔁 ${REPEAT_LABELS[ev.repeat]}`);
  if (ev.comment_count) meta.push(`💬 ${ev.comment_count}`);
  if (ev.attachment_count) meta.push(`📎 ${ev.attachment_count}`);
  if (state.calendars.length > 1 && cal) meta.push(esc(cal.name));
  return `<li class="event-item" data-key="${ev.id}|${ev.occurrence}" style="--c:${eventColor(ev)}">
    <span class="stripe"></span>
    <span class="time">${timeLabel(ev, day)}</span>
    <span class="body">
      <div class="title">${esc(ev.title)}</div>
      <div class="meta">${avatarsHtml(ev.member_ids)}${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    </span>
  </li>`;
}

function renderDayPanel() {
  const d = state.selected;
  $('#dayPanelDate').textContent = fmt(d, { day: 'numeric', month: 'long' });
  const hol = holidayName(d);
  $('#dayPanelWeekday').textContent = fmt(d, { weekday: 'long' }) + ', ' + d.slice(0, 4) + (hol ? ` · ${hol}` : '');
  const list = eventsOnDay(d);
  $('#dayEvents').innerHTML = list.length
    ? list.map((ev) => eventItemHtml(ev, d)).join('')
    : '<li class="empty">Keine Termine. Tippe auf „+ Termin“, um einen anzulegen.</li>';
}

// ---------------------------------------------------------------------------
// Darstellung: Liste, Notizen, Familie
// ---------------------------------------------------------------------------

function renderUpcoming() {
  const today = todayStr();
  const until = addDays(today, 60);
  const groups = [];
  for (let d = today; d <= until; d = addDays(d, 1)) {
    const evs = eventsOnDay(d).filter((ev) => ev.start.slice(0, 10) === d || d === today);
    if (evs.length) groups.push({ d, evs });
  }
  $('#upcoming').innerHTML = groups.length
    ? groups.map(({ d, evs }) => `<div class="date-group">
        <h4 class="${d === today ? 'today' : ''}">${d === today ? 'Heute · ' : d === addDays(today, 1) ? 'Morgen · ' : ''}${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}${holidayName(d) ? ' · ' + esc(holidayName(d)) : ''}</h4>
        <ul class="event-list">${evs.map((ev) => eventItemHtml(ev, d)).join('')}</ul>
      </div>`).join('')
    : '<div class="empty">In den nächsten 60 Tagen steht nichts an. 🎉</div>';
}

function renderMemos() {
  $('#memoGrid').innerHTML = state.memos.length
    ? state.memos.map((m) => {
      const open = m.items.filter((i) => !i.done);
      const preview = m.items.length
        ? open.slice(0, 4).map((i) => '☐ ' + i.text).join('\n') + (open.length > 4 ? '\n…' : '')
        : m.note;
      return `<button class="memo-card" data-memo="${m.id}">
        <div class="memo-title">${m.pinned ? '📌 ' : ''}${esc(m.title)}</div>
        <div class="memo-preview">${esc(preview || 'Leer')}</div>
        <div class="memo-meta">${m.items.length ? `${m.items.length - open.length}/${m.items.length} erledigt` : ''}</div>
      </button>`;
    }).join('')
    : '<div class="empty">Noch keine Notizen.</div>';
}

function renderFamily() {
  $('#familyNameInput').value = state.settings.family_name || '';
  $('#meSelect').innerHTML = '<option value="">– bitte wählen –</option>' +
    state.members.map((m) => `<option value="${m.id}" ${m.id === state.me ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

  $('#memberList').innerHTML = state.members.length
    ? state.members.map((m) => `<li>
        <span class="avatar lg" style="background:${m.color}">${esc(initials(m.name))}</span>
        <span class="name">${esc(m.name)}${m.id === state.me ? ' <span class="muted">(ich)</span>' : ''}</span>
        <span class="actions"><button class="link-btn" data-edit-member="${m.id}">Bearbeiten</button></span>
      </li>`).join('')
    : '<li class="muted">Noch keine Mitglieder – lege zuerst die Familie an.</li>';

  $('#calendarList').innerHTML = state.calendars.map((c) => `<li>
      <span class="swatch" style="--c:${c.color}"></span>
      <span class="name">${esc(c.name)}</span>
      <label class="switch" style="width:auto" title="Im Kalender anzeigen">
        <input type="checkbox" data-toggle-cal="${c.id}" ${state.hidden.has(c.id) ? '' : 'checked'}>
      </label>
      <span class="actions"><button class="link-btn" data-edit-cal="${c.id}">Bearbeiten</button></span>
    </li>`).join('');
}

function renderAll() {
  renderHeader();
  renderMonth();
  renderDayPanel();
  renderUpcoming();
  renderMemos();
  renderFamily();
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openModal(html, onMount) {
  dropHandler = null;
  $('#modalSheet').innerHTML = html;
  $('#modal').classList.remove('hidden');
  onMount?.($('#modalSheet'));
  const first = $('#modalSheet [autofocus]');
  if (first && window.matchMedia('(min-width: 900px)').matches) first.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalSheet').innerHTML = '';
  modalContext = null;
  dropHandler = null;
}
let modalContext = null;

function swatchesHtml(selected, { allowAuto = false } = {}) {
  return `<div class="swatches">${allowAuto ? `<button type="button" class="swatch-btn auto ${!selected ? 'active' : ''}" data-color="" title="Automatisch (Farbe der Person)"></button>` : ''}${PALETTE.map((c) =>
    `<button type="button" class="swatch-btn ${c === selected ? 'active' : ''}" data-color="${c}" style="--c:${c}"></button>`).join('')}</div>`;
}
function bindSwatches(root, onPick) {
  // An die Farbleiste selbst binden: das Modal-Element wird wiederverwendet.
  $$('.swatches', root).forEach((el) => el.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch-btn');
    if (!btn) return;
    $$('.swatch-btn', btn.parentElement).forEach((b) => b.classList.toggle('active', b === btn));
    onPick(btn.dataset.color || null);
  }));
}

// ---------- Termin: Detailansicht ----------

async function openEventDetail(key) {
  const [idStr, occurrence] = key.split('|');
  const occ = state.events.find((e) => String(e.id) === idStr && e.occurrence === occurrence)
    || await guarded(() => api('GET', `events/${idStr}`));
  if (!occ) return;
  modalContext = { type: 'event', id: occ.id };
  const cal = calendarById(occ.calendar_id);
  const { s, e } = eventDays(occ);
  let when;
  if (occ.all_day) {
    when = s === e ? fmt(s, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · ganztägig'
      : `${fmt(s, { day: 'numeric', month: 'short' })} – ${fmt(e, { day: 'numeric', month: 'short', year: 'numeric' })} · ganztägig`;
  } else {
    when = s === e
      ? `${fmt(s, { weekday: 'long', day: 'numeric', month: 'long' })}<br>${occ.start.slice(11)} – ${occ.end.slice(11)} Uhr`
      : `${fmt(s, { day: 'numeric', month: 'short' })}, ${occ.start.slice(11)} – ${fmt(e, { day: 'numeric', month: 'short' })}, ${occ.end.slice(11)} Uhr`;
  }
  const creator = memberById(occ.created_by);

  openModal(`
    <div class="sheet-head">
      <button class="link-btn" data-close>Schließen</button>
      <button class="pill-btn small" id="editEventBtn">Bearbeiten</button>
    </div>
    <div class="detail-head" style="--c:${eventColor(occ)}">
      <span class="stripe"></span>
      <div><h2>${esc(occ.title)}</h2><div class="muted">${esc(cal?.name || '')}${creator ? ` · erstellt von ${esc(creator.name)}` : ''}</div></div>
    </div>
    <div class="detail-row"><span class="ico">🕒</span><span>${when}</span></div>
    ${occ.repeat !== 'none' ? `<div class="detail-row"><span class="ico">🔁</span><span>${REPEAT_LABELS[occ.repeat]}${occ.repeat_until ? ' bis ' + fmt(occ.repeat_until, { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</span></div>` : ''}
    ${occ.location ? `<div class="detail-row"><span class="ico">📍</span><a href="https://www.openstreetmap.org/search?query=${encodeURIComponent(occ.location)}" target="_blank" rel="noopener">${esc(occ.location)}</a></div>` : ''}
    ${occ.member_ids.length ? `<div class="detail-row"><span class="ico">👥</span><span>${occ.member_ids.map(memberById).filter(Boolean).map((m) => esc(m.name)).join(', ')}</span></div>` : ''}
    ${occ.note ? `<div class="detail-row"><span class="ico">📝</span><span class="detail-note">${esc(occ.note)}</span></div>` : ''}
    <div class="divider"></div>
    <div class="section-head" style="margin:0">
      <h3>Dokumente</h3>
      <label class="pill-btn small ghost file-btn">+ Hinzufügen<input type="file" id="attachInput" multiple hidden></label>
    </div>
    <div class="attachments" id="attachments"><div class="muted">Lädt …</div></div>
    <div class="divider"></div>
    <h3 style="margin:0">Kommentare</h3>
    <div class="comments" id="comments"><div class="muted">Lädt …</div></div>
    <form class="comment-form" id="commentForm">
      <input id="commentInput" placeholder="${state.me ? 'Kommentar schreiben …' : 'Erst unter „Familie“ auswählen, wer du bist'}" maxlength="2000" autocomplete="off">
      <button class="pill-btn" type="submit">Senden</button>
    </form>
  `, (root) => {
    $('#editEventBtn', root).onclick = () => guarded(async () => openEventEditor(await api('GET', `events/${occ.id}`)));
    $('#commentForm', root).onsubmit = (e) => {
      e.preventDefault();
      const input = $('#commentInput', root);
      const textValue = input.value.trim();
      if (!textValue) return;
      guarded(async () => {
        await api('POST', `events/${occ.id}/comments`, { text: textValue, member_id: state.me });
        input.value = '';
        await loadComments(occ.id);
      });
    };
    $('#attachInput', root).onchange = async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      await uploadAll(occ.id, files);
      await loadAttachments(occ.id);
    };
    bindDropZone(root, async (files) => { await uploadAll(occ.id, files); await loadAttachments(occ.id); });
    loadComments(occ.id);
    loadAttachments(occ.id);
  });
}

// Dateien per Drag & Drop ins offene Fenster ziehen (Desktop).
// Die Listener werden einmalig in bindEvents() registriert.
let dropHandler = null;
function bindDropZone(root, onFiles) {
  dropHandler = onFiles;
}
function installDropZone() {
  const sheet = $('#modalSheet');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  sheet.addEventListener('dragover', (e) => {
    if (!dropHandler || !hasFiles(e)) return;
    e.preventDefault();
    sheet.classList.add('dropping');
  });
  sheet.addEventListener('dragleave', (e) => { if (!sheet.contains(e.relatedTarget)) sheet.classList.remove('dropping'); });
  sheet.addEventListener('drop', (e) => {
    sheet.classList.remove('dropping');
    if (!dropHandler) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) dropHandler(files);
  });
}

async function loadAttachments(eventId) {
  const list = await guarded(() => api('GET', `events/${eventId}/attachments`));
  const el = $('#attachments');
  if (!list || !el) return;
  el.innerHTML = list.length
    ? list.map((a) => {
      const m = memberById(a.member_id);
      const url = `api/attachments/${a.id}`;
      const thumb = PREVIEW_IMAGES.includes(a.mime)
        ? `<img class="att-thumb" src="${url}" alt="" loading="lazy">`
        : `<span class="att-icon">${fileIcon(a.mime, a.filename)}</span>`;
      const when = new Date(a.created_at).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
      return `<div class="attachment">
        <a class="att-main" href="${url}" target="_blank" rel="noopener">
          ${thumb}
          <span class="att-text">
            <span class="att-name">${esc(a.filename)}</span>
            <span class="att-meta">${formatSize(a.size)} · ${when}${m ? ' · ' + esc(m.name) : ''}</span>
          </span>
        </a>
        <a class="link-btn" href="${url}?download=1" title="Herunterladen" aria-label="Herunterladen">⬇︎</a>
        <button class="link-btn" data-del-attachment="${a.id}" data-name="${esc(a.filename)}" title="Löschen" aria-label="Löschen">✕</button>
      </div>`;
    }).join('')
    : '<div class="muted">Noch keine Dokumente. Füge z. B. Einladungen, Tickets, Elternbriefe oder Fotos hinzu.</div>';
}

async function loadComments(eventId) {
  const list = await guarded(() => api('GET', `events/${eventId}/comments`));
  const el = $('#comments');
  if (!list || !el) return;
  el.innerHTML = list.length
    ? list.map((c) => {
      const m = memberById(c.member_id);
      const when = new Date(c.created_at).toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<div class="comment">
        <span class="avatar lg" style="background:${m?.color || '#999'}">${esc(initials(m?.name || '?'))}</span>
        <div class="bubble">
          <div class="who"><span>${esc(m?.name || 'Unbekannt')}</span><span><time>${when}</time>${c.member_id === state.me ? ` <button class="link-btn" data-del-comment="${c.id}" title="Löschen">✕</button>` : ''}</span></div>
          <div class="txt">${esc(c.text)}</div>
        </div>
      </div>`;
    }).join('')
    : '<div class="muted">Noch keine Kommentare.</div>';
}

// ---------- Termin: Bearbeiten / Neu ----------

function openEventEditor(ev) {
  const isNew = !ev?.id;
  const day = state.selected || todayStr();
  let hour = Math.min(22, new Date().getHours() + 1);
  if (day !== todayStr()) hour = 10;
  const defStart = `${day}T${String(hour).padStart(2, '0')}:00`;
  const defEnd = `${day}T${String(hour + 1).padStart(2, '0')}:00`;
  const data = {
    title: '', start: defStart, end: defEnd, all_day: false, location: '', note: '', color: null,
    repeat: 'none', repeat_until: '', calendar_id: state.calendars.find((c) => !state.hidden.has(c.id))?.id || state.calendars[0]?.id,
    member_ids: state.me ? [state.me] : [],
    ...ev,
  };
  data.member_ids = [...data.member_ids];
  modalContext = { type: 'editor' };

  openModal(`
    <form id="eventForm" style="display:flex;flex-direction:column;gap:14px">
      <div class="sheet-head">
        <button type="button" class="link-btn" data-close>Abbrechen</button>
        <h3>${isNew ? 'Neuer Termin' : 'Termin bearbeiten'}</h3>
        <button type="submit" class="pill-btn small">Speichern</button>
      </div>
      <input class="title-input" name="title" placeholder="Titel" maxlength="120" value="${esc(data.title)}" required autofocus>
      <label class="switch">Ganztägig <input type="checkbox" name="all_day" ${data.all_day ? 'checked' : ''}></label>
      <div class="grid-2">
        <label class="field"><span>Beginn</span><input type="date" name="start_date" value="${data.start.slice(0, 10)}" required></label>
        <label class="field time-field"><span>Uhrzeit</span><input type="time" name="start_time" value="${data.start.slice(11)}"></label>
        <label class="field"><span>Ende</span><input type="date" name="end_date" value="${data.end.slice(0, 10)}" required></label>
        <label class="field time-field"><span>Uhrzeit</span><input type="time" name="end_time" value="${data.end.slice(11)}"></label>
      </div>
      <div class="grid-2">
        <label class="field"><span>Wiederholen</span>
          <select name="repeat">${Object.entries(REPEAT_LABELS).map(([k, v]) => `<option value="${k}" ${k === data.repeat ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label class="field" id="untilField"><span>bis (optional)</span><input type="date" name="repeat_until" value="${data.repeat_until || ''}"></label>
      </div>
      <label class="field"><span>Kalender</span>
        <select name="calendar_id">${state.calendars.map((c) => `<option value="${c.id}" ${c.id === data.calendar_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </label>
      <div class="field"><span>Wer ist dabei?</span>
        <div class="chips" id="memberChips">${state.members.length ? state.members.map((m) => `<button type="button" class="chip ${data.member_ids.includes(m.id) ? 'active' : ''}" data-member="${m.id}" style="--c:${m.color}"><span class="avatar" style="background:${m.color}">${esc(initials(m.name))}</span>${esc(m.name)}</button>`).join('') : '<span class="muted">Lege unter „Familie“ Mitglieder an.</span>'}</div>
      </div>
      <div class="field"><span>Farbe</span>${swatchesHtml(data.color, { allowAuto: true })}</div>
      <label class="field"><span>Ort</span><input name="location" maxlength="200" value="${esc(data.location)}" placeholder="z. B. Sporthalle"></label>
      <label class="field"><span>Notiz</span><textarea name="note" maxlength="5000" placeholder="Mitbringen, Treffpunkt …">${esc(data.note)}</textarea></label>
      <div class="field"><span>Dokumente</span>
        ${!isNew && data.attachment_count ? `<div class="muted">${data.attachment_count} Dokument${data.attachment_count === 1 ? '' : 'e'} vorhanden – verwalten in der Terminansicht.</div>` : ''}
        <div class="attachments" id="pendingFiles"></div>
        <label class="pill-btn small ghost file-btn" style="align-self:flex-start">📎 Dokument anhängen<input type="file" id="editorFiles" multiple hidden></label>
      </div>
      ${!isNew ? `<button type="button" class="pill-btn danger" id="deleteEventBtn" style="align-self:flex-start">Termin löschen</button>` : ''}
      ${!isNew && data.repeat !== 'none' ? '<p class="muted" style="margin:0">Änderungen gelten für die ganze Serie.</p>' : ''}
    </form>
  `, (root) => {
    const form = $('#eventForm', root);
    const syncAllDay = () => $$('.time-field', root).forEach((f) => f.classList.toggle('hidden', form.all_day.checked));
    const syncRepeat = () => $('#untilField', root).classList.toggle('hidden', form.repeat.value === 'none');
    form.all_day.onchange = syncAllDay;
    form.repeat.onchange = syncRepeat;
    syncAllDay();
    syncRepeat();

    // Ende automatisch mitziehen, wenn der Beginn verschoben wird.
    let prevStart = `${form.start_date.value}T${form.start_time.value || '00:00'}`;
    const shiftEnd = () => {
      const newStart = `${form.start_date.value}T${form.start_time.value || '00:00'}`;
      if (!form.start_date.value) return;
      const dur = Date.parse(`${form.end_date.value}T${form.end_time.value || '00:00'}Z`) - Date.parse(prevStart + 'Z');
      if (!Number.isNaN(dur)) {
        const end = new Date(Date.parse(newStart + 'Z') + Math.max(0, dur)).toISOString();
        form.end_date.value = end.slice(0, 10);
        form.end_time.value = end.slice(11, 16);
      }
      prevStart = newStart;
    };
    form.start_date.onchange = shiftEnd;
    form.start_time.onchange = shiftEnd;

    $('#memberChips', root).onclick = (e) => {
      const chip = e.target.closest('[data-member]');
      if (!chip) return;
      const mid = +chip.dataset.member;
      const i = data.member_ids.indexOf(mid);
      if (i >= 0) data.member_ids.splice(i, 1); else data.member_ids.push(mid);
      chip.classList.toggle('active', i < 0);
    };
    bindSwatches(root, (c) => { data.color = c; });

    // Ausgewählte Dateien werden nach dem Speichern hochgeladen.
    const pending = [];
    const renderPending = () => {
      $('#pendingFiles', root).innerHTML = pending.map((f, i) => `<div class="attachment">
        <span class="att-main"><span class="att-icon">${fileIcon(f.type || '', f.name)}</span>
        <span class="att-text"><span class="att-name">${esc(f.name)}</span><span class="att-meta">${formatSize(f.size)} · wird beim Speichern hochgeladen</span></span></span>
        <button type="button" class="link-btn" data-pending="${i}" aria-label="Entfernen">✕</button>
      </div>`).join('');
    };
    const addPending = (files) => {
      const maxMb = state.settings.max_upload_mb || 25;
      for (const f of files) {
        if (f.size > maxMb * 1024 * 1024) toast(`„${f.name}“ ist zu groß (max. ${maxMb} MB)`);
        else pending.push(f);
      }
      renderPending();
    };
    $('#editorFiles', root).onchange = (e) => { addPending([...e.target.files]); e.target.value = ''; };
    $('#pendingFiles', root).onclick = (e) => {
      const b = e.target.closest('[data-pending]');
      if (b) { pending.splice(+b.dataset.pending, 1); renderPending(); }
    };
    bindDropZone(root, addPending);

    form.onsubmit = (e) => {
      e.preventDefault();
      const payload = {
        title: form.title.value,
        all_day: form.all_day.checked,
        start: `${form.start_date.value}T${form.all_day.checked ? '00:00' : (form.start_time.value || '00:00')}`,
        end: `${form.end_date.value}T${form.all_day.checked ? '23:59' : (form.end_time.value || '00:00')}`,
        repeat: form.repeat.value,
        repeat_until: form.repeat.value !== 'none' ? form.repeat_until.value || null : null,
        calendar_id: +form.calendar_id.value,
        member_ids: data.member_ids,
        color: data.color,
        location: form.location.value,
        note: form.note.value,
        created_by: state.me,
      };
      guarded(async () => {
        const saved = isNew ? await api('POST', 'events', payload) : await api('PUT', `events/${ev.id}`, payload);
        if (pending.length) await uploadAll(saved.id, pending);
        state.selected = saved.start.slice(0, 10);
        state.month = state.selected.slice(0, 7);
        closeModal();
        await loadEvents();
        renderAll();
        if (!pending.length) toast(isNew ? 'Termin angelegt' : 'Termin gespeichert');
      });
    };

    const del = $('#deleteEventBtn', root);
    if (del) {
      del.onclick = () => {
        if (!confirm(data.repeat !== 'none' ? 'Die ganze Terminserie löschen?' : 'Diesen Termin löschen?')) return;
        guarded(async () => {
          await api('DELETE', `events/${ev.id}`);
          closeModal();
          await loadEvents();
          renderAll();
          toast('Termin gelöscht');
        });
      };
    }
  });
}

// ---------- Mitglieder & Kalender ----------

function openNamedColorEditor({ title, item, endpoint, onDone, deleteLabel, nameLabel }) {
  const data = { name: item?.name || '', color: item?.color || PALETTE[(state.members.length + state.calendars.length) % PALETTE.length] };
  modalContext = { type: 'editor' };
  openModal(`
    <form id="ncForm" style="display:flex;flex-direction:column;gap:14px">
      <div class="sheet-head">
        <button type="button" class="link-btn" data-close>Abbrechen</button>
        <h3>${title}</h3>
        <button type="submit" class="pill-btn small">Speichern</button>
      </div>
      <label class="field"><span>${nameLabel}</span><input name="name" maxlength="40" value="${esc(data.name)}" required autofocus></label>
      <div class="field"><span>Farbe</span>${swatchesHtml(data.color)}</div>
      ${item ? `<button type="button" class="pill-btn danger" id="ncDelete" style="align-self:flex-start">${deleteLabel}</button>` : ''}
    </form>
  `, (root) => {
    bindSwatches(root, (c) => { data.color = c; });
    $('#ncForm', root).onsubmit = (e) => {
      e.preventDefault();
      guarded(async () => {
        const body = { name: e.target.name.value, color: data.color };
        const saved = item ? await api('PUT', `${endpoint}/${item.id}`, body) : await api('POST', endpoint, body);
        closeModal();
        await onDone(saved);
      });
    };
    const del = $('#ncDelete', root);
    if (del) del.onclick = () => {
      if (!confirm(`„${item.name}“ wirklich löschen?${endpoint === 'calendars' ? ' Alle Termine darin werden ebenfalls gelöscht.' : ''}`)) return;
      guarded(async () => {
        await api('DELETE', `${endpoint}/${item.id}`);
        closeModal();
        await onDone(null);
      });
    };
  });
}

function editMember(member) {
  openNamedColorEditor({
    title: member ? 'Mitglied bearbeiten' : 'Neues Mitglied',
    nameLabel: 'Name',
    deleteLabel: 'Mitglied entfernen',
    item: member,
    endpoint: 'members',
    onDone: async (saved) => {
      if (saved && !state.me) { state.me = saved.id; store('me', saved.id); }
      await reloadAll();
    },
  });
}

function editCalendar(cal) {
  openNamedColorEditor({
    title: cal ? 'Kalender bearbeiten' : 'Neuer Kalender',
    nameLabel: 'Name (z. B. Schule, Arbeit, Sport)',
    deleteLabel: 'Kalender löschen',
    item: cal,
    endpoint: 'calendars',
    onDone: reloadAll,
  });
}

// ---------- Notizen ----------

function openMemo(memoId) {
  const memo = memoId ? state.memos.find((m) => m.id === memoId) : null;
  modalContext = { type: 'memo', id: memoId };
  const render = (m) => `
    <div class="sheet-head">
      <button type="button" class="link-btn" data-close>Fertig</button>
      <h3>${m ? 'Notiz' : 'Neue Notiz'}</h3>
      <button type="button" class="link-btn" id="pinBtn" title="Anheften">${m?.pinned ? '📌 Angeheftet' : '📌 Anheften'}</button>
    </div>
    <input class="title-input" id="memoTitle" placeholder="Titel, z. B. Einkaufsliste" maxlength="120" value="${esc(m?.title || '')}" autofocus>
    <ul class="checklist" id="memoItems">${(m?.items || []).map((i) => `
      <li class="${i.done ? 'done' : ''}">
        <input type="checkbox" data-item="${i.id}" ${i.done ? 'checked' : ''}>
        <span class="txt">${esc(i.text)}</span>
        <button class="link-btn" data-del-item="${i.id}" title="Entfernen">✕</button>
      </li>`).join('')}</ul>
    <form class="comment-form" id="itemForm">
      <input id="itemInput" placeholder="${m ? 'Eintrag hinzufügen …' : 'Erst Titel eingeben, dann Einträge'}" maxlength="200" autocomplete="off">
      <button class="pill-btn" type="submit">+</button>
    </form>
    <label class="field"><span>Notiz</span><textarea id="memoNote" maxlength="10000" placeholder="Freier Text …">${esc(m?.note || '')}</textarea></label>
    <div class="row" style="justify-content:space-between">
      ${m?.items.some((i) => i.done) ? '<button class="pill-btn ghost small" id="clearDone">Erledigte entfernen</button>' : '<span></span>'}
      ${m ? '<button class="pill-btn danger small" id="deleteMemo">Notiz löschen</button>' : ''}
    </div>`;

  let current = memo;
  const ensureSaved = async () => {
    const title = $('#memoTitle').value.trim() || 'Ohne Titel';
    const note = $('#memoNote').value;
    if (!current) {
      current = await api('POST', 'memos', { title, note });
      modalContext.id = current.id;
    } else if (title !== current.title || note !== current.note) {
      current = await api('PUT', `memos/${current.id}`, { title, note, pinned: current.pinned });
    }
    return current;
  };

  const mount = (root) => {
    $('#itemForm', root).onsubmit = (e) => {
      e.preventDefault();
      const value = $('#itemInput', root).value.trim();
      if (!value) return;
      guarded(async () => {
        await ensureSaved();
        current = await api('POST', `memos/${current.id}/items`, { text: value });
        rerender(true);
      });
    };
    $('#memoItems', root).onchange = (e) => {
      const cb = e.target.closest('[data-item]');
      if (!cb) return;
      guarded(async () => { current = await api('PUT', `memo-items/${cb.dataset.item}`, { done: cb.checked }); rerender(); });
    };
    $('#memoItems', root).onclick = (e) => {
      const b = e.target.closest('[data-del-item]');
      if (!b) return;
      guarded(async () => { current = await api('DELETE', `memo-items/${b.dataset.delItem}`); rerender(); });
    };
    $('#pinBtn', root).onclick = () => guarded(async () => {
      await ensureSaved();
      current = await api('PUT', `memos/${current.id}`, { title: current.title, note: current.note, pinned: !current.pinned });
      rerender();
    });
    const clear = $('#clearDone', root);
    if (clear) clear.onclick = () => guarded(async () => { current = await api('POST', `memos/${current.id}/clear-done`, {}); rerender(); });
    const del = $('#deleteMemo', root);
    if (del) del.onclick = () => {
      if (!confirm('Diese Notiz löschen?')) return;
      guarded(async () => {
        await api('DELETE', `memos/${current.id}`);
        current = null;
        modalContext = null;
        closeModal();
        await loadMemos();
        renderMemos();
      });
    };
    // Titel & Text beim Verlassen der Felder speichern
    $('#memoTitle', root).onblur = () => { if (current || $('#memoTitle', root).value.trim()) guarded(ensureSaved); };
    $('#memoNote', root).onblur = () => { if (current || $('#memoNote', root).value.trim()) guarded(ensureSaved); };
  };

  const rerender = (focusInput) => {
    const title = $('#memoTitle')?.value;
    const note = $('#memoNote')?.value;
    $('#modalSheet').innerHTML = render(current);
    if (title !== undefined) $('#memoTitle').value = title;
    if (note !== undefined) $('#memoNote').value = note;
    mount($('#modalSheet'));
    if (focusInput) $('#itemInput').focus();
  };

  modalContext.save = async () => {
    const title = $('#memoTitle')?.value.trim();
    if (current || title) await ensureSaved();
  };
  openModal(render(current), mount);
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $('#fab').classList.toggle('hidden', view === 'family');
  if (view === 'calendar') layoutBars();
}

async function goToMonth(month) {
  state.month = month;
  if (state.selected.slice(0, 7) !== month) state.selected = month === todayStr().slice(0, 7) ? todayStr() : month + '-01';
  renderHeader();
  renderMonth();
  renderDayPanel();
  await guarded(loadEvents);
  renderMonth();
  renderDayPanel();
  renderUpcoming();
}
function shiftMonth(delta) {
  const y = +state.month.slice(0, 4), m = +state.month.slice(5, 7) - 1 + delta;
  goToMonth(fromMs(Date.UTC(y, m, 1)).slice(0, 7));
}

function bindEvents() {
  installDropZone();
  $('#prevBtn').onclick = () => shiftMonth(-1);
  $('#nextBtn').onclick = () => shiftMonth(1);
  const goToday = () => { state.selected = todayStr(); switchView('calendar'); goToMonth(todayStr().slice(0, 7)); };
  $('#todayBtn').onclick = goToday;
  $('#monthLabel').onclick = goToday;

  $('#weeks').addEventListener('click', (e) => {
    const bar = e.target.closest('.bar');
    if (bar) return openEventDetail(bar.dataset.key);
    const cell = e.target.closest('.day');
    if (!cell) return;
    const d = cell.dataset.date;
    if (d === state.selected && eventsOnDay(d).length === 0) return openEventEditor();
    state.selected = d;
    if (d.slice(0, 7) !== state.month) return goToMonth(d.slice(0, 7));
    $$('#weeks .day').forEach((c) => c.classList.toggle('selected', c.dataset.date === d));
    renderDayPanel();
    return undefined;
  });

  // Wischen im Monat
  let touchX = null, touchY = null;
  const month = $('.month');
  month.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
  month.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    touchX = null;
  });

  document.addEventListener('click', (e) => {
    const item = e.target.closest('.event-item');
    if (item) return openEventDetail(item.dataset.key);
    const memo = e.target.closest('[data-memo]');
    if (memo) return openMemo(+memo.dataset.memo);
    const em = e.target.closest('[data-edit-member]');
    if (em) return editMember(memberById(+em.dataset.editMember));
    const ec = e.target.closest('[data-edit-cal]');
    if (ec) return editCalendar(calendarById(+ec.dataset.editCal));
    const da = e.target.closest('[data-del-attachment]');
    if (da) {
      if (!confirm(`„${da.dataset.name}“ löschen?`)) return undefined;
      return guarded(async () => {
        await api('DELETE', `attachments/${da.dataset.delAttachment}`);
        if (modalContext?.type === 'event') loadAttachments(modalContext.id);
        await loadEvents();
        renderMonth();
        renderDayPanel();
        renderUpcoming();
      });
    }
    const dc = e.target.closest('[data-del-comment]');
    if (dc) {
      return guarded(async () => {
        await api('DELETE', `comments/${dc.dataset.delComment}`);
        if (modalContext?.type === 'event') loadComments(modalContext.id);
      });
    }
    if (e.target.closest('[data-close]')) {
      const save = modalContext?.save;
      closeModal();
      if (save) guarded(async () => { await save(); await loadMemos(); renderMemos(); });
    }
    return undefined;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) $('[data-close]', $('#modal')).click();
  });

  document.addEventListener('change', (e) => {
    const t = e.target.closest('[data-toggle-cal]');
    if (!t) return;
    const id = +t.dataset.toggleCal;
    if (t.checked) state.hidden.delete(id); else state.hidden.add(id);
    store('hiddenCalendars', [...state.hidden]);
    renderMonth();
    renderDayPanel();
    renderUpcoming();
  });

  $$('.tab').forEach((t) => { t.onclick = () => switchView(t.dataset.view); });
  $('#fab').onclick = () => (state.view === 'memos' ? openMemo(null) : openEventEditor());
  $('#dayAddBtn').onclick = () => openEventEditor();
  $('#newMemoBtn').onclick = () => openMemo(null);
  $('#addMemberBtn').onclick = () => editMember(null);
  $('#addCalendarBtn').onclick = () => editCalendar(null);
  $('#meSelect').onchange = (e) => {
    state.me = e.target.value ? +e.target.value : null;
    store('me', state.me);
    renderFamily();
    toast(state.me ? `Hallo ${memberById(state.me).name}!` : 'Auswahl entfernt');
  };
  $('#saveFamilyName').onclick = () => guarded(async () => {
    await api('PUT', 'settings', { family_name: $('#familyNameInput').value });
    await loadBootstrap();
    renderHeader();
    toast('Gespeichert');
  });
  $('#logoutBtn').onclick = () => guarded(async () => { await api('POST', 'logout', {}); location.reload(); });

  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(layoutBars, 120); });

  // Um Mitternacht / beim Zurückkehren in die App „Heute“ aktualisieren
  document.addEventListener('visibilitychange', () => { if (!document.hidden) guarded(reloadAll); });
}

// Live-Synchronisation zwischen allen Geräten
function connectStream() {
  if (!window.EventSource) return;
  const es = new EventSource('api/stream');
  let pending = new Set();
  let t = null;
  es.onmessage = (msg) => {
    const { topic } = JSON.parse(msg.data);
    pending.add(topic);
    clearTimeout(t);
    t = setTimeout(async () => {
      const topics = pending;
      pending = new Set();
      await guarded(async () => {
        if (topics.has('members') || topics.has('calendars') || topics.has('settings')) await loadBootstrap();
        if (topics.has('events') || topics.has('calendars') || topics.has('members')) await loadEvents();
        if (topics.has('memos')) await loadMemos();
      });
      renderHeader();
      renderMonth();
      renderDayPanel();
      renderUpcoming();
      if (topics.has('memos')) renderMemos();
      if (state.view === 'family' && !$('#familyNameInput').matches(':focus')) renderFamily();
      if (modalContext?.type === 'event' && topics.has('comments:' + modalContext.id)) loadComments(modalContext.id);
      if (modalContext?.type === 'event' && topics.has('attachments:' + modalContext.id)) loadAttachments(modalContext.id);
    }, 250);
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#loginPassword').focus();
}

async function start() {
  const session = await fetch('api/session').then((r) => r.json()).catch(() => ({ authed: true }));
  if (session.passwordRequired) $('#logoutBtn').classList.remove('hidden');
  if (!session.authed) {
    showLogin();
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', 'login', { password: $('#loginPassword').value });
        location.reload();
      } catch (err) {
        $('#loginError').textContent = err.message;
      }
    };
    return;
  }
  $('#app').classList.remove('hidden');
  bindEvents();
  await guarded(reloadAll);
  connectStream();
  if (!state.members.length) {
    switchView('family');
    toast('Willkommen! Lege zuerst eure Familienmitglieder an.');
  } else if (!state.me) {
    switchView('family');
    toast('Wähle aus, wer du bist.');
  }
}

start();
