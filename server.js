// تشغيل محلي أو على VPS. (على Vercel يُستخدم api/index.js بدلًا منه)
const app = require('./app');
const PORT = +process.env.PORT || 3000;
app.ready.then(() => {
  app.listen(PORT, () => console.log(`🦷 Dental system running on http://localhost:${PORT}`));
  setInterval(() => app.sendReminders('window').catch(e => console.error('reminders', e.message)), 30 * 60000);
  if (app.backupNow) {
    const bk = () => app.backupNow().catch(e => e.message !== 'not_supported' && console.error('backup', e.message));
    bk(); setInterval(bk, 6 * 3600e3);
  }
}).catch(e => { console.error(e); process.exit(1); });
