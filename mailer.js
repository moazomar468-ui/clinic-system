const nodemailer = require('nodemailer');
const db = require('./db');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let tx = null;
if (process.env.SMTP_HOST) {
  tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: +process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
} else {
  console.warn('⚠ SMTP غير مضبوط: الرسائل تُطبع في سجل السيرفر فقط ولا تُرسل.');
}

const layout = async (title, body) => {
  const s = await db.getSettings();
  return `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #d9ecec;border-radius:12px;overflow:hidden">
<div style="background:#0f9d9a;color:#fff;padding:16px 20px;font-size:18px">🦷 ${esc(s.clinic_name)}</div>
<div style="padding:20px;line-height:1.9;color:#223"><h3 style="margin-top:0">${esc(title)}</h3>${body}</div>
<div style="background:#f4fafa;padding:12px 20px;font-size:13px;color:#456">📞 ${esc(s.phone)} &nbsp;·&nbsp; 🚑 ${esc(s.emergency)}<br>📍 ${esc(s.address)}</div></div>`;
};

async function send(to, subject, htmlP) {
  if (!to) return;
  const html = await htmlP;
  if (!tx) { console.log('[MAIL-DEV]', to, '|', subject, '|', html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 240)); return; }
  try {
    await tx.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html });
  } catch (e) { console.error('mail error:', e.message); }
}

const apptTable = a => `<table style="border-collapse:collapse;margin:8px 0">
<tr><td style="padding:4px 12px;color:#678">الخدمة</td><td><b>${esc(a.service_ar || '-')}</b></td></tr>
<tr><td style="padding:4px 12px;color:#678">التاريخ</td><td><b>${esc(a.date)}</b></td></tr>
<tr><td style="padding:4px 12px;color:#678">الساعة</td><td><b>${esc(a.time)}</b></td></tr></table>`;

const KINDS = {
  received: ['استلمنا طلب حجزك', 'تم استلام طلب الحجز وسيتم تأكيده من الإدارة قريبًا.'],
  confirmed: ['تم تأكيد موعدك', 'يسعدنا تأكيد موعدك التالي:'],
  rescheduled: ['تم تعديل موعدك', 'تم تعديل موعدك ليصبح كما يلي:'],
  cancelled: ['تم إلغاء الموعد', 'تم إلغاء الموعد التالي:'],
  rejected: ['تعذّر قبول الحجز', 'نعتذر، لم نتمكن من قبول طلب الحجز التالي. يمكنك اختيار موعد آخر أو التواصل معنا:'],
  reminder: ['تذكير بموعدك', 'نذكّرك بموعدك القادم خلال الـ 24 ساعة المقبلة:']
};

// على Vercel يجب إبقاء الدالة حيّة حتى ينتهي الإرسال (waitUntil)، وإلا قد تُقطع قبل وصول الرسالة
const bg = p => {
  p = Promise.resolve(p).catch(e => console.error('mail error:', e.message));
  try { require('@vercel/functions').waitUntil(p); } catch { }
  return p;
};
const api = {
  esc,
  otp: (to, code, purpose) => send(to, 'رمز التحقق',
    layout(purpose === 'reset' ? 'استعادة كلمة المرور' : 'تأكيد التسجيل',
      `<p>رمز التحقق الخاص بك:</p><p style="font-size:30px;letter-spacing:6px;font-weight:bold;color:#0f9d9a">${esc(code)}</p><p>صالح لمدة 10 دقائق. إذا لم تطلبه فتجاهل هذه الرسالة.</p>`)),
  welcome: (to, name) => send(to, 'تم تأكيد تسجيلك',
    layout('أهلًا بك ' + name, '<p>تم تأكيد حسابك بنجاح، ويمكنك الآن حجز موعدك ومتابعته من خلال حسابك.</p>')),
  appt: (to, kind, a) => {
    const [subject, intro] = KINDS[kind];
    return send(to, subject, layout(subject, `<p>${intro}</p>${apptTable(a)}`));
  },
  adminNew: (emails, a) => Promise.all(emails.map(e => send(e, 'حجز جديد',
    layout('وصل حجز جديد', `<p>المريض: <b>${esc(a.patient_name)}</b> (${esc(a.patient_phone)})</p>${apptTable(a)}`)))),
  chat: (to, name, body) => send(to, 'رسالة جديدة من العيادة',
    layout('رسالة جديدة', `<p>مرحبًا ${esc(name)}،</p><blockquote style="border-right:3px solid #0f9d9a;margin:8px 0;padding:4px 12px;white-space:pre-line">${esc(body)}</blockquote><p>ادخل إلى حسابك للرد.</p>`)),
  adminChat: (emails, name, body) => Promise.all(emails.map(e => send(e, 'رسالة جديدة من مريض',
    layout('رسالة من ' + name, `<blockquote style="border-right:3px solid #0f9d9a;margin:8px 0;padding:4px 12px;white-space:pre-line">${esc(body)}</blockquote>`))))
};
const out = { esc };
for (const [k, f] of Object.entries(api)) if (k !== 'esc') out[k] = (...a) => bg(f(...a));
module.exports = out;
