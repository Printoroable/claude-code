'use strict';

// Familienplaner – kleiner HTTP-Server ohne externe Abhängigkeiten.
// Speichert alles in SQLite (node:sqlite) und verteilt Änderungen per
// Server-Sent Events live an alle offenen Geräte der Familie.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);

// ---------------------------------------------------------------------------
// Datenbank
// ---------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'familienplaner.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    color TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS calendars (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    color TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_id  INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    start        TEXT NOT NULL,
    end          TEXT NOT NULL,
    all_day      INTEGER NOT NULL DEFAULT 0,
    location     TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    color        TEXT,
    repeat       TEXT NOT NULL DEFAULT 'none',
    repeat_until TEXT,
    created_by   INTEGER REFERENCES members(id) ON DELETE SET NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_range ON events(start, end);

  CREATE TABLE IF NOT EXISTS event_members (
    event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, member_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    member_id  INTEGER REFERENCES members(id) ON DELETE SET NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memo_items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    memo_id INTEGER NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
    text    TEXT NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0,
    pos     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_event ON attachments(event_id);
`);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Erststart: Standardkalender und ein Beispiel-Memo anlegen.
if (db.prepare('SELECT COUNT(*) AS n FROM calendars').get().n === 0) {
  db.prepare('INSERT INTO calendars (name, color) VALUES (?, ?)').run('Familie', '#3eb370');
  const memo = db.prepare('INSERT INTO memos (title, note, pinned, updated_at) VALUES (?, ?, 1, ?)')
    .run('Einkaufsliste', '', nowIso());
  const addItem = db.prepare('INSERT INTO memo_items (memo_id, text, pos) VALUES (?, ?, ?)');
  ['Milch', 'Brot', 'Äpfel'].forEach((t, i) => addItem.run(memo.lastInsertRowid, t, i));
}
if (!getSetting('secret')) setSetting('secret', crypto.randomBytes(32).toString('hex'));

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

function text(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} muss Text sein`);
  value = value.trim();
  if (required && !value) throw new HttpError(400, `${field} fehlt`);
  if (value.length > max) throw new HttpError(400, `${field} ist zu lang (max. ${max} Zeichen)`);
  return value;
}
function color(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !COLOR_RE.test(value)) throw new HttpError(400, `${field} ist keine gültige Farbe`);
  return value.toLowerCase();
}
function id(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} ist ungültig`);
  return n;
}
function datetime(value, field) {
  if (typeof value !== 'string' || !DATETIME_RE.test(value) || Number.isNaN(parseLocal(value))) {
    throw new HttpError(400, `${field} ist kein gültiger Zeitpunkt`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Datum & Wiederholungen
// Zeiten werden als lokale "YYYY-MM-DDTHH:MM"-Strings gespeichert. Für die
// Rechnung behandeln wir sie als UTC, damit Sommerzeit nichts verschiebt.
// ---------------------------------------------------------------------------

function parseLocal(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min] = t.split(':').map(Number);
  const ms = Date.UTC(y, m - 1, day, h, min);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) return NaN;
  return ms;
}
function formatLocal(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

const DAY = 86400000;

// Liefert alle Vorkommen eines Termins, die den Bereich [from, to] berühren.
function expandEvent(ev, fromMs, toMs) {
  const startMs = parseLocal(ev.start);
  const duration = Math.max(0, parseLocal(ev.end) - startMs);

  if (ev.repeat === 'none') {
    return startMs <= toMs && startMs + duration >= fromMs ? [{ ...ev, occurrence: ev.start }] : [];
  }

  const untilMs = ev.repeat_until ? parseLocal(ev.repeat_until + 'T23:59') : Infinity;
  const s = new Date(startMs);
  const y = s.getUTCFullYear(), mo = s.getUTCMonth(), d = s.getUTCDate();
  const h = s.getUTCHours(), mi = s.getUTCMinutes();

  let i = 0;
  if (ev.repeat === 'daily' || ev.repeat === 'weekly') {
    const step = ev.repeat === 'daily' ? DAY : 7 * DAY;
    i = Math.max(0, Math.floor((fromMs - duration - startMs) / step));
  }

  const out = [];
  for (let guard = 0; guard < 20000; guard++, i++) {
    let occ;
    switch (ev.repeat) {
      case 'daily': occ = startMs + i * DAY; break;
      case 'weekly': occ = startMs + i * 7 * DAY; break;
      case 'monthly': {
        occ = Date.UTC(y, mo + i, d, h, mi);
        if (new Date(occ).getUTCDate() !== d) continue; // z. B. kein 31. im Monat
        break;
      }
      case 'yearly': {
        occ = Date.UTC(y + i, mo, d, h, mi);
        if (new Date(occ).getUTCMonth() !== mo) continue; // 29. Februar
        break;
      }
      default: return out;
    }
    if (occ > toMs || occ > untilMs) break;
    if (occ + duration >= fromMs) {
      out.push({ ...ev, start: formatLocal(occ), end: formatLocal(occ + duration), occurrence: formatLocal(occ) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Datenzugriff
// ---------------------------------------------------------------------------

function memberIdsFor(eventIds) {
  const map = new Map();
  if (!eventIds.length) return map;
  const rows = db.prepare(
    `SELECT event_id, member_id FROM event_members WHERE event_id IN (${eventIds.map(() => '?').join(',')})`
  ).all(...eventIds);
  for (const r of rows) {
    if (!map.has(r.event_id)) map.set(r.event_id, []);
    map.get(r.event_id).push(r.member_id);
  }
  return map;
}

function commentCounts(eventIds) {
  const map = new Map();
  if (!eventIds.length) return map;
  const rows = db.prepare(
    `SELECT event_id, COUNT(*) AS n FROM comments WHERE event_id IN (${eventIds.map(() => '?').join(',')}) GROUP BY event_id`
  ).all(...eventIds);
  for (const r of rows) map.set(r.event_id, r.n);
  return map;
}

function attachmentCounts(eventIds) {
  const map = new Map();
  if (!eventIds.length) return map;
  const rows = db.prepare(
    `SELECT event_id, COUNT(*) AS n FROM attachments WHERE event_id IN (${eventIds.map(() => '?').join(',')}) GROUP BY event_id`
  ).all(...eventIds);
  for (const r of rows) map.set(r.event_id, r.n);
  return map;
}

function decorate(rows) {
  const ids = rows.map((r) => r.id);
  const members = memberIdsFor(ids);
  const counts = commentCounts(ids);
  const files = attachmentCounts(ids);
  return rows.map((r) => ({
    ...r,
    all_day: !!r.all_day,
    member_ids: members.get(r.id) || [],
    comment_count: counts.get(r.id) || 0,
    attachment_count: files.get(r.id) || 0,
  }));
}

// ---------------------------------------------------------------------------
// Dokumente / Anhänge
// Dateien liegen unter DATA_DIR/uploads mit zufälligem Namen; Originalname und
// Typ stehen in der Datenbank.
// ---------------------------------------------------------------------------

// Diese Typen darf der Browser direkt anzeigen. Alles andere (z. B. HTML oder
// SVG, die Skripte enthalten können) wird nur als Download ausgeliefert.
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/avif',
  'application/pdf', 'text/plain', 'audio/mpeg', 'video/mp4',
]);

function cleanFilename(name) {
  const cleaned = String(name || '').replace(/[\u0000-\u001f\u007f\\/]/g, '').replace(/^\.+/, '').trim().slice(0, 150);
  return cleaned || 'Dokument';
}
function cleanMime(type) {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : 'application/octet-stream';
}

function listAttachments(eventId) {
  return db.prepare('SELECT id, event_id, filename, mime, size, member_id, created_at FROM attachments WHERE event_id = ? ORDER BY id')
    .all(eventId);
}

function removeStoredFile(storedName) {
  try {
    fs.rmSync(path.join(UPLOAD_DIR, storedName), { force: true });
  } catch (err) {
    console.error('Konnte Datei nicht löschen:', err.message);
  }
}

// Entfernt Dateien, deren Termin (oder Kalender) gelöscht wurde.
function sweepOrphanFiles() {
  const known = new Set(db.prepare('SELECT stored_name FROM attachments').all().map((r) => r.stored_name));
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (!known.has(f) && !f.endsWith('.part')) removeStoredFile(f);
  }
}

function saveUpload(req, eventId) {
  const limit = MAX_UPLOAD_MB * 1024 * 1024;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) return Promise.reject(new HttpError(413, `Datei ist zu groß (max. ${MAX_UPLOAD_MB} MB)`));

  let filename;
  try {
    filename = cleanFilename(decodeURIComponent(req.headers['x-filename'] || ''));
  } catch {
    filename = 'Dokument';
  }
  const mime = cleanMime(req.headers['content-type']);
  const storedName = crypto.randomBytes(16).toString('hex');
  const tmp = path.join(UPLOAD_DIR, storedName + '.part');

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => reject(err));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, `Datei ist zu groß (max. ${MAX_UPLOAD_MB} MB)`));
        req.resume();
      }
    });
    req.on('aborted', () => fail(new HttpError(400, 'Upload abgebrochen')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) return fail(new HttpError(400, 'Die Datei ist leer'));
      fs.rename(tmp, path.join(UPLOAD_DIR, storedName), (err) => {
        if (err) return fail(err);
        const memberRaw = req.headers['x-member-id'];
        const memberId = memberRaw && db.prepare('SELECT id FROM members WHERE id = ?').get(Number(memberRaw)) ? Number(memberRaw) : null;
        try {
          const r = db.prepare(
            'INSERT INTO attachments (event_id, filename, mime, size, stored_name, member_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(eventId, filename, mime, size, storedName, memberId, nowIso());
          resolve(db.prepare('SELECT id, event_id, filename, mime, size, member_id, created_at FROM attachments WHERE id = ?').get(r.lastInsertRowid));
        } catch (dbErr) {
          removeStoredFile(storedName);
          reject(dbErr);
        }
      });
      return undefined;
    });
    req.pipe(out);
  });
}

function getEvent(eventId) {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!row) throw new HttpError(404, 'Termin nicht gefunden');
  return decorate([row])[0];
}

function listEvents(from, to) {
  const fromMs = parseLocal(from);
  const toMs = parseLocal(to);
  if (toMs < fromMs) throw new HttpError(400, 'Zeitraum ist ungültig');
  if (toMs - fromMs > 400 * DAY) throw new HttpError(400, 'Zeitraum ist zu groß (max. 400 Tage)');
  const rows = db.prepare(
    `SELECT * FROM events
      WHERE (repeat = 'none' AND start <= ? AND end >= ?)
         OR (repeat != 'none' AND start <= ? AND (repeat_until IS NULL OR repeat_until >= ?))`
  ).all(to, from, to, from.slice(0, 10));
  const out = [];
  for (const ev of decorate(rows)) out.push(...expandEvent(ev, fromMs, toMs));
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id));
  return out;
}

function readEventInput(body) {
  const allDay = !!body.all_day;
  let start = datetime(body.start, 'Beginn');
  let end = datetime(body.end || body.start, 'Ende');
  if (allDay) {
    start = start.slice(0, 10) + 'T00:00';
    end = end.slice(0, 10) + 'T23:59';
  }
  if (end < start) throw new HttpError(400, 'Das Ende liegt vor dem Beginn');

  const repeat = body.repeat || 'none';
  if (!REPEATS.includes(repeat)) throw new HttpError(400, 'Wiederholung ist ungültig');
  let repeatUntil = null;
  if (repeat !== 'none' && body.repeat_until) {
    if (!DATE_RE.test(body.repeat_until)) throw new HttpError(400, 'Wiederholen bis ist ungültig');
    repeatUntil = body.repeat_until;
  }

  const calendarId = id(body.calendar_id, 'Kalender');
  if (!db.prepare('SELECT 1 FROM calendars WHERE id = ?').get(calendarId)) throw new HttpError(400, 'Kalender existiert nicht');

  const memberIds = Array.isArray(body.member_ids) ? [...new Set(body.member_ids.map((m) => id(m, 'Teilnehmer')))] : [];

  return {
    calendar_id: calendarId,
    title: text(body.title, 'Titel', { required: true, max: 120 }),
    start,
    end,
    all_day: allDay ? 1 : 0,
    location: text(body.location, 'Ort', { max: 200 }),
    note: text(body.note, 'Notiz', { max: 5000 }),
    color: color(body.color, 'Farbe', { optional: true }),
    repeat,
    repeat_until: repeatUntil,
    created_by: id(body.created_by, 'Ersteller', { optional: true }),
    member_ids: memberIds,
  };
}

function saveEventMembers(eventId, memberIds) {
  db.prepare('DELETE FROM event_members WHERE event_id = ?').run(eventId);
  const ins = db.prepare('INSERT OR IGNORE INTO event_members (event_id, member_id) SELECT ?, id FROM members WHERE id = ?');
  for (const m of memberIds) ins.run(eventId, m);
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getMemo(memoId) {
  const memo = db.prepare('SELECT * FROM memos WHERE id = ?').get(memoId);
  if (!memo) throw new HttpError(404, 'Notiz nicht gefunden');
  memo.pinned = !!memo.pinned;
  memo.items = db.prepare('SELECT * FROM memo_items WHERE memo_id = ? ORDER BY pos, id').all(memoId)
    .map((i) => ({ ...i, done: !!i.done }));
  return memo;
}

// ---------------------------------------------------------------------------
// Live-Updates (Server-Sent Events)
// ---------------------------------------------------------------------------

const streams = new Set();
function broadcast(topic) {
  const msg = `data: ${JSON.stringify({ topic, at: Date.now() })}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => {
  for (const res of streams) res.write(': ping\n\n');
}, 25000).unref();

