const express = require('express');
const router = express.Router();

const { loginRequired } = require('../middleware/auth');
const { perMinute } = require('../middleware/rateLimit');

const { loadInvoices } = require('../repositories/documents.repo');
const { getSellerProfile } = require('../repositories/configs.repo');
const { generateInvoicePdf } = require('../services/pdf/invoicePdf');
const { sendEmailWithAttachment } = require('../services/email');

router.post('/email-invoice/:bill_no(*)', loginRequired, perMinute(10), async (req, res) => {
  try {
    const bill_no = decodeURIComponent(req.params.bill_no);
    const invs = await loadInvoices(req);
    const inv = invs.find((i) => i.bill_no === bill_no);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!inv.client_email) return res.status(400).json({ error: 'Client email not found' });
    const is_cn = !!inv.is_credit_note;
    const is_dn = !!inv.is_debit_note;
    const doc_type = is_cn ? 'Credit Note' : (is_dn ? 'Debit Note' : 'Invoice');
    const profile = await getSellerProfile(req);
    const subject = `${doc_type} ${bill_no} from ${profile.company_name || 'SM Tech'}`;
    const body = `Dear ${inv.client_name},\n\nPlease find attached ${doc_type} ${bill_no}.\n\nRegards,\n${profile.company_name || 'SM Tech'}`;
    const pdfBuf = await generateInvoicePdf(inv, profile, { is_credit_note: is_cn, is_debit_note: is_dn });
    await sendEmailWithAttachment(inv.client_email, subject, body, pdfBuf, `${doc_type}_${bill_no.replace(/\//g, '_')}.pdf`);
    res.json({ message: 'Email sent successfully!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
