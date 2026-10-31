require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const mail = require('./mailer');

const PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('اضبط JWT_SECRET (32 حرفًا أو أكثر)');

/* ---------- أدوات ---------- */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const pad = n => String(n).padStart(2, '0');
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const phoneRe = /^\+?[0-9\s-]{7,16}$/;
const STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled', 'completed'];
const ACTIVE = ['pending', 'confirmed'];

// توقيت العيادة (لا نعتمد على توقيت السيرفر لأن Vercel يعمل بتوقيت UTC)
const CLINIC_TZ = process.env.CLINIC_TZ || 'Africa/Cairo';
const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nowLocal() {
  const p = Object.fromEntries(tzFmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();

/* ---------- المواعيد المتاحة ---------- */
async function freeSlots(date, duration, ignoreId = 0) {
  const s = await db.getSettings();
  if (await db.get('SELECT 1 x FROM holidays WHERE date=?', date)) return [];
  if (!s.work_days.split(',').map(Number).includes(dow(date))) return [];
  const now = nowLocal();
  if (date < now.date) return [];
  const start = toMin(s.work_start), end = toMin(s.work_end), step = +s.slot_step || 30;
  const busy = (await db.all("SELECT time,duration FROM appointments WHERE date=? AND status IN ('pending','confirmed') AND id!=?", date, ignoreId))
    .map(a => [toMin(a.time), toMin(a.time) + a.duration]);
  const out = [];
  for (let t = start; t + duration <= end; t += step) {
    if (date === now.date && t <= now.min) continue;
    if (busy.some(([a, b]) => t < b && t + duration > a)) continue;
    out.push(toHM(t));
  }
  return out;
}
// شرط SQL يمنع التداخل داخل نفس جملة الكتابة (ذرّي، فلا يحدث حجز مزدوج حتى مع طلبات متزامنة)
const START_MIN = "(CAST(substr(b.time,1,2) AS INTEGER)*60+CAST(substr(b.time,4,2) AS INTEGER))";
const NO_OVERLAP = `NOT EXISTS (SELECT 1 FROM appointments b WHERE b.id!=? AND b.date=? AND b.status IN ('pending','confirmed') AND ${START_MIN} < ? AND ${START_MIN}+b.duration > ?)`;
const overlapArgs = (id, date, time, dur) => [id, date, toMin(time) + dur, toMin(time)];

const APPT_SQL = `SELECT a.*, u.name patient_name, u.phone patient_phone, u.email patient_email,
  s.name_ar service_ar, s.name_en service_en
  FROM appointments a JOIN users u ON u.id=a.patient_id LEFT JOIN services s ON s.id=a.service_id`;
const getAppt = id => db.get(APPT_SQL + ' WHERE a.id=?', id);
const forPatient = ({ admin_note, ...rest }) => rest;
const adminEmails = async () => (await db.all("SELECT email FROM users WHERE role='admin'")).map(r => r.email);

/* ---------- الجلسات ---------- */
const COOKIE = 'tk';
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map(c => c.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
async function userFromToken(tok) {
  try {
    const p = jwt.verify(tok, JWT_SECRET);
    return await db.get('SELECT id,name,email,phone,role,verified FROM users WHERE id=?', p.id);
  } catch { return null; }
}
const setSession = (res, u) => res.cookie(COOKIE, jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '7d' }),
  { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
const auth = wrap(async (req, res, next) => {
  const u = await userFromToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (!u || !u.verified) return res.status(401).json({ error: 'unauthorized' });
  req.user = u; next();
});
const need = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'forbidden' });
const staff = [auth, need('admin', 'staff')];
const adminOnly = [auth, need('admin')];

/* ---------- الإشعارات الفورية (جدول events + استطلاع سريع) ---------- */
const pushStaff = p => db.run('INSERT INTO events(staff,user_id,data,created_at) VALUES(1,NULL,?,?)', JSON.stringify(p), Date.now());
const pushUser = (id, p) => db.run('INSERT INTO events(staff,user_id,data,created_at) VALUES(0,?,?,?)', id, JSON.stringify(p), Date.now());
const FRESH = 45000; // أي حساب لم يستطلع منذ 45 ثانية يُعتبر غير متصل
const isOnline = async id => !!(await db.get('SELECT 1 x FROM presence WHERE user_id=? AND ts>?', id, Date.now() - FRESH));
const staffOnline = async () => !!(await db.get("SELECT 1 x FROM presence WHERE role!='patient' AND ts>?", Date.now() - FRESH));

async function postMsg(pid, role, body) {
  const { lastInsertRowid } = await db.run('INSERT INTO messages(patient_id,sender_role,body) VALUES(?,?,?)', pid, role, body);
  const m = await db.get('SELECT * FROM messages WHERE id=?', lastInsertRowid);
  const p = await db.get('SELECT name,email FROM users WHERE id=?', pid);
  const payload = { type: 'message', message: m, patient: { id: pid, name: p.name } };
  await Promise.all([pushStaff(payload), pushUser(pid, payload)]);
  if (role === 'clinic' && !(await isOnline(pid))) mail.chat(p.email, p.name, body);
  if (role === 'patient' && !(await staffOnline())) { mail.adminChat(await adminEmails(), p.name, body); await autoReply(pid); }
  return m;
}

// رد تلقائي عندما لا يكون أي موظف أو المدير متصلًا، مرة كل 30 دقيقة لكل مريض
async function autoReply(pid) {
  const s = await db.getSettings();
  if (s.autoreply_enabled !== '1' || !s.autoreply_text) return;
  const last = await db.get("SELECT created_at FROM messages WHERE patient_id=? AND sender_role='auto' ORDER BY id DESC LIMIT 1", pid);
  if (last && Date.now() - Date.parse(last.created_at.replace(' ', 'T') + 'Z') < 30 * 60000) return;
  await postMsg(pid, 'auto', '🤖 ' + s.autoreply_text + (s.emergency ? '\n🚑 الطوارئ: ' + s.emergency : ''));
}

const apptText = async a => {
  const s = await db.getSettings();
  return `موعدك: ${a.service_ar || ''}\nالتاريخ: ${a.date}\nالساعة: ${a.time}\nالعيادة: ${s.clinic_name}\nالعنوان: ${s.address}\nللتواصل: ${s.phone}${s.emergency ? '\nالطوارئ: ' + s.emergency : ''}`;
};

/* ---------- OTP ---------- */
async function sendOtp(email, purpose) {
  const code = String(crypto.randomInt(100000, 1000000));
  await db.run('DELETE FROM otps WHERE email=? AND purpose=?', email, purpose);
  await db.run('INSERT INTO otps(email,code_hash,purpose,expires_at) VALUES(?,?,?,?)', email, bcrypt.hashSync(code, 8), purpose, Date.now() + 10 * 60000);
  mail.otp(email, code, purpose);
}
async function checkOtp(email, purpose, code) {
  const r = await db.get('SELECT * FROM otps WHERE email=? AND purpose=?', email, purpose);
  if (!r || r.expires_at < Date.now() || r.attempts >= 5) return false;
  if (!bcrypt.compareSync(String(code), r.code_hash)) { await db.run('UPDATE otps SET attempts=attempts+1 WHERE id=?', r.id); return false; }
  await db.run('DELETE FROM otps WHERE id=?', r.id);
  return true;
}

/* ---------- التهيئة وحساب المدير ---------- */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 11); // يوحّد زمن الرد حتى لا يُكشف وجود الحساب
async function seedAdmin() {
  if (await db.get("SELECT 1 x FROM users WHERE role='admin'")) return;
  const e = (process.env.ADMIN_EMAIL || '').toLowerCase(), p = process.env.ADMIN_PASSWORD || '';
  if (!emailRe.test(e) || p.length < 10) { console.warn('⚠ لا يوجد مدير. اضبط ADMIN_EMAIL و ADMIN_PASSWORD (10 أحرف فأكثر).'); return; }
  await db.run("INSERT INTO users(name,email,password_hash,role,verified) VALUES(?,?,?,'admin',1)", process.env.ADMIN_NAME || 'Admin', e, bcrypt.hashSync(p, 12));
  console.log('✔ تم إنشاء حساب المدير:', e);
}
const ready = db.ready.then(seedAdmin);

