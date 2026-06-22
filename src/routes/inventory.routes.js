const express = require('express');
const router = express.Router();

const { loginRequired } = require('../middleware/auth');
const {
  safeItemId, getProduct, upsertProduct, addLedgerEntry, listProducts, listLedger,
} = require('../repositories/inventory.repo');
const { nowIso } = require('../utils/dates');

router.get('/inventory', loginRequired, (req, res) => res.render('inventory.html'));

router.get('/inventory/list', loginRequired, async (req, res) => {
  try {
    const items = await listProducts(req);
    items.sort((a, b) => String(a.item_name || '').localeCompare(String(b.item_name || '')));
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/inventory/ledger', loginRequired, async (req, res) => {
  try {
    const rows = await listLedger(req, {
      itemName: req.query.item || null,
      limit: parseInt(req.query.limit || '300', 10),
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/inventory/adjust', loginRequired, async (req, res) => {
  try {
    const itemName = String(req.body.item_name || '').trim();
    const qtyChange = parseFloat(req.body.qty_change);
    const reason = String(req.body.reason || '').trim() || 'Manual adjustment';
    if (!itemName) return res.status(400).json({ error: 'Item name required.' });
    if (!Number.isFinite(qtyChange) || qtyChange === 0) return res.status(400).json({ error: 'Non-zero qty required.' });

    const sid = safeItemId(itemName);
    const existing = await getProduct(req, sid);
    const curStock = existing ? parseFloat(existing.current_stock || 0) : 0;
    const newStock = curStock + qtyChange;
    const ts = nowIso();

    await upsertProduct(req, sid, {
      item_name: itemName,
      current_stock: newStock,
      last_updated: ts,
    });
    await addLedgerEntry(req, {
      ref_doc_no: 'ADJ-' + ts.slice(0, 10) + '-' + Math.floor(Math.random() * 9999),
      date: ts.slice(0, 10),
      doc_type: 'adjustment',
      item_name: itemName,
      qty_change: qtyChange,
      running_balance: newStock,
      timestamp: ts,
      reason,
    });
    res.json({ ok: true, item_name: itemName, current_stock: newStock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/inventory/set-easyecom-sku', loginRequired, async (req, res) => {
  try {
    const { hasPermission } = require('../middleware/auth');
    const u = req.session.user;
    if (!u.is_master && !hasPermission(u, 'easyecom')) return res.status(403).json({ error: 'No Easyecom permission.' });
    const itemName = String(req.body.item_name || '').trim();
    const sku      = String(req.body.sku || '').trim();
    if (!itemName) return res.status(400).json({ error: 'item_name required.' });
    const sid = safeItemId(itemName);
    if (!sid) return res.status(400).json({ error: 'Invalid item name.' });
    await upsertProduct(req, sid, { easyecom_sku: sku || null });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