// ---------------------------------------------------------------------------
// Anmeldung (optional, über APP_PASSWORD)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'fp_session';
function sessionToken() {
  return crypto.createHmac('sha256', getSetting('secret')).update('session:' + APP_PASSWORD).digest('hex');
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  return safeEqual(parseCookies(req.headers.cookie)[SESSION_COOKIE] || '', sessionToken());
}

const loginAttempts = new Map(); // ip -> { count, until }
function checkRateLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (entry && entry.until > Date.now() && entry.count >= 10) {
    throw new HttpError(429, 'Zu viele Versuche. Bitte in ein paar Minuten erneut probieren.');
  }
}
function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || entry.until < Date.now()) loginAttempts.set(ip, { count: 1, until: Date.now() + 10 * 60000 });
  else entry.count++;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler, { public: isPublic = false, raw = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, isPublic, raw });
}

route('GET', '/api/health', () => ({ ok: true }), { public: true });

route('GET', '/api/session', (req) => ({ authed: isAuthed(req), passwordRequired: !!APP_PASSWORD }), { public: true });

route('POST', '/api/login', (req, res, { body }) => {
  const ip = req.socket.remoteAddress || '';
  checkRateLimit(ip);
  if (!APP_PASSWORD || safeEqual(body.password || '', APP_PASSWORD)) {
    loginAttempts.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    return { ok: true };
  }
  recordFailedLogin(ip);
  throw new HttpError(401, 'Falsches Passwort');
}, { public: true });

