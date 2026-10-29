'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
process.env.DATA_DIR = dir;
const { server, expandEvent, parseLocal } = require('../server.js');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/`; r(); })));
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

test('Wiederholungen: monatlich am 31. überspringt kurze Monate', () => {
  const ev = { start: '2026-01-31T10:00', end: '2026-01-31T11:00', repeat: 'monthly', repeat_until: null };
  const occ = expandEvent(ev, parseLocal('2026-01-01T00:00'), parseLocal('2026-06-30T23:59'));
  assert.deepStrictEqual(occ.map((o) => o.start.slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31']);
});

test('Wiederholungen: wöchentlich mit Enddatum', () => {
  const ev = { start: '2026-03-02T08:00', end: '2026-03-02T09:00', repeat: 'weekly', repeat_until: '2026-03-20' };
  const occ = expandEvent(ev, parseLocal('2026-03-01T00:00'), parseLocal('2026-04-30T23:59'));
  assert.deepStrictEqual(occ.map((o) => o.start), ['2026-03-02T08:00', '2026-03-09T08:00', '2026-03-16T08:00']);
});

test('Termine anlegen, abfragen, kommentieren und löschen', async () => {
  const boot = (await call('GET', 'bootstrap')).data;
  assert.strictEqual(boot.calendars.length, 1);
  const anna = (await call('POST', 'members', { name: 'Anna', color: '#e9546b' })).data;

  const created = await call('POST', 'events', {
    title: 'Geburtstag Anna', start: '2020-05-12T00:00', end: '2020-05-12T00:00', all_day: true,
    repeat: 'yearly', calendar_id: boot.calendars[0].id, member_ids: [anna.id],
  });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.data.end, '2020-05-12T23:59');

  const list = (await call('GET', 'events?from=2026-05-01T00:00&to=2026-05-31T23:59')).data;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].start, '2026-05-12T00:00');
  assert.deepStrictEqual(list[0].member_ids, [anna.id]);

  await call('POST', `events/${created.data.id}/comments`, { text: 'Kuchen?', member_id: anna.id });
  const ev = (await call('GET', `events/${created.data.id}`)).data;
  assert.strictEqual(ev.comment_count, 1);

  assert.strictEqual((await call('DELETE', `events/${created.data.id}`)).status, 200);
  assert.strictEqual((await call('GET', `events/${created.data.id}`)).status, 404);
});

test('Validierung lehnt fehlerhafte Eingaben ab', async () => {
  const boot = (await call('GET', 'bootstrap')).data;
  const r1 = await call('POST', 'events', { title: '', start: '2026-01-01T10:00', calendar_id: boot.calendars[0].id });
  assert.strictEqual(r1.status, 400);
  const r2 = await call('POST', 'events', { title: 'X', start: '2026-01-01T10:00', end: '2026-01-01T09:00', calendar_id: boot.calendars[0].id });
  assert.strictEqual(r2.status, 400);
  const r3 = await call('POST', 'members', { name: 'Bob', color: 'rot' });
  assert.strictEqual(r3.status, 400);
});

test('Notizen mit Checkliste', async () => {
  const memo = (await call('POST', 'memos', { title: 'Urlaub packen' })).data;
  let m = (await call('POST', `memos/${memo.id}/items`, { text: 'Sonnencreme' })).data;
  m = (await call('PUT', `memo-items/${m.items[0].id}`, { done: true })).data;
  assert.strictEqual(m.items[0].done, true);
  m = (await call('POST', `memos/${memo.id}/clear-done`, {})).data;
  assert.strictEqual(m.items.length, 0);
});

test('Export liefert iCalendar', async () => {
  const res = await fetch(base + 'export.ics');
  assert.match(await res.text(), /^BEGIN:VCALENDAR/);
});
