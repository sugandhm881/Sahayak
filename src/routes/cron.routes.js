const express = require('express');
const router = express.Router();

const env = require('../config/env');
const { getAllUsers } = require('../middleware/tenant');
const { generateReportExcel } = require('../services/excel/report');
const { getSellerProfile } = require('../repositories/configs.repo');
const { sendEmailWithAttachment } = require('../services/email');
const { formatDDMonYYYY } = require('../utils/dates');

router.get('/send-daily-report', async (req, res) => {
  const auth = req.headers.authorization;
  const expected = `Bearer ${env.CRON_SECRET}`;
  if (auth !== expected) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const current_hour_utc = new Date().getUTCHours();
    if (current_hour_utc !== env.REPORT_HOUR_UTC) {
      return res.json({ status: 'skipped', reason: `hour ${current_hour_utc} != REPORT_HOUR_UTC ${env.REPORT_HOUR_UTC}` });
    }
    // simulate a dummy session for master, then sub-users
    const users = await getAllUsers({ session: {} });
    const results = [];
    for (const uid of users) {
      {
        const fakeReq = { session: { user: { id: uid, is_master: uid === env.MASTER_USERNAME, payment_active: true, permissions: ['sale','purchase'] } } };
        const buf = await generateReportExcel(fakeReq, uid);
        if (buf) {
          const profile = await getSellerProfile(fakeReq, uid);
          const seller_email = profile.email || (uid === env.MASTER_USERNAME ? env.EMAIL_USER : null);
          if (seller_email) {
            const subject = `Daily Sales Report - ${profile.company_name || uid} - ${formatDDMonYYYY()}`;
            await sendEmailWithAttachment(seller_email, subject, 'Attached is your cumulative sales report.', buf, `Report_${formatDDMonYYYY()}.xlsx`);
            results.push(`Sent to ${uid}`);
          } else {
            results.push(`Skipped ${uid}: No email`);
          }
        } else {
          results.push(`Skipped ${uid}: No invoices`);
        }
      }
    }
    res.json({ status: 'success', log: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