route('POST', '/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return { ok: true };
});

// Alles, was die App zum Start braucht, in einem Aufruf.
route('GET', '/api/bootstrap', () => ({
  settings: { family_name: getSetting('family_name', 'Unsere Familie'), max_upload_mb: MAX_UPLOAD_MB },
  members: db.prepare('SELECT * FROM members ORDER BY id').all(),
  calendars: db.prepare('SELECT * FROM calendars ORDER BY id').all(),
}));

route('PUT', '/api/settings', (req, res, { body }) => {
  if (body.family_name !== undefined) setSetting('family_name', text(body.family_name, 'Familienname', { required: true, max: 60 }));
  broadcast('settings');
  return { ok: true };
});

// Mitglieder
route('POST', '/api/members', (req, res, { body }) => {
  const r = db.prepare('INSERT INTO members (name, color) VALUES (?, ?)')
    .run(text(body.name, 'Name', { required: true, max: 40 }), color(body.color, 'Farbe'));
  broadcast('members');
  return db.prepare('SELECT * FROM members WHERE id = ?').get(r.lastInsertRowid);
});
route('PUT', '/api/members/:id', (req, res, { params, body }) => {
  const r = db.prepare('UPDATE members SET name = ?, color = ? WHERE id = ?')
    .run(text(body.name, 'Name', { required: true, max: 40 }), color(body.color, 'Farbe'), id(params.id, 'ID'));
  if (!r.changes) throw new HttpError(404, 'Mitglied nicht gefunden');
  broadcast('members');
  return db.prepare('SELECT * FROM members WHERE id = ?').get(params.id);
});
route('DELETE', '/api/members/:id', (req, res, { params }) => {
  db.prepare('DELETE FROM members WHERE id = ?').run(id(params.id, 'ID'));
  broadcast('members');
  return { ok: true };
});

