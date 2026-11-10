'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DEFAULT_VOCABULARY, normaliseVocabulary } = require('./vocab');

const DATA = path.join(__dirname, '..', 'data');
const SHOTS = path.join(DATA, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'isee.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS cameras (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'webcam',
  source      TEXT NOT NULL,
  size        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  detect_fps  REAL NOT NULL DEFAULT 2,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  note       TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS faces (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  embedding  BLOB NOT NULL,
  dim        INTEGER NOT NULL,
  thumb      TEXT,
  quality    REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  camera_id  TEXT,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  score      REAL,
  person_id  TEXT,
  snapshot   TEXT,
  box        TEXT,
  ts         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_cam ON events(camera_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);
`);

const now = () => Date.now();
const id = () => crypto.randomUUID();

/* ---------- settings ---------- */
const DEFAULT_SETTINGS = {
  objectConfidence: 0.45,
  faceConfidence: 0.5,
  matchThreshold: 0.42,
  eventCooldownMs: 60000,
  retainDays: 30,
  refineObjects: true,
  vocabulary: DEFAULT_VOCABULARY,
};

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
  }
  return out;
}

function setSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(k === 'vocabulary' ? normaliseVocabulary(v) : v));
  }
  return getSettings();
}

/* ---------- cameras ---------- */
const CAMERA_COLS = 'id, name, kind, source, size, enabled, detect_fps AS detectFps, sort, created_at AS createdAt';

function listCameras() {
  return db.prepare(`SELECT ${CAMERA_COLS} FROM cameras ORDER BY sort ASC, created_at ASC`).all()
    .map((c) => ({ ...c, enabled: !!c.enabled }));
}

function getCamera(camId) {
  const c = db.prepare(`SELECT ${CAMERA_COLS} FROM cameras WHERE id = ?`).get(camId);
  return c ? { ...c, enabled: !!c.enabled } : null;
}

function addCamera({ name, kind = 'webcam', source, size = null, enabled = true, detectFps = 2 }) {
  const max = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM cameras').get().m;
  const camId = id();
  db.prepare(
    'INSERT INTO cameras(id, name, kind, source, size, enabled, detect_fps, sort, created_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(camId, name, kind, source, size, enabled ? 1 : 0, detectFps, max + 1, now());
  return getCamera(camId);
}

function updateCamera(camId, patch) {
  const allowed = { name: 'name', kind: 'kind', source: 'source', size: 'size', enabled: 'enabled', detectFps: 'detect_fps' };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === 'enabled') v = v ? 1 : 0;
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length) {
    vals.push(camId);
    db.prepare(`UPDATE cameras SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getCamera(camId);
}

function removeCamera(camId) {
  db.prepare('DELETE FROM cameras WHERE id = ?').run(camId);
}

/* ---------- persons / faces ---------- */
function listPersons() {
  const persons = db.prepare(
    'SELECT id, name, note, created_at AS createdAt FROM persons ORDER BY created_at DESC',
  ).all();
  const faces = db.prepare(
    'SELECT id, person_id AS personId, thumb, quality FROM faces ORDER BY created_at ASC',
  ).all();
  const byPerson = new Map();
  for (const f of faces) {
    if (!byPerson.has(f.personId)) byPerson.set(f.personId, []);
    byPerson.get(f.personId).push(f);
  }
  return persons.map((p) => {
    const own = byPerson.get(p.id) || [];
    return { ...p, samples: own.length, faces: own };
  });
}

/** Ledger totals for the dashboard strip. */
function stats() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const t = dayStart.getTime();
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM persons) AS people,
      (SELECT COUNT(*) FROM faces) AS samples,
      (SELECT COUNT(*) FROM events WHERE ts >= ?) AS eventsToday,
      (SELECT COUNT(*) FROM events WHERE ts >= ? AND kind = 'face') AS facesToday,
      (SELECT COUNT(*) FROM events WHERE ts >= ? AND kind = 'face' AND person_id IS NULL) AS unknownToday,
      (SELECT COUNT(*) FROM events WHERE ts >= ? AND kind = 'object') AS objectsToday
  `).get(t, t, t, t);
}

function getPerson(personId) {
  return db.prepare('SELECT id, name, note, created_at AS createdAt FROM persons WHERE id = ?').get(personId) || null;
}

function createPerson({ name, note = '' }) {
  const personId = id();
  db.prepare('INSERT INTO persons(id, name, note, created_at) VALUES(?,?,?,?)')
    .run(personId, name, note, now());
  return getPerson(personId);
}

function removePerson(personId) {
  db.prepare('DELETE FROM persons WHERE id = ?').run(personId);
}

function addFace({ personId, embedding, thumb = null, quality = 0 }) {
  const faceId = id();
  const buf = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare('INSERT INTO faces(id, person_id, embedding, dim, thumb, quality, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(faceId, personId, buf, embedding.length, thumb, quality, now());
  return faceId;
}

/** All face embeddings, grouped by person, as plain JS Float32Arrays. */
function faceGallery() {
  const rows = db.prepare(`
    SELECT f.id, f.person_id AS personId, f.embedding, f.dim, f.thumb,
           p.name AS personName
    FROM faces f JOIN persons p ON p.id = f.person_id
  `).all();
  return rows.map((r) => {
    const blob = r.embedding;
    // ensure 4-byte alignment required by Float32Array
    const vector = blob.byteOffset % 4 === 0
      ? new Float32Array(blob.buffer, blob.byteOffset, r.dim)
      : new Float32Array(blob.slice().buffer, 0, r.dim);
    return { ...r, vector };
  });
}

function listFaces(personId) {
  return db.prepare(
    'SELECT id, person_id AS personId, thumb, quality, created_at AS createdAt FROM faces WHERE person_id = ? ORDER BY created_at DESC'
  ).all(personId);
}

function removeFace(faceId) {
  const r = db.prepare('SELECT thumb FROM faces WHERE id = ?').get(faceId);
  db.prepare('DELETE FROM faces WHERE id = ?').run(faceId);
  return r;
}

/* ---------- events ---------- */
function addEvent({ cameraId, kind, label, score = null, personId = null, snapshot = null, box = null, ts = now() }) {
  const eventId = id();
  db.prepare(
    'INSERT INTO events(id, camera_id, kind, label, score, person_id, snapshot, box, ts) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(eventId, cameraId, kind, label, score, personId, snapshot, box ? JSON.stringify(box) : null, ts);
  return eventId;
}

function queryEvents({ cameraId = null, kind = null, label = null, personId = null, since = null, until = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (cameraId) { where.push('e.camera_id = ?'); args.push(cameraId); }
  if (kind) { where.push('e.kind = ?'); args.push(kind); }
  if (label) { where.push('e.label LIKE ?'); args.push(`%${label}%`); }
  if (personId) { where.push('e.person_id = ?'); args.push(personId); }
  if (since) { where.push('e.ts >= ?'); args.push(since); }
  if (until) { where.push('e.ts <= ?'); args.push(until); }
  const sql = `
    SELECT e.id, e.camera_id AS cameraId, c.name AS cameraName, e.kind, e.label, e.score,
           e.person_id AS personId, e.snapshot, e.box, e.ts
    FROM events e LEFT JOIN cameras c ON c.id = e.camera_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.ts DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0))
    .map((r) => ({ ...r, box: r.box ? JSON.parse(r.box) : null }));
}

function eventStats(sinceTs) {
  return db.prepare(`
    SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind
  `).all(sinceTs);
}

function pruneEvents(retainDays) {
  const cutoff = now() - retainDays * 86400000;
  const old = db.prepare('SELECT id, snapshot FROM events WHERE ts < ?').all(cutoff);
  db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  for (const row of old) {
    if (row.snapshot) {
      try { fs.unlinkSync(path.join(SHOTS, path.basename(row.snapshot))); } catch { /* already gone */ }
    }
  }
  return old.length;
}

/* ---------- misc ---------- */
function shotPath(name) { return path.join(SHOTS, name); }
function shotUrl(name) { return name ? `/shots/${name}` : null; }

module.exports = {
  db, DATA, SHOTS,
  now, id,
  getSettings, setSettings, DEFAULT_SETTINGS,
  listCameras, getCamera, addCamera, updateCamera, removeCamera,
  listPersons, getPerson, createPerson, removePerson,
  addFace, faceGallery, listFaces, removeFace, stats,
  addEvent, queryEvents, eventStats, pruneEvents,
  shotPath, shotUrl,
};
