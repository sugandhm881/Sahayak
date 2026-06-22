const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { loginRequired, hasPermission } = require('../middleware/auth');
const { getSellerProfile }    = require('../repositories/configs.repo');
const { patchDocumentMeta }   = require('../repositories/documents.repo');
const env = require('../config/env');

const BASE_URL    = env.RAPIDSHYP_API_URL.replace(/\/$/, '');
const CREATE_URL  = BASE_URL + '/b2b/orders/b2b_ext_create_order';
const ATTACH_URL  = BASE_URL + '/b2b/orders/b2b_ext_upload_invoice';
const CANCEL_URL  = BASE_URL + '/b2b/orders/b2b_ext_shipment_cancel';
const AWB_URL     = BASE_URL + '/b2b/orders/b2b_ext_assign_awb';
const LABEL_URL   = BASE_URL + '/b2b/orders/get_label';
const TRACK_URL   = BASE_URL + '/b2b/orders/get_tracking_info';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function getApiKey(req) {
  const profile = await getSellerProfile(req);
  const key = (profile.rapidshyp_api_key || '').trim();
  if (!key) throw new Error('RapidShyp API key not configured. Go to Settings → Integrations.');
  return key;
}

function permCheck(req, res) {
  const user = req.session.user;
  if (!user.is_master && !hasPermission(user, 'shipping')) {
    res.status(403).json({ error: 'You do not have shipping permission.' });
    return false;
  }
  return true;
}

// Create B2B order
router.post('/rapidshyp/b2b-order', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const apiKey = await getApiKey(req);
    const response = await fetch(CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'rapidshyp-token': apiKey },
      body: JSON.stringify(req.body),
    });
    const result = await response.json();
    console.log('[RapidShyp B2B] create response:', JSON.stringify(result));
    res.status(response.ok ? 200 : response.status).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Attach invoice PDF/image to an existing B2B order
router.post('/rapidshyp/attach-invoice', loginRequired, upload.single('invoice_file'), async (req, res) => {
  if (!permCheck(req, res)) return;
  const orderId = (req.body.order_id || '').trim();
  if (!orderId) return res.status(400).json({ error: 'order_id is required.' });
  if (!req.file)  return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const apiKey = await getApiKey(req);
    const form = new FormData();
    form.append('order_id', orderId);
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

    const response = await fetch(ATTACH_URL, {
      method: 'POST',
      headers: { 'rapidshyp-token': apiKey },
      body: form,
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { raw: text }; }
    res.status(response.ok ? 200 : response.status).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save/clear RapidShyp shipment ID on an invoice (stored in DB, not localStorage)
router.post('/rapidshyp/mark-shipped', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const { bill_no, shipment_id } = req.body;
    if (!bill_no) return res.status(400).json({ error: 'bill_no required' });
    await patchDocumentMeta(req, bill_no, { rapidshyp_shipment_id: shipment_id || null, shipment_id: shipment_id || null });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Assign AWB to a B2B shipment
router.post('/rapidshyp/b2b-assign-awb', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const apiKey = await getApiKey(req);
    const response = await fetch(AWB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'rapidshyp-token': apiKey },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { result = { raw: text }; }
    console.log('[RapidShyp B2B] assign-awb response:', JSON.stringify(result));
    res.status(response.ok ? 200 : response.status).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get shipment label PDF (RapidShyp uses GET with a JSON body)
router.post('/rapidshyp/get-label', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const apiKey    = await getApiKey(req);
    const { shipment_id } = req.body;
    if (!shipment_id) return res.status(400).json({ error: 'shipment_id is required' });

    const response = await fetch(LABEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'rapidshyp-token': apiKey },
      body: JSON.stringify({ shipmentId: shipment_id }),
    });

    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/pdf') || ct.includes('octet-stream')) {
      const buf = await response.arrayBuffer();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="label_${shipment_id}.pdf"`);
      return res.send(Buffer.from(buf));
    }

    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { result = { raw: text }; }
    res.status(response.ok ? 200 : response.status).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tracking info — scan history for a shipment
router.post('/rapidshyp/tracking-info', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const apiKey = await getApiKey(req);
    const response = await fetch(TRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'rapidshyp-token': apiKey },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { result = { raw: text }; }
    res.status(response.ok ? 200 : response.status).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel a B2B shipment
router.post('/rapidshyp/b2b-cancel', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const apiKey = await getApiKey(req);
    const response = await fetch(CANCEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'rapidshyp-token': apiKey },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : { status: response.ok ? 'SUCCESS' : 'FAILED' }; }
    catch { result = { raw: text }; }
    console.log('[RapidShyp B2B] cancel response:', JSON.stringify(result));
    res.status(response.ok ? 200 : response.status).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy a RapidShyp label PDF so the browser can download it from same-origin
router.get('/rapidshyp/proxy-pdf', loginRequired, async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url.startsWith('https://storage.googleapis.com/rapidshyp-live/')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: 'Failed to fetch label PDF' });
    const buf = await response.arrayBuffer();
    const filename = url.split('/').pop().split('?')[0] || 'label.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;