// Kalender
route('POST', '/api/calendars', (req, res, { body }) => {
  const r = db.prepare('INSERT INTO calendars (name, color) VALUES (?, ?)')
    .run(text(body.name, 'Name', { required: true, max: 40 }), color(body.color, 'Farbe'));
  broadcast('calendars');
  return db.prepare('SELECT * FROM calendars WHERE id = ?').get(r.lastInsertRowid);
});
route('PUT', '/api/calendars/:id', (req, res, { params, body }) => {
  const r = db.prepare('UPDATE calendars SET name = ?, color = ? WHERE id = ?')
    .run(text(body.name, 'Name', { required: true, max: 40 }), color(body.color, 'Farbe'), id(params.id, 'ID'));
  if (!r.changes) throw new HttpError(404, 'Kalender nicht gefunden');
  broadcast('calendars');
  return db.prepare('SELECT * FROM calendars WHERE id = ?').get(params.id);
});
route('DELETE', '/api/calendars/:id', (req, res, { params }) => {
  if (db.prepare('SELECT COUNT(*) AS n FROM calendars').get().n <= 1) {
    throw new HttpError(400, 'Der letzte Kalender kann nicht gelöscht werden');
  }
  db.prepare('DELETE FROM calendars WHERE id = ?').run(id(params.id, 'ID'));
  sweepOrphanFiles();
  broadcast('calendars');
  broadcast('events');
  return { ok: true };
});

