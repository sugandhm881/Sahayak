const express = require('express');
const router  = express.Router();
const { loginRequired, hasPermission } = require('../middleware/auth');
const { getSellerProfile }             = require('../repositories/configs.repo');
const { listProducts, upsertProduct, safeItemId } = require('../repositories/inventory.repo');
const easyecom                         = require('../services/easyecom.service');

function permCheck(req, res) {
  const u = req.session.user;
  if (!u.is_master && !hasPermission(u, 'easyecom')) {
    res.status(403).json({ error: 'You do not have Easyecom Inventory permission.' });
    return false;
  }
  return true;
}

// ── Status: hit counter + pending count ──────────────────────────────────────
router.get('/easyecom/status', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const profile  = await getSellerProfile(req);
    const { count, limit, remaining, ok } = easyecom.hitStatus(profile);
    const products = await listProducts(req);
    const pending  = products.filter(p => parseFloat(p.pending_easyecom_adj || 0) !== 0);
    const pendingList = pending.map(p => ({
      item_name:   p.item_name,
      sku:         p.easyecom_sku || p.product_id || '',
      adj:         parseFloat(p.pending_easyecom_adj),
    }));

    const apiKey = (profile.easyecom_api_key || '').trim() || (process.env.EASYECOM_API_KEY || '').trim();
    res.json({
      configured: !!apiKey,
      auto_push:  profile.easyecom_auto_push === true || profile.easyecom_auto_push === 'true',
      hits:       { count, limit, remaining, ok },
      pending:    pendingList,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sync: pull all stock from Easyecom → local cache ─────────────────────────
router.post('/easyecom/sync', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const profile = await getSellerProfile(req);
    const { ok, remaining } = easyecom.hitStatus(profile);
    if (!ok) return res.status(429).json({ error: `API limit reached — ${remaining < 0 ? 0 : remaining} hits left this month.` });

    const result = await easyecom.syncInventoryToLocal(req, profile);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: show raw Easyecom API response (page 1) ───────────────────────────
router.get('/easyecom/debug', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const profile = await getSellerProfile(req);
    const env     = require('../config/env');
    const BASE    = env.EASYECOM_API_URL.replace(/\/$/, '');
    const jwt     = (profile.easyecom_jwt_token || '').trim();
    if (!jwt) return res.status(400).json({ error: 'No JWT token configured.' });
    const url     = `${BASE}/getInventoryDetailsV3?includeLocations=1&limit=10&page=1`;
    const raw     = await fetch(url, { headers: { 'Authorization': `Bearer ${jwt}` } });
    const data    = await raw.json();
    res.json({ status: raw.status, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Push: send all pending adjustments to Easyecom ───────────────────────────
router.post('/easyecom/push', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const profile = await getSellerProfile(req);
    const { ok, remaining } = easyecom.hitStatus(profile);
    if (!ok) return res.status(429).json({ error: `API limit reached — ${remaining < 0 ? 0 : remaining} hits left this month.` });

    const result = await easyecom.pushAllPending(req, profile);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Reconcile: mark all pending adjustments as done (after manual Easyecom update) ─
router.post('/easyecom/reconcile', loginRequired, async (req, res) => {
  if (!permCheck(req, res)) return;
  try {
    const products = await listProducts(req);
    const pending  = products.filter(p => parseFloat(p.pending_easyecom_adj || 0) !== 0);
    for (const p of pending) {
      const sid = p._safe_id || safeItemId(p.item_name);
      if (sid) await upsertProduct(req, sid, { pending_easyecom_adj: 0 });
    }
    res.json({ ok: true, cleared: pending.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;