/* ---------- التطبيق ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(wrap(async (req, res, next) => { await ready; next(); }));
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], workerSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"], frameSrc: ['https://maps.google.com', 'https://www.google.com'],
  objectSrc: ["'none'"], upgradeInsecureRequests: PROD ? [] : null } } }));
app.use(express.json({ limit: '50kb' }));
// حماية CSRF إضافية: أي طلب كتابة يجب أن يحمل هذا الهيدر
app.use('/api', (req, res, next) => (req.method === 'GET' || req.headers['x-requested-with'] === 'fetch') ? next() : res.status(403).json({ error: 'forbidden' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many' }, validate: { xForwardedForHeader: false } }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ----- المصادقة ----- */
// هل يوجد حساب بهذا البريد/الهاتف؟ الجواب يحدد: خطوة كلمة المرور أم نموذج إنشاء حساب جديد
app.post('/api/auth/check', wrap(async (req, res) => {
  const id = str(req.body.identifier).toLowerCase();
  if (id.length < 3) return res.status(400).json({ error: 'invalid_input' });
  const u = await db.get('SELECT 1 x FROM users WHERE verified=1 AND (email=? OR phone=?)', id, id);
  res.json({ next: u ? 'password' : 'register' });
}));

app.post('/api/auth/register', wrap(async (req, res) => {
  const name = str(req.body.name, 80), email = str(req.body.email).toLowerCase(), phone = str(req.body.phone, 20), password = String(req.body.password || '');
  if (name.length < 2 || !emailRe.test(email) || !phoneRe.test(phone) || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'invalid_input' });
  const ex = await db.get('SELECT id,verified FROM users WHERE email=?', email);
  if (ex && ex.verified) return res.status(409).json({ error: 'email_exists' }); // لا يمكن لأحد التسجيل ببريد المدير
  const hash = await bcrypt.hash(password, 11);
  if (ex) await db.run('UPDATE users SET name=?,phone=?,password_hash=? WHERE id=?', name, phone, hash, ex.id);
  else await db.run("INSERT INTO users(name,email,phone,password_hash,role,verified) VALUES(?,?,?,?, 'patient',0)", name, email, phone, hash);
  await sendOtp(email, 'verify');
  res.json({ ok: true });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  if (!(await checkOtp(email, 'verify', str(req.body.code, 10)))) return res.status(400).json({ error: 'invalid_code' });
  await db.run('UPDATE users SET verified=1 WHERE email=?', email);
  const u = await db.get('SELECT id,name,email,phone,role FROM users WHERE email=?', email);
  mail.welcome(u.email, u.name);
  setSession(res, u);
  res.json({ user: u });
}));

