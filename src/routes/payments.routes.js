const express = require('express');
const router = express.Router();

const { loginRequired } = require('../middleware/auth');
const { perMinute } = require('../middleware/rateLimit');

const { listPayments, upsertPayment, getPayment, deletePayment, allPaymentsRaw } = require('../repositories/payments.repo');
const { getDocumentRow, updateDocumentData, loadInvoices } = require('../repositories/documents.repo');
const { loadClients } = require('../repositories/clients.repo');
const { getSellerProfile } = require('../repositories/configs.repo');
const { generateReceiptPdf } = require('../services/pdf/receiptPdf');
const { sendEmailWithAttachment } = require('../services/email');
const { formatDDMonYYYY, nowIso } = require('../utils/dates');

router.get('/payments', loginRequired, async (req, res) => {
  try { res.json(await listPayments(req)); } catch { res.json([]); }
});

router.post('/payments', loginRequired, async (req, res) => {
  try {
    const data = req.body || {};
    const party = (data.party_name || '').trim();
    const amt = parseFloat(data.amount || 0);
    if (!party || amt <= 0) return res.status(400).json({ error: 'Party name and amount required' });

    const user = req.session.user;
    let pay_id = data.payment_id;
    if (!pay_id) {
      const ts = new Date();
      const pad = (n, w = 2) => String(n).padStart(w, '0');
      const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}${pad(ts.getMilliseconds(), 3)}000`;
      pay_id = `${party}_${stamp}`;
    }
    const entry = {
      payment_id: pay_id,
      party_name: party,
      amount: amt,
      payment_type: data.payment_type || 'receipt',
      mode: data.mode || 'Cash',
      ref_invoice: data.ref_invoice || '',
      notes: data.notes || '',
      payment_date: data.payment_date || formatDDMonYYYY(),
      timestamp: data.timestamp || nowIso(),
      created_by: user.id,
    };
    await upsertPayment(req, pay_id, entry);

    const ref = data.ref_invoice;
    if (ref && (data.payment_type || 'receipt') === 'receipt') {
      const { row } = await getDocumentRow(req, ref);
      if (row) {
        const inv = row.data;
        const all = await allPaymentsRaw(req);
        const tot = all
          .filter((p) => p.ref_invoice === ref && p.payment_type === 'receipt')
          .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        inv.status = tot >= parseFloat(inv.grand_total || 0) ? 'Paid' : 'Confirmed';
        await updateDocumentData(req, ref, inv);
      }
    }
    res.json({ success: true, payment_id: pay_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/delete-payment/:payment_id(*)', loginRequired, async (req, res) => {
  try {
    const payment_id = decodeURIComponent(req.params.payment_id);
    const pay = await getPayment(req, payment_id);
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    const ref = pay.ref_invoice;
    await deletePayment(req, payment_id);
    if (ref && pay.payment_type === 'receipt') {
      const { row } = await getDocumentRow(req, ref);
      if (row) {
        const inv = row.data;
        const all = await allPaymentsRaw(req);
        const tot = all
          .filter((p) => p.ref_invoice === ref && p.payment_type === 'receipt')
          .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
        if (tot < parseFloat(inv.grand_total || 0)) {
          inv.status = 'Confirmed';
          await updateDocumentData(req, ref, inv);
        }
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/download-receipt/:payment_id(*)', loginRequired, async (req, res) => {
  try {
    const payment_id = decodeURIComponent(req.params.payment_id);
    const pay = await getPayment(req, payment_id);
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    const profile = await getSellerProfile(req);
    const pdfBuf = await generateReceiptPdf(pay, profile);
    const prefix = pay.payment_type === 'receipt' ? 'Receipt' : 'Payment_Voucher';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${prefix}_${payment_id.slice(-6)}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

router.post('/email-receipt/:payment_id(*)', loginRequired, perMinute(10), async (req, res) => {
  try {
    const payment_id = decodeURIComponent(req.params.payment_id);
    const pay = await getPayment(req, payment_id);
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    const party = pay.party_name || '';
    let client_email = null;
    const clients = await loadClients(req);
    for (const [cname, cdata] of Object.entries(clients)) {
      if (cname.toLowerCase() === party.toLowerCase()) { client_email = cdata.email; break; }
    }
    if (!client_email) {
      const invs = await loadInvoices(req);
      for (const inv of invs) {
        if ((inv.client_name || '').toLowerCase() === party.toLowerCase() && inv.client_email) {
          client_email = inv.client_email; break;
        }
      }
    }
    if (!client_email) return res.status(400).json({ error: `No email address found on file for '${party}'.` });

    const profile = await getSellerProfile(req);
    const is_receipt = pay.payment_type === 'receipt';
    const doc_type = is_receipt ? 'Receipt' : 'Payment Voucher';
    const subject = `${doc_type} from ${profile.company_name || 'SM Tech'}`;
    const body = `Dear ${party},\n\nPlease find attached the ${doc_type} for Rs. ${pay.amount} dated ${pay.payment_date}.\n\nRegards,\n${profile.company_name || 'SM Tech'}`;
    const pdfBuf = await generateReceiptPdf(pay, profile);
    await sendEmailWithAttachment(client_email, subject, body, pdfBuf, `${doc_type}_${payment_id.slice(-6)}.pdf`);
    res.json({ message: `${doc_type} emailed successfully to ${client_email}!` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
