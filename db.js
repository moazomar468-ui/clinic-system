// طبقة قاعدة البيانات: libSQL (متوافقة مع SQLite).
// محليًا أو على VPS: ملف data/clinic.db — وعلى Vercel: قاعدة Turso السحابية (TURSO_DATABASE_URL)
const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const remote = process.env.TURSO_DATABASE_URL;
if (process.env.VERCEL && !remote) throw new Error('على Vercel يجب ضبط TURSO_DATABASE_URL و TURSO_AUTH_TOKEN (نظام الملفات هناك للقراءة فقط).');
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!remote) fs.mkdirSync(dataDir, { recursive: true });
const file = path.join(dataDir, 'clinic.db');
const client = createClient(remote ? { url: remote, authToken: process.env.TURSO_AUTH_TOKEN } : { url: pathToFileURL(file).href });

const norm = a => a.map(v => (v === undefined ? null : v));
const toRows = r => r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const db = {
  client, dataDir, isFile: !remote, file,
  async all(sql, ...args) { return toRows(await client.execute({ sql, args: norm(args) })); },
  async get(sql, ...args) { return (await db.all(sql, ...args))[0]; },
  async run(sql, ...args) {
    const r = await client.execute({ sql, args: norm(args) });
    return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
  },
  async batch(stmts) { await client.batch(stmts.map(([sql, ...args]) => ({ sql, args: norm(args) })), 'write'); },
  async getSettings() { return Object.fromEntries((await db.all('SELECT key,value FROM settings')).map(r => [r.key, r.value])); }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'patient' CHECK(role IN ('admin','staff','patient')),
  verified INTEGER NOT NULL DEFAULT 0,
  admin_notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS otps(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL, name_en TEXT, duration_min INTEGER NOT NULL DEFAULT 30,
  price REAL DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS holidays(date TEXT PRIMARY KEY, note TEXT);
CREATE TABLE IF NOT EXISTS appointments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER REFERENCES services(id),
  date TEXT NOT NULL, time TEXT NOT NULL, duration INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  patient_note TEXT DEFAULT '', admin_note TEXT DEFAULT '',
  reminded INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_app_date ON appointments(date);
CREATE INDEX IF NOT EXISTS idx_app_patient ON appointments(patient_id);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL, body TEXT NOT NULL, read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_msg_patient ON messages(patient_id);
CREATE TABLE IF NOT EXISTS finance(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('exam_fee','treatment_fee','payment','expense')),
  amount REAL NOT NULL,
  patient_id INTEGER REFERENCES users(id),
  appointment_id INTEGER REFERENCES appointments(id),
  note TEXT DEFAULT '', date TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff INTEGER NOT NULL DEFAULT 0, user_id INTEGER,
  data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS presence(user_id INTEGER PRIMARY KEY, role TEXT NOT NULL, ts INTEGER NOT NULL);
`;

const defaults = {
  clinic_name: 'دكتور محمد حيدر', phone: '', emergency: '', address: '', map_query: '',
  work_start: '09:00', work_end: '21:00', work_days: '0,1,2,3,4,6', slot_step: '30',
  autoreply_enabled: '1',
  autoreply_text: 'شكرًا لتواصلك. الدكتور غير متاح حاليًا وسيرد عليك في أقرب وقت. للحالات العاجلة يرجى الاتصال برقم الطوارئ.'
};
const SERVICES = [['كشف وفحص', 'Check-up', 30], ['تنظيف الأسنان', 'Cleaning', 45], ['حشو', 'Filling', 45],
  ['علاج عصب', 'Root canal', 60], ['خلع', 'Extraction', 30], ['تقويم', 'Orthodontics', 30], ['تبييض', 'Whitening', 60]];

db.ready = (async () => {
  await client.executeMultiple(SCHEMA);
  await db.batch(Object.entries(defaults).map(([k, v]) => ['INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', k, v]));
  if (!(await db.get('SELECT 1 x FROM services LIMIT 1')))
    await db.batch(SERVICES.map(s => ['INSERT INTO services(name_ar,name_en,duration_min,price) VALUES(?,?,?,0)', ...s]));
})();

module.exports = db;
