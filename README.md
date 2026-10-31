# نظام حجز وإدارة عيادة د. محمد حيدر

Node.js + Express + قاعدة libSQL (SQLite) + بريد Nodemailer. يعمل بنفس الكود على **Vercel** وعلى **VPS** وعلى جهازك.

## الهيكل
```
app.js         كل الـ API والمنطق (يُصدَّر كتطبيق Express)
api/index.js   نقطة دخول Vercel
server.js      تشغيل محلي / VPS
db.js          قاعدة البيانات: ملف data/clinic.db محليًا، أو Turso على Vercel
mailer.js      رسائل البريد
public/        الواجهات: auth.html (دخول/تسجيل) · index.html (المريض) · admin.html (الإدارة)
vercel.json    إعداد Vercel (التوجيه + مهمة التذكير اليومية)
```

## 1) التشغيل محليًا
```bash
npm install
npm start          # http://localhost:3000/auth.html
```
ملف `.env` الموجود للتجربة فيه حساب مدير وهمي. غيّره قبل أي نشر حقيقي.

## 2) النشر على Vercel
**أ) قاعدة البيانات (Turso، فيها خطة مجانية):** Vercel لا تحفظ ملفات، فنحتاج قاعدة سحابية.
```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup
turso db create dental
turso db show dental --url          # انسخ الرابط  → TURSO_DATABASE_URL
turso db tokens create dental       # انسخ الرمز    → TURSO_AUTH_TOKEN
```
الجداول تُنشأ تلقائيًا أول طلب.

**ب) رفع المشروع:** ارفعه على GitHub (ملف .env لا يُرفع)، ثم في Vercel اختر Add New → Project → اختر المستودع. أو من الطرفية: `npm i -g vercel && vercel`.

**ج) المتغيرات:** من Project Settings → Environment Variables أضف:

| المتغير | القيمة |
|---|---|
| JWT_SECRET | نص عشوائي 32+ حرفًا (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD | حساب المدير الحقيقي (كلمة مرور 10+ أحرف) |
| TURSO_DATABASE_URL / TURSO_AUTH_TOKEN | من الخطوة (أ) |
| CRON_SECRET | أي نص عشوائي طويل (يحمي مهمة التذكير) |
| SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM | بيانات البريد |
| CLINIC_TZ | `Africa/Cairo` |

بعد أول نشر ناجح وتسجيل دخولك احذف ADMIN_PASSWORD من المتغيرات وأعد النشر.

**د) الدومين:** Project → Settings → Domains → أضف دومينك واتبع سجلات DNS التي تظهر.

### ملاحظات مهمة على Vercel
- **الخطة:** خطة Hobby المجانية للاستخدام الشخصي غير التجاري فقط حسب شروط Vercel، وعيادة تعمل بنظام حجز تُعدّ استخدامًا تجاريًا، فالمناسب خطة Pro (حوالي 20 دولارًا شهريًا). راجع شروطهم الحالية.
- **الشات:** WebSocket غير مدعوم على Vercel، فالنظام يتحقق من الرسائل الجديدة كل ~2.5 ثانية. تصل خلال ثانيتين إلى ثلاث تقريبًا.
- **التذكيرات:** مهمة يومية (15:00 UTC) ترسل تذكيرًا بمواعيد اليوم المتبقية وغدًا. الخطة المجانية تسمح بمرة يوميًا فقط. وعلى VPS تعمل كل 30 دقيقة (قبل الموعد بـ 24 ساعة).
- **النسخ الاحتياطي:** زر التنزيل داخل الإعدادات يعمل مع الملف المحلي فقط. على Turso استخدم نسخهم الاحتياطية (`turso db shell` / لوحة Turso).

## 3) النشر على VPS (بدون Turso)
```bash
npm install --omit=dev && cp .env.example .env && nano .env   # بدون TURSO_*
npm i -g pm2 && pm2 start server.js --name dental && pm2 save && pm2 startup
```
ضع nginx أمامه (`proxy_pass http://127.0.0.1:3000;` + شهادة HTTPS عبر certbot). لا تحتاج ترويسات WebSocket. القاعدة ملف `data/clinic.db` ونسخ تلقائية كل 6 ساعات في `data/backups`.

## البريد الإلكتروني
أي مزود SMTP يصلح: بريد دومينك، أو Gmail (كلمة مرور تطبيق App Password)، أو Brevo/Mailgun/SendGrid. أضف سجلات SPF و DKIM للدومين حتى لا تذهب الرسائل للسبام. بدون SMTP تُطبع الرسائل في السجل فقط.

## الأمان
bcrypt لكلمات المرور، كوكي HttpOnly + SameSite، رموز OTP مشفّرة ومحدودة المحاولات، Helmet و CSP، صلاحيات مفروضة على السيرفر (مدير / موظف / مريض)، ومنع حجز نفس الموعد داخل قاعدة البيانات نفسها.