app.post('/api/auth/resend', wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  const u = await db.get('SELECT verified FROM users WHERE email=?', email);
  if (u && !u.verified) await sendOtp(email, 'verify');
  res.json({ ok: true });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const id = str(req.body.identifier || req.body.email).toLowerCase(), password = String(req.body.password || '');
  const u = await db.get('SELECT * FROM users WHERE email=? OR phone=?', id, id);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: 'invalid_credentials' });
  if (!u.verified) { await sendOtp(u.email, 'verify'); return res.status(403).json({ error: 'not_verified', email: u.email }); }
  setSession(res, u);
  res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role } });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

app.post('/api/auth/forgot', wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  if (await db.get('SELECT 1 x FROM users WHERE email=?', email)) await sendOtp(email, 'reset');
  res.json({ ok: true });
}));

app.post('/api/auth/reset', wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase(), password = String(req.body.password || '');
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'invalid_input' });
  if (!(await checkOtp(email, 'reset', str(req.body.code, 10)))) return res.status(400).json({ error: 'invalid_code' });
  await db.run('UPDATE users SET password_hash=?, verified=1 WHERE email=?', await bcrypt.hash(password, 11), email);
  res.json({ ok: true });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

/* ----- الاستطلاع الفوري للأحداث (رسائل وحجوزات جديدة) ----- */
app.get('/api/events', auth, wrap(async (req, res) => {
  const after = Number(req.query.after);
  await db.run('INSERT INTO presence(user_id,role,ts) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ts=excluded.ts, role=excluded.role', req.user.id, req.user.role, Date.now());
  if (!(after >= 0)) return res.json({ events: [], last: (await db.get('SELECT COALESCE(MAX(id),0) m FROM events')).m });
  const rows = await db.all("SELECT id,data FROM events WHERE id>? AND ((staff=1 AND ?!='patient') OR user_id=?) ORDER BY id LIMIT 100", after, req.user.role, req.user.id);
  if (Math.random() < 0.02) await db.run('DELETE FROM events WHERE created_at<?', Date.now() - 864e5);
  res.json({ events: rows.map(r => JSON.parse(r.data)), last: rows.length ? rows[rows.length - 1].id : after });
}));

/* ----- بيانات عامة ----- */
app.get('/api/clinic', wrap(async (req, res) => {
  res.json({
    settings: await db.getSettings(),
    services: await db.all('SELECT id,name_ar,name_en,duration_min,price FROM services WHERE active=1 ORDER BY id'),
    holidays: await db.all('SELECT date,note FROM holidays WHERE date>=? ORDER BY date', nowLocal().date)
  });
}));

