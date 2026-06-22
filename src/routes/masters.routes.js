const express = require('express');
const router = express.Router();
const { loginRequired } = require('../middleware/auth');
const { loadClients } = require('../repositories/clients.repo');
const { loadParticulars } = require('../repositories/particulars.repo');
const { getTenantId } = require('../middleware/tenant');
const { getProduct, safeItemId } = require('../repositories/inventory.repo');

router.get('/clients', loginRequired, async (req, res) => {
  try { res.json(await loadClients(req)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/particulars', loginRequired, async (req, res) => {
  try { res.json(await loadParticulars(req)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/check-stock/:item_name(*)', loginRequired, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.item_name);
    const id = safeItemId(name);
    if (!id) return res.json({ exists: false, stock: 0 });
    const p = await getProduct(req, id);
    if (p) return res.json({ exists: true, stock: parseFloat(p.current_stock || 0) });
    res.json({ exists: false, stock: 0 });
  } catch {
    res.json({ exists: false, stock: 0 });
  }
});

module.exports = router;
