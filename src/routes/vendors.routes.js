const express = require('express');
const router = express.Router();
const https = require('https');
const supabase = require('../config/supabase');
const { loginRequired } = require('../middleware/auth');
const { getTenantId } = require('../middleware/tenant');

router.get('/vendors', loginRequired, (req, res) => {
  res.render('vendors.html');
});

router.get('/v2/vendors', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const { data, error } = await supabase.from('clients').select('name, data').eq('tenant_id', tenant).order('name');
    if (error) throw error;
    res.json({ vendors: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/v2/vendors', loginRequired, express.json(), async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const {
      name, original_name,
      type = 'vendor', gstin = '', email = '', mobile = '',
      address1 = '', address2 = '', pincode = '', district = '', state = '',
      shipto_address1 = '', shipto_address2 = '', shipto_pincode = '', shipto_district = '', shipto_state = '',
      bank_name = '', bank_account = '', bank_ifsc = '',
    } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const trimmedName = name.trim();

    // Read existing data to preserve invoice-populated fields (state, pincode, district, address2)
    const isRename = original_name && original_name !== trimmedName;
    let existingData = {};
    if (isRename) {
      const { data: oldRow } = await supabase.from('clients').select('data').eq('tenant_id', tenant).eq('name', original_name).maybeSingle();
      existingData = oldRow?.data || {};
    } else {
      const { data: curRow } = await supabase.from('clients').select('data').eq('tenant_id', tenant).eq('name', trimmedName).maybeSingle();
      existingData = curRow?.data || {};
    }

    // Merge: vendor-form fields override existing; fields not managed by this form are preserved
    const data = {
      ...existingData,
      type,
      gstin: gstin.trim(), email: email.trim(), mobile: mobile.trim(),
      address1: address1.trim(), address2: address2.trim(),
      pincode: pincode.trim(), district: district.trim(), state: state.trim(),
      shipto_address1: shipto_address1.trim(), shipto_address2: shipto_address2.trim(),
      shipto_pincode: shipto_pincode.trim(), shipto_district: shipto_district.trim(), shipto_state: shipto_state.trim(),
      bank_name: bank_name.trim(), bank_account: bank_account.trim(), bank_ifsc: bank_ifsc.trim(),
    };
    // Upsert new record first — if this fails, old record is untouched (no data loss)
    const { error } = await supabase.from('clients').upsert({ tenant_id: tenant, name: trimmedName, data }, { onConflict: 'tenant_id,name' });
    if (error) throw error;
    // Only delete old name after new record is confirmed saved
    if (isRename) {
      await supabase.from('clients').delete().eq('tenant_id', tenant).eq('name', original_name);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/v2/vendors/:name', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const name = decodeURIComponent(req.params.name);
    const { error } = await supabase.from('clients').delete().eq('tenant_id', tenant).eq('name', name);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/pincode/:pin', loginRequired, (req, res) => {
  const pin = (req.params.pin || '').replace(/\D/g, '').slice(0, 6);
  if (pin.length !== 6) return res.status(400).json({ error: 'Invalid pincode' });
  https.get(`https://api.postalpincode.in/pincode/${pin}`, (apiRes) => {
    let body = '';
    apiRes.on('data', chunk => { body += chunk; });
    apiRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data[0]?.Status === 'Success' && data[0].PostOffice?.length) {
          const po = data[0].PostOffice[0];
          return res.json({ district: po.District, state: po.State });
        }
        res.status(404).json({ error: 'Pincode not found' });
      } catch { res.status(500).json({ error: 'Parse error' }); }
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

module.exports = router;