app.get('/api/slots', wrap(async (req, res) => {
  const date = str(req.query.date, 10), svc = await db.get('SELECT duration_min FROM services WHERE id=?', +req.query.service_id);
  if (!isDate(date) || !svc) return res.status(400).json({ error: 'invalid_input' });
  res.json({ slots: await freeSlots(date, svc.duration_min, +req.query.exclude || 0) });
}));

/* ----- المريض ----- */
app.post('/api/appointments', auth, need('patient'), wrap(async (req, res) => {
  const sid = +req.body.service_id, date = str(req.body.date, 10), time = str(req.body.time, 5), note = str(req.body.note, 500);
  const svc = await db.get('SELECT * FROM services WHERE id=? AND active=1', sid);
  if (!svc || !isDate(date) || !isTime(time)) return res.status(400).json({ error: 'invalid_input' });
  const open = (await db.get("SELECT COUNT(*) n FROM appointments WHERE patient_id=? AND status IN ('pending','confirmed') AND date>=?", req.user.id, nowLocal().date)).n;
  if (open >= 5) return res.status(429).json({ error: 'too_many_active' });
  if (!(await freeSlots(date, svc.duration_min)).includes(time)) return res.status(409).json({ error: 'slot_taken' });
  const r = await db.run(`INSERT INTO appointments(patient_id,service_id,date,time,duration,patient_note)
    SELECT ?,?,?,?,?,? WHERE ${NO_OVERLAP}`, req.user.id, sid, date, time, svc.duration_min, note, ...overlapArgs(0, date, time, svc.duration_min));
  if (!r.changes) return res.status(409).json({ error: 'slot_taken' });
  const a = await getAppt(r.lastInsertRowid);
  await pushStaff({ type: 'appointment', event: 'new', appointment: a });
  mail.adminNew(await adminEmails(), a);
  mail.appt(req.user.email, 'received', a);
  res.json({ appointment: forPatient(a) });
}));

app.get('/api/appointments', auth, need('patient'), wrap(async (req, res) => {
  res.json({ appointments: (await db.all(APPT_SQL + ' WHERE a.patient_id=? ORDER BY a.date DESC, a.time DESC', req.user.id)).map(forPatient) });
}));

