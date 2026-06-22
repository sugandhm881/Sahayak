const express = require('express');
const router = express.Router();

const { loginRequired } = require('../middleware/auth');
const {
  loadParticulars,
  saveSingleParticular,
  getByProductId,
  deleteParticular,
  logChange,
  listChangelog,
} = require('../repositories/particulars.repo');

// Render the manage page.
router.get('/products', loginRequired, (req, res) => res.render('products.html'));

// JSON list of all particulars with their full data (incl. product_id if set).
router.get('/products/list', loginRequired, async (req, res) => {
  try {
    const all = await loadParticulars(req);
    // Shape into array sorted by name for the UI
    const rows = Object.entries(all).map(([name, data]) => ({
      name,
      product_id: (data && data.product_id) || '',
      hsn: (data && data.hsn) || '',
      rate: (data && data.rate) != null ? data.rate : '',
      taxrate: (data && data.taxrate) != null ? data.taxrate : '',
      sub_particulars: (data && data.sub_particulars) || [],
      sub_details: (data && data.sub_details) || {},
    }));
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lookup a particular by its Product ID. Used by the invoice form to auto-fill
// when the user types a product ID into the particulars search.
router.get('/products/lookup/:product_id', loginRequired, async (req, res) => {
  try {
    const row = await getByProductId(req, req.params.product_id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({
      name: row.name,
      product_id: (row.data && row.data.product_id) || '',
      hsn: (row.data && row.data.hsn) || '',
      rate: (row.data && row.data.rate) != null ? row.data.rate : '',
      taxrate: (row.data && row.data.taxrate) != null ? row.data.taxrate : '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create or update a particular's fields. Also logs every changed field to product_changelog.
router.post('/products/update', loginRequired, async (req, res) => {
  try {
    const original_name = String(req.body.original_name || '').trim();
    const name = String(req.body.name || '').trim();
    const product_id = String(req.body.product_id || '').trim();
    const hsn = String(req.body.hsn || '').trim();
    const rate = req.body.rate === '' || req.body.rate == null ? '' : parseFloat(req.body.rate);
    const taxrate = req.body.taxrate === '' || req.body.taxrate == null ? '' : parseFloat(req.body.taxrate);
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    // If product_id is set, make sure it isn't already used by a different particular.
    if (product_id) {
      const existing = await getByProductId(req, product_id);
      if (existing && existing.name !== name && existing.name !== original_name) {
        return res.status(409).json({ error: `Product ID '${product_id}' already used by '${existing.name}'.` });
      }
    }

    // Load current row (under original_name if a rename is happening) so we can compute diffs.
    const all = await loadParticulars(req);
    const prev = all[original_name] || all[name] || null;

    // Build new data; preserve sub_particulars/sub_details from previous row.
    const new_data = {
      product_id: product_id || '',
      hsn: hsn || '',
      rate: rate === '' ? '' : Number(rate),
      taxrate: taxrate === '' ? '' : Number(taxrate),
      sub_particulars: (prev && prev.sub_particulars) || [],
      sub_details: (prev && prev.sub_details) || {},
    };

    // Log every changed field.
    const log = (field, oldV, newV) => {
      const a = oldV == null ? '' : String(oldV);
      const b = newV == null ? '' : String(newV);
      if (a !== b) return logChange(req, name, product_id, field, a, b);
      return null;
    };
    if (prev) {
      await log('product_id', (prev && prev.product_id) || '', new_data.product_id);
      await log('hsn', (prev && prev.hsn) || '', new_data.hsn);
      await log('rate', (prev && prev.rate) != null ? prev.rate : '', new_data.rate);
      await log('taxrate', (prev && prev.taxrate) != null ? prev.taxrate : '', new_data.taxrate);
      if (original_name && original_name !== name) {
        await log('name', original_name, name);
      }
    } else {
      // Brand-new product
      await logChange(req, name, product_id, 'create', '', JSON.stringify({
        product_id: new_data.product_id,
        hsn: new_data.hsn,
        rate: new_data.rate,
        taxrate: new_data.taxrate,
      }));
    }

    // If renaming, delete the old row first (additive-safe: we still keep changelog).
    if (original_name && original_name !== name && prev) {
      await deleteParticular(req, original_name);
    }
    await saveSingleParticular(req, name, new_data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a particular. Logs the deletion.
router.post('/products/delete', loginRequired, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required.' });
    const all = await loadParticulars(req);
    const prev = all[name];
    if (!prev) return res.status(404).json({ error: 'Not found.' });
    await logChange(req, name, (prev && prev.product_id) || '', 'delete', JSON.stringify({
      product_id: (prev && prev.product_id) || '',
      hsn: (prev && prev.hsn) || '',
      rate: (prev && prev.rate),
      taxrate: (prev && prev.taxrate),
    }), '');
    await deleteParticular(req, name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Changelog for a single particular (full history) or tenant-wide if no name.
router.get('/products/history', loginRequired, async (req, res) => {
  try {
    const name = String(req.query.name || '').trim() || null;
    const rows = await listChangelog(req, name, parseInt(req.query.limit || '200', 10));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save shipping weight/dimensions per product (called after B2B order creation)
router.post('/products/save-ship-dims', loginRequired, async (req, res) => {
  try {
    const items = req.body; // [{ name, wt, l, b, h }]
    if (!Array.isArray(items) || !items.length) return res.json({ ok: true, saved: 0 });
    let saved = 0;
    for (const { name, wt, l, b, h } of items) {
      if (!name) continue;
      const dims = {};
      if (wt) dims.ship_wt = parseFloat(wt);
      if (l)  dims.ship_l  = parseFloat(l);
      if (b)  dims.ship_b  = parseFloat(b);
      if (h)  dims.ship_h  = parseFloat(h);
      if (Object.keys(dims).length) { await saveSingleParticular(req, name, dims); saved++; }
    }
    res.json({ ok: true, saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