// Termine
route('GET', '/api/events', (req, res, { query }) => {
  return listEvents(datetime(query.get('from'), 'from'), datetime(query.get('to'), 'to'));
});
route('GET', '/api/events/:id', (req, res, { params }) => getEvent(id(params.id, 'ID')));
route('POST', '/api/events', (req, res, { body }) => {
  const ev = readEventInput(body);
  const newId = transaction(() => {
    const r = db.prepare(
      `INSERT INTO events (calendar_id, title, start, end, all_day, location, note, color, repeat, repeat_until, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ev.calendar_id, ev.title, ev.start, ev.end, ev.all_day, ev.location, ev.note, ev.color, ev.repeat,
      ev.repeat_until, ev.created_by, nowIso());
    saveEventMembers(r.lastInsertRowid, ev.member_ids);
    return r.lastInsertRowid;
  });
  broadcast('events');
  return getEvent(newId);
});
route('PUT', '/api/events/:id', (req, res, { params, body }) => {
  const eventId = id(params.id, 'ID');
  getEvent(eventId);
  const ev = readEventInput(body);
  transaction(() => {
    db.prepare(
      `UPDATE events SET calendar_id = ?, title = ?, start = ?, end = ?, all_day = ?, location = ?, note = ?, color = ?,
              repeat = ?, repeat_until = ?, updated_at = ? WHERE id = ?`
    ).run(ev.calendar_id, ev.title, ev.start, ev.end, ev.all_day, ev.location, ev.note, ev.color, ev.repeat,
      ev.repeat_until, nowIso(), eventId);
    saveEventMembers(eventId, ev.member_ids);
  });
  broadcast('events');
  return getEvent(eventId);
});
route('DELETE', '/api/events/:id', (req, res, { params }) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(id(params.id, 'ID'));
  sweepOrphanFiles();
  broadcast('events');
  return { ok: true };
});

// Dokumente an Terminen
route('GET', '/api/events/:id/attachments', (req, res, { params }) => listAttachments(id(params.id, 'ID')));
route('POST', '/api/events/:id/attachments', async (req, res, { params }) => {
  const eventId = id(params.id, 'ID');
  getEvent(eventId);
  const att = await saveUpload(req, eventId);
  broadcast('attachments:' + eventId);
  broadcast('events');
  return att;
}, { raw: true });
route('GET', '/api/attachments/:id', (req, res, { params, query }) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id(params.id, 'ID'));
  if (!att) throw new HttpError(404, 'Dokument nicht gefunden');
  const file = path.join(UPLOAD_DIR, att.stored_name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'Datei fehlt auf dem Server');
  }
  const inline = INLINE_TYPES.has(att.mime) && query.get('download') !== '1';
  const encoded = encodeURIComponent(att.filename);
  res.writeHead(200, {
    'Content-Type': inline ? att.mime : 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
});
route('DELETE', '/api/attachments/:id', (req, res, { params }) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id(params.id, 'ID'));
  if (att) {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
    removeStoredFile(att.stored_name);
    broadcast('attachments:' + att.event_id);
    broadcast('events');
  }
  return { ok: true };
});

// Kommentare
route('GET', '/api/events/:id/comments', (req, res, { params }) => {
  return db.prepare('SELECT * FROM comments WHERE event_id = ? ORDER BY id').all(id(params.id, 'ID'));
});
route('POST', '/api/events/:id/comments', (req, res, { params, body }) => {
  const eventId = id(params.id, 'ID');
  getEvent(eventId);
  const r = db.prepare('INSERT INTO comments (event_id, member_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(eventId, id(body.member_id, 'Mitglied', { optional: true }), text(body.text, 'Kommentar', { required: true, max: 2000 }), nowIso());
  broadcast('comments:' + eventId);
  broadcast('events');
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid);
});
route('DELETE', '/api/comments/:id', (req, res, { params }) => {
  const c = db.prepare('SELECT event_id FROM comments WHERE id = ?').get(id(params.id, 'ID'));
  if (c) {
    db.prepare('DELETE FROM comments WHERE id = ?').run(params.id);
    broadcast('comments:' + c.event_id);
    broadcast('events');
  }
  return { ok: true };
});

// Notizen / Listen
route('GET', '/api/memos', () => {
  const memos = db.prepare('SELECT * FROM memos ORDER BY pinned DESC, updated_at DESC').all();
  return memos.map((m) => getMemo(m.id));
});
route('POST', '/api/memos', (req, res, { body }) => {
  const r = db.prepare('INSERT INTO memos (title, note, pinned, updated_at) VALUES (?, ?, ?, ?)')
    .run(text(body.title, 'Titel', { required: true, max: 120 }), text(body.note, 'Notiz', { max: 10000 }), body.pinned ? 1 : 0, nowIso());
  broadcast('memos');
  return getMemo(r.lastInsertRowid);
});
route('PUT', '/api/memos/:id', (req, res, { params, body }) => {
  const memoId = id(params.id, 'ID');
  getMemo(memoId);
  db.prepare('UPDATE memos SET title = ?, note = ?, pinned = ?, updated_at = ? WHERE id = ?')
    .run(text(body.title, 'Titel', { required: true, max: 120 }), text(body.note, 'Notiz', { max: 10000 }), body.pinned ? 1 : 0, nowIso(), memoId);
  broadcast('memos');
  return getMemo(memoId);
});
route('DELETE', '/api/memos/:id', (req, res, { params }) => {
  db.prepare('DELETE FROM memos WHERE id = ?').run(id(params.id, 'ID'));
  broadcast('memos');
  return { ok: true };
});
route('POST', '/api/memos/:id/items', (req, res, { params, body }) => {
  const memoId = id(params.id, 'ID');
  getMemo(memoId);
  const pos = db.prepare('SELECT COALESCE(MAX(pos), -1) + 1 AS p FROM memo_items WHERE memo_id = ?').get(memoId).p;
  db.prepare('INSERT INTO memo_items (memo_id, text, pos) VALUES (?, ?, ?)').run(memoId, text(body.text, 'Eintrag', { required: true, max: 200 }), pos);
  db.prepare('UPDATE memos SET updated_at = ? WHERE id = ?').run(nowIso(), memoId);
  broadcast('memos');
  return getMemo(memoId);
});
route('PUT', '/api/memo-items/:id', (req, res, { params, body }) => {
  const item = db.prepare('SELECT * FROM memo_items WHERE id = ?').get(id(params.id, 'ID'));
  if (!item) throw new HttpError(404, 'Eintrag nicht gefunden');
  const newText = body.text !== undefined ? text(body.text, 'Eintrag', { required: true, max: 200 }) : item.text;
  const done = body.done !== undefined ? (body.done ? 1 : 0) : item.done;
  db.prepare('UPDATE memo_items SET text = ?, done = ? WHERE id = ?').run(newText, done, item.id);
  db.prepare('UPDATE memos SET updated_at = ? WHERE id = ?').run(nowIso(), item.memo_id);
  broadcast('memos');
  return getMemo(item.memo_id);
});
route('DELETE', '/api/memo-items/:id', (req, res, { params }) => {
  const item = db.prepare('SELECT * FROM memo_items WHERE id = ?').get(id(params.id, 'ID'));
  if (!item) return { ok: true };
  db.prepare('DELETE FROM memo_items WHERE id = ?').run(item.id);
  broadcast('memos');
  return getMemo(item.memo_id);
});
route('POST', '/api/memos/:id/clear-done', (req, res, { params }) => {
  const memoId = id(params.id, 'ID');
  db.prepare('DELETE FROM memo_items WHERE memo_id = ? AND done = 1').run(memoId);
  broadcast('memos');
  return getMemo(memoId);
});

// Export als iCalendar-Datei (z. B. zum Import in Google/Apple Kalender)
route('GET', '/api/export.ics', (req, res) => {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const ics = (s) => s.replace(/[-:]/g, '') + '00';
  const calendars = new Map(db.prepare('SELECT * FROM calendars').all().map((c) => [c.id, c.name]));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Familienplaner//DE', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(getSetting('family_name', 'Familienplaner'))}`];
  for (const ev of db.prepare('SELECT * FROM events').all()) {
    lines.push('BEGIN:VEVENT', `UID:familienplaner-${ev.id}`, `DTSTAMP:${ev.updated_at.replace(/[-:]/g, '').slice(0, 15)}Z`);
    if (ev.all_day) {
      const endNext = formatLocal(parseLocal(ev.end.slice(0, 10) + 'T00:00') + DAY);
      lines.push(`DTSTART;VALUE=DATE:${ev.start.slice(0, 10).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${endNext.slice(0, 10).replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART:${ics(ev.start)}`, `DTEND:${ics(ev.end)}`);
    }
    if (ev.repeat !== 'none') {
      const until = ev.repeat_until ? `;UNTIL=${ev.repeat_until.replace(/-/g, '')}T235900` : '';
      lines.push(`RRULE:FREQ=${ev.repeat.toUpperCase()}${until}`);
    }
    lines.push(`SUMMARY:${esc(ev.title)}`, `CATEGORIES:${esc(calendars.get(ev.calendar_id) || '')}`);
    if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
    if (ev.note) lines.push(`DESCRIPTION:${esc(ev.note)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'attachment; filename="familienplaner.ics"',
  });
  res.end(lines.join('\r\n'));
  return undefined;
});

route('GET', '/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
  return undefined;
});

// ---------------------------------------------------------------------------
// HTTP-Server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new HttpError(413, 'Anfrage zu groß'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel === '/index.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  }

  try {
    let match = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method === req.method) {
        match = { r, m };
        break;
      }
    }
    if (!match) throw new HttpError(pathMatched ? 405 : 404, 'Nicht gefunden');
    if (!match.r.isPublic && !isAuthed(req)) throw new HttpError(401, 'Bitte anmelden');

    // Einfacher CSRF-Schutz: POST/PUT müssen JSON senden (das kann ein fremdes
    // HTML-Formular nicht). DELETE ist von fremden Seiten ohnehin nur mit CORS möglich.
    // Uploads senden stattdessen den Kopf X-Filename, den ebenfalls nur die
    // eigene Seite setzen kann.
    if (match.r.raw) {
      if (!req.headers['x-filename']) throw new HttpError(400, 'X-Filename fehlt');
    } else if (req.method === 'POST' || req.method === 'PUT') {
      const type = req.headers['content-type'] || '';
      if (!type.startsWith('application/json')) throw new HttpError(415, 'Erwarte application/json');
    }

    const params = {};
    match.r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match.m[i + 1]); });
    const body = req.method === 'GET' || match.r.raw ? {} : await readBody(req);
    const result = await match.r.handler(req, res, { params, body, query: url.searchParams });
    if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) sendJson(res, err.status, { error: err.message });
    } else {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Interner Fehler' });
    }
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Familienplaner läuft auf http://localhost:${PORT}`);
    if (!APP_PASSWORD) console.log('Hinweis: Kein APP_PASSWORD gesetzt – die App ist ohne Anmeldung erreichbar.');
  });
  const shutdown = () => {
    for (const s of streams) s.end();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { server, expandEvent, parseLocal, formatLocal };