app.post('/api/appointments/:id/cancel', auth, need('patient'), wrap(async (req, res) => {
  const a = await getAppt(+req.params.id);
  if (!a || a.patient_id !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (!ACTIVE.includes(a.status)) return res.status(400).json({ error: 'invalid_input' });
  await db.run("UPDATE appointments SET status='cancelled' WHERE id=?", a.id);
  const n = await getAppt(a.id);
  await pushStaff({ type: 'appointment', event: 'cancelled', appointment: n });
  mail.adminNew(await adminEmails(), { ...n, service_ar: (n.service_ar || '') + ' (ألغاه المريض)' });
  res.json({ ok: true });
}));

app.get('/api/chat', auth, need('patient'), wrap(async (req, res) => {
  await db.run("UPDATE messages SET read=1 WHERE patient_id=? AND sender_role!='patient'", req.user.id);
  res.json({ messages: await db.all('SELECT * FROM messages WHERE patient_id=? ORDER BY id', req.user.id) });
}));
app.get('/api/chat/unread', auth, need('patient'), wrap(async (req, res) => {
  res.json({ n: (await db.get("SELECT COUNT(*) n FROM messages WHERE patient_id=? AND sender_role!='patient' AND read=0", req.user.id)).n });
}));
app.post('/api/chat', auth, need('patient'), wrap(async (req, res) => {
  const body = str(req.body.body, 1000);
  if (!body) return res.status(400).json({ error: 'invalid_input' });
  res.json({ message: await postMsg(req.user.id, 'patient', body) });
}));

/* ----- الإدارة والموظفون ----- */
app.get('/api/admin/stats', ...staff, wrap(async (req, res) => {
  const today = nowLocal().date, week = addDays(today, 6), month = today.slice(0, 7);
  const c = async (w, ...p) => (await db.get(`SELECT COUNT(*) n FROM appointments WHERE ${w}`, ...p)).n;
  const out = {
    total: await c('1=1'), pending: await c("status='pending'"), confirmed: await c("status='confirmed'"),
    cancelled: await c("status IN ('cancelled','rejected')"),
    patients: (await db.get("SELECT COUNT(*) n FROM users WHERE role='patient' AND verified=1")).n,
    today: await c("date=? AND status IN ('pending','confirmed','completed')", today),
    week: await c("date BETWEEN ? AND ? AND status IN ('pending','confirmed','completed')", today, week),
    month: await c("date LIKE ? AND status IN ('pending','confirmed','completed')", month + '%')
  };
  if (req.user.role === 'admin') {
    const f = await db.get(`SELECT
      COALESCE(SUM(CASE WHEN kind IN('exam_fee','treatment_fee') THEN amount END),0) charges,
      COALESCE(SUM(CASE WHEN kind='payment' THEN amount END),0) payments,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount END),0) expenses
      FROM finance WHERE date LIKE ?`, month + '%');
    out.finance = { ...f, remaining: f.charges - f.payments };
  }
  res.json(out);
}));

app.get('/api/admin/appointments', ...staff, wrap(async (req, res) => {
  const w = ['1=1'], p = [];
  const st = str(req.query.status, 20), from = str(req.query.from, 10), to = str(req.query.to, 10), q = str(req.query.q, 60);
  if (STATUSES.includes(st)) { w.push('a.status=?'); p.push(st); }
  if (isDate(from)) { w.push('a.date>=?'); p.push(from); }
  if (isDate(to)) { w.push('a.date<=?'); p.push(to); }
  if (q) { w.push('(u.name LIKE ? OR u.phone LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  res.json({ appointments: await db.all(`${APPT_SQL} WHERE ${w.join(' AND ')} ORDER BY a.date, a.time LIMIT 1000`, ...p) });
}));

app.patch('/api/admin/appointments/:id', ...staff, wrap(async (req, res) => {
  const a = await getAppt(+req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  const b = req.body;
  const st = b.status !== undefined ? str(b.status, 20) : a.status;
  const date = b.date !== undefined ? str(b.date, 10) : a.date;
  const time = b.time !== undefined ? str(b.time, 5) : a.time;
  if (!STATUSES.includes(st) || !isDate(date) || !isTime(time)) return res.status(400).json({ error: 'invalid_input' });
  const moved = date !== a.date || time !== a.time;
  const reactivating = !ACTIVE.includes(a.status) && ACTIVE.includes(st);
  const guard = ACTIVE.includes(st) && (moved || reactivating);
  if (guard && !(await freeSlots(date, a.duration, a.id)).includes(time)) return res.status(409).json({ error: 'slot_taken' });
  const r = await db.run(`UPDATE appointments SET status=?,date=?,time=?,admin_note=?,reminded=? WHERE id=?${guard ? ' AND ' + NO_OVERLAP : ''}`,
    st, date, time, b.admin_note !== undefined ? str(b.admin_note, 1000) : a.admin_note, moved ? 0 : a.reminded, a.id,
    ...(guard ? overlapArgs(a.id, date, time, a.duration) : []));
  if (!r.changes) return res.status(409).json({ error: 'slot_taken' });
  const n = await getAppt(a.id);
  const kind = st !== a.status ? ({ confirmed: 'confirmed', rejected: 'rejected', cancelled: 'cancelled' })[st] : (moved ? 'rescheduled' : null);
  if (kind) {
    mail.appt(n.patient_email, kind, n);
    await pushUser(n.patient_id, { type: 'appointment', event: kind, appointment: forPatient(n) });
    if (kind === 'confirmed' || kind === 'rescheduled') await postMsg(n.patient_id, 'clinic', (kind === 'confirmed' ? '✅ تم تأكيد موعدك\n' : '🔄 تم تعديل موعدك\n') + await apptText(n));
  }
  await pushStaff({ type: 'appointment', event: 'updated', appointment: n });
  res.json({ appointment: n });
}));

app.post('/api/admin/appointments/:id/send-details', ...staff, wrap(async (req, res) => {
  const a = await getAppt(+req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  await postMsg(a.patient_id, 'clinic', await apptText(a));
  res.json({ ok: true });
}));

app.get('/api/admin/patients', ...staff, wrap(async (req, res) => {
  const q = str(req.query.q, 60), isAdmin = req.user.role === 'admin';
  const rows = await db.all(`SELECT u.id,u.name,u.phone,u.email,u.admin_notes,u.created_at,
    (SELECT COUNT(*) FROM appointments WHERE patient_id=u.id) visits,
    (SELECT COALESCE(SUM(CASE WHEN kind IN('exam_fee','treatment_fee') THEN amount WHEN kind='payment' THEN -amount END),0) FROM finance WHERE patient_id=u.id) balance
    FROM users u WHERE u.role='patient' AND u.verified=1 AND (?='' OR u.name LIKE ? OR u.phone LIKE ?) ORDER BY u.name LIMIT 500`, q, `%${q}%`, `%${q}%`);
  res.json({ patients: rows.map(r => isAdmin ? r : { ...r, balance: null }) });
}));
app.patch('/api/admin/patients/:id', ...staff, wrap(async (req, res) => {
  const r = await db.run("UPDATE users SET admin_notes=? WHERE id=? AND role='patient'", str(req.body.admin_notes, 2000), +req.params.id);
  res.json({ ok: r.changes > 0 });
}));

app.get('/api/admin/chats', ...staff, wrap(async (req, res) => {
  res.json({ chats: await db.all(`SELECT u.id,u.name,u.phone,
    (SELECT body FROM messages WHERE patient_id=u.id ORDER BY id DESC LIMIT 1) last,
    (SELECT created_at FROM messages WHERE patient_id=u.id ORDER BY id DESC LIMIT 1) last_at,
    (SELECT COUNT(*) FROM messages WHERE patient_id=u.id AND sender_role='patient' AND read=0) unread
    FROM users u WHERE u.role='patient' AND EXISTS(SELECT 1 FROM messages WHERE patient_id=u.id) ORDER BY last_at DESC`) });
}));
app.get('/api/admin/chats/:pid', ...staff, wrap(async (req, res) => {
  const pid = +req.params.pid;
  await db.run("UPDATE messages SET read=1 WHERE patient_id=? AND sender_role='patient'", pid);
  res.json({ messages: await db.all('SELECT * FROM messages WHERE patient_id=? ORDER BY id', pid) });
}));
app.post('/api/admin/chats/:pid', ...staff, wrap(async (req, res) => {
  const pid = +req.params.pid, body = str(req.body.body, 1000);
  if (!body || !(await db.get("SELECT 1 x FROM users WHERE id=? AND role='patient'", pid))) return res.status(400).json({ error: 'invalid_input' });
  res.json({ message: await postMsg(pid, 'clinic', body) });
}));

/* ----- المالية (للمدير فقط) ----- */
app.get('/api/admin/finance', ...adminOnly, wrap(async (req, res) => {
  const pid = +req.query.patient_id || 0;
  res.json({ rows: await db.all(`SELECT f.*, u.name patient_name FROM finance f LEFT JOIN users u ON u.id=f.patient_id
    WHERE (?=0 OR f.patient_id=?) ORDER BY f.date DESC, f.id DESC LIMIT 300`, pid, pid) });
}));
app.post('/api/admin/finance', ...adminOnly, wrap(async (req, res) => {
  const kind = str(req.body.kind, 20), amount = Number(req.body.amount), date = str(req.body.date, 10) || nowLocal().date;
  const pid = +req.body.patient_id || null, aid = +req.body.appointment_id || null;
  if (!['exam_fee', 'treatment_fee', 'payment', 'expense'].includes(kind) || !(amount > 0) || amount > 1e9 || !isDate(date)) return res.status(400).json({ error: 'invalid_input' });
  if (kind !== 'expense' && !(pid && await db.get("SELECT 1 x FROM users WHERE id=? AND role='patient'", pid))) return res.status(400).json({ error: 'invalid_input' });
  await db.run('INSERT INTO finance(kind,amount,patient_id,appointment_id,note,date) VALUES(?,?,?,?,?,?)', kind, amount, kind === 'expense' ? null : pid, aid, str(req.body.note, 300), date);
  res.json({ ok: true });
}));
app.delete('/api/admin/finance/:id', ...adminOnly, wrap(async (req, res) => { await db.run('DELETE FROM finance WHERE id=?', +req.params.id); res.json({ ok: true }); }));
app.get('/api/admin/finance/report', ...adminOnly, wrap(async (req, res) => {
  const period = req.query.period === 'monthly' ? 'monthly' : 'daily', ref = str(req.query.ref, 10) || nowLocal().date;
  const len = period === 'daily' ? 10 : 7, like = (period === 'daily' ? ref.slice(0, 7) : ref.slice(0, 4)) + '%';
  res.json({ rows: await db.all(`SELECT substr(date,1,${len}) k,
    COALESCE(SUM(CASE WHEN kind IN('exam_fee','treatment_fee') THEN amount END),0) charges,
    COALESCE(SUM(CASE WHEN kind='payment' THEN amount END),0) payments,
    COALESCE(SUM(CASE WHEN kind='expense' THEN amount END),0) expenses
    FROM finance WHERE date LIKE ? GROUP BY k ORDER BY k`, like) });
}));

const KIND_AR = { exam_fee: 'كشف', treatment_fee: 'علاج', payment: 'دفعة', expense: 'مصروف' };
app.get('/api/admin/invoice/:pid', ...adminOnly, wrap(async (req, res) => {
  const p = await db.get("SELECT * FROM users WHERE id=? AND role='patient'", +req.params.pid);
  if (!p) return res.status(404).send('Not found');
  const aid = +req.query.appointment_id || 0;
  const rows = await db.all('SELECT * FROM finance WHERE patient_id=? AND (?=0 OR appointment_id=?) ORDER BY date,id', p.id, aid, aid);
  const charges = rows.filter(r => r.kind.endsWith('_fee')).reduce((s, r) => s + r.amount, 0);
  const paid = rows.filter(r => r.kind === 'payment').reduce((s, r) => s + r.amount, 0);
  const s = await db.getSettings(), e = mail.esc;
  res.type('html').send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>فاتورة</title>
<style>body{font-family:Tahoma,Arial,sans-serif;max-width:720px;margin:24px auto;color:#123}h1{color:#0f9d9a;margin:0}
table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #cfe3e3;padding:8px;text-align:right}th{background:#eaf6f6}
.t{font-size:18px;font-weight:bold}button{padding:8px 18px;background:#0f9d9a;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer}
@media print{button{display:none}}</style></head><body>
<h1>🦷 ${e(s.clinic_name)}</h1><div>${e(s.address)} · ${e(s.phone)}</div><hr>
<h2>فاتورة رقم ${Date.now().toString().slice(-6)}</h2>
<div>المريض: <b>${e(p.name)}</b> · ${e(p.phone)}<br>التاريخ: ${nowLocal().date}</div>
<table><tr><th>التاريخ</th><th>البند</th><th>ملاحظة</th><th>المبلغ</th></tr>
${rows.map(r => `<tr><td>${e(r.date)}</td><td>${KIND_AR[r.kind]}</td><td>${e(r.note)}</td><td>${r.kind === 'payment' ? '-' : ''}${r.amount.toFixed(2)}</td></tr>`).join('')}</table>
<div>إجمالي التكاليف: <b>${charges.toFixed(2)}</b><br>إجمالي المدفوع: <b>${paid.toFixed(2)}</b><br><span class="t">المتبقي: ${(charges - paid).toFixed(2)}</span></div>
<p><button id="p">طباعة</button></p><script src="/js/print.js"></script></body></html>`);
}));

/* ----- الإعدادات والخدمات والإجازات والموظفون (للمدير) ----- */
app.put('/api/admin/settings', ...adminOnly, wrap(async (req, res) => {
  const b = req.body, next = await db.getSettings();
  for (const k of ['clinic_name', 'phone', 'emergency', 'address', 'map_query']) if (b[k] !== undefined) next[k] = str(b[k], 200);
  if (b.work_start !== undefined) next.work_start = str(b.work_start, 5);
  if (b.work_end !== undefined) next.work_end = str(b.work_end, 5);
  if (b.work_days !== undefined) next.work_days = String(b.work_days).split(',').map(Number).filter(n => n >= 0 && n <= 6).join(',');
  if (b.autoreply_enabled !== undefined) next.autoreply_enabled = String(b.autoreply_enabled) === '1' ? '1' : '0';
  if (b.autoreply_text !== undefined) next.autoreply_text = str(b.autoreply_text, 500);
  if (b.slot_step !== undefined) next.slot_step = String(Math.round(+b.slot_step));
  if (!isTime(next.work_start) || !isTime(next.work_end) || toMin(next.work_start) >= toMin(next.work_end) || !(+next.slot_step >= 5 && +next.slot_step <= 120)) return res.status(400).json({ error: 'invalid_input' });
  await db.batch(Object.entries(next).map(([k, v]) => ['INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v]));
  res.json({ settings: await db.getSettings() });
}));

app.get('/api/admin/services', ...adminOnly, wrap(async (req, res) => res.json({ services: await db.all('SELECT * FROM services ORDER BY active DESC,id') })));
const svcInput = b => ({ ar: str(b.name_ar, 80), en: str(b.name_en, 80), d: Math.round(+b.duration_min), p: Math.max(0, +b.price || 0) });
app.post('/api/admin/services', ...adminOnly, wrap(async (req, res) => {
  const s = svcInput(req.body);
  if (!s.ar || !(s.d >= 5 && s.d <= 480)) return res.status(400).json({ error: 'invalid_input' });
  await db.run('INSERT INTO services(name_ar,name_en,duration_min,price) VALUES(?,?,?,?)', s.ar, s.en, s.d, s.p);
  res.json({ ok: true });
}));
app.put('/api/admin/services/:id', ...adminOnly, wrap(async (req, res) => {
  const s = svcInput(req.body);
  if (!s.ar || !(s.d >= 5 && s.d <= 480)) return res.status(400).json({ error: 'invalid_input' });
  await db.run('UPDATE services SET name_ar=?,name_en=?,duration_min=?,price=?,active=? WHERE id=?', s.ar, s.en, s.d, s.p, req.body.active === false ? 0 : 1, +req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/admin/services/:id', ...adminOnly, wrap(async (req, res) => { await db.run('UPDATE services SET active=0 WHERE id=?', +req.params.id); res.json({ ok: true }); }));

app.post('/api/admin/holidays', ...adminOnly, wrap(async (req, res) => {
  const date = str(req.body.date, 10);
  if (!isDate(date)) return res.status(400).json({ error: 'invalid_input' });
  await db.run('INSERT OR REPLACE INTO holidays(date,note) VALUES(?,?)', date, str(req.body.note, 100));
  res.json({ ok: true });
}));
app.delete('/api/admin/holidays/:date', ...adminOnly, wrap(async (req, res) => { await db.run('DELETE FROM holidays WHERE date=?', req.params.date); res.json({ ok: true }); }));

app.get('/api/admin/staff', ...adminOnly, wrap(async (req, res) => res.json({ staff: await db.all("SELECT id,name,email,role FROM users WHERE role IN ('admin','staff') ORDER BY role,id") })));
app.post('/api/admin/staff', ...adminOnly, wrap(async (req, res) => {
  const name = str(req.body.name, 80), email = str(req.body.email).toLowerCase(), password = String(req.body.password || '');
  if (name.length < 2 || !emailRe.test(email) || password.length < 10 || password.length > 72) return res.status(400).json({ error: 'invalid_input' });
  if (await db.get('SELECT 1 x FROM users WHERE email=?', email)) return res.status(409).json({ error: 'email_exists' });
  await db.run("INSERT INTO users(name,email,password_hash,role,verified) VALUES(?,?,?,'staff',1)", name, email, await bcrypt.hash(password, 11));
  res.json({ ok: true });
}));
app.delete('/api/admin/staff/:id', ...adminOnly, wrap(async (req, res) => { await db.run("DELETE FROM users WHERE id=? AND role='staff'", +req.params.id); res.json({ ok: true }); }));

/* ----- النسخ الاحتياطي (للملف المحلي فقط؛ على Turso استخدم نسخهم الاحتياطية) ----- */
async function backupNow() {
  if (!db.isFile) throw Object.assign(new Error('not_supported'), { status: 400 });
  const dir = path.join(db.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `clinic-${nowLocal().date}.db`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  await db.client.execute(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  fs.readdirSync(dir).filter(x => x.endsWith('.db')).sort().slice(0, -14).forEach(x => fs.unlinkSync(path.join(dir, x)));
  return f;
}
app.get('/api/admin/backup', ...adminOnly, wrap(async (req, res) => {
  try { res.download(await backupNow()); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));

/* ----- التذكيرات ----- */
// mode='daily': مهمة يومية (Vercel Hobby) تذكّر بمواعيد اليوم المتبقية وغدًا
// mode='window': تعمل كل 30 دقيقة على VPS وتذكّر قبل الموعد بـ 24 ساعة
async function sendReminders(mode) {
  const now = nowLocal();
  const rows = await db.all(APPT_SQL + " WHERE a.status='confirmed' AND a.reminded=0 AND a.date BETWEEN ? AND ?", now.date, addDays(now.date, 2));
  const jobs = []; let n = 0;
  for (const a of rows) {
    const days = Math.round((Date.parse(a.date) - Date.parse(now.date)) / 864e5);
    const diff = days * 1440 + toMin(a.time) - now.min;
    const due = mode === 'daily' ? (diff > 0 && days <= 1) : (diff > 0 && diff <= 1440);
    if (!due) continue;
    await db.run('UPDATE appointments SET reminded=1 WHERE id=?', a.id);
    jobs.push(mail.appt(a.patient_email, 'reminder', a)); n++;
  }
  await Promise.allSettled(jobs);
  return n;
}
app.get('/api/cron/reminders', wrap(async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  res.json({ sent: await sendReminders('daily') });
}));

/* ----- أخطاء ----- */
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });

module.exports = app;
module.exports.sendReminders = sendReminders;
module.exports.backupNow = backupNow;
module.exports.ready = ready;
