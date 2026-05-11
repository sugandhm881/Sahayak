const express = require('express');
const archiver = require('archiver');
const router = express.Router();

const { loginRequired, hasPermission } = require('../middleware/auth');
const { perMinute } = require('../middleware/rateLimit');
const { getTenantId } = require('../middleware/tenant');
const supabase = require('../config/supabase');

const { getSellerProfile } = require('../repositories/configs.repo');
const { loadClients, saveSingleClient } = require('../repositories/clients.repo');
const { loadParticulars, saveSingleParticular } = require('../repositories/particulars.repo');
const {
  loadInvoices, saveSingleInvoice, getDocumentRow, deleteDocument, updateDocumentData,
} = require('../repositories/documents.repo');
const { safeItemId, getProduct, upsertProduct, addLedgerEntry } = require('../repositories/inventory.repo');

const { generateInvoicePdf } = require('../services/pdf/invoicePdf');
const { formatDDMonYYYY, fyString, nowIso } = require('../utils/dates');
const { linkDocs, listChildren, listParents, unlinkChild } = require('../repositories/docLinks.repo');
const { getPending, prefillFromParent } = require('../services/docConversion');

function intraStateFromGstinOrState(myGstin, myState, clientGstin, clientState) {
  const myStateCode = myGstin && myGstin.length >= 2 ? myGstin.slice(0, 2) : null;
  if (myStateCode && clientGstin) return clientGstin.startsWith(myStateCode);
  if (myState && clientState) return myState.toLowerCase() === clientState.toLowerCase();
  return true;
}

router.get('/home', loginRequired, (req, res) => {
  // Smart redirect: send user to the module they have access to (sales first, else purchase).
  const user = req.session.user;
  const canSale = hasPermission(user, 'sale');
  const canPurchase = hasPermission(user, 'purchase');
  if (canSale && !canPurchase) return res.redirect('/sales/new');
  if (canPurchase && !canSale) return res.redirect('/purchase/new');
  // Both (or neither — let the form handle the auth): keep the unified view.
  return res.render('index.html', { module: 'all' });
});

router.get('/sales/new', loginRequired, (req, res) => {
  if (!hasPermission(req.session.user, 'sale')) return res.redirect('/purchase/new');
  res.render('index.html', { module: 'sale' });
});

router.get('/purchase/new', loginRequired, (req, res) => {
  if (!hasPermission(req.session.user, 'purchase')) return res.redirect('/sales/new');
  res.render('index.html', { module: 'purchase' });
});

router.get('/invoices-list', loginRequired, async (req, res) => {
  try { res.json(await loadInvoices(req)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/generate-invoice', loginRequired, perMinute(30), async (req, res) => {
  try {
    const data = req.body || {};
    const doc_category = data.doc_category || 'sale';
    const doc_type = data.doc_type || 'invoice';
    const user = req.session.user;

    if (!hasPermission(user, doc_category)) return res.status(403).json({ error: `No permission for ${doc_category}.` });
    if (doc_category === 'sale' && doc_type === 'dn') return res.status(400).json({ error: 'No Sales Debit Notes.' });
    if (doc_category === 'purchase' && doc_type === 'cn') return res.status(400).json({ error: 'No Purchase Credit Notes.' });

    const is_edit = !!data.is_edit;
    const is_non_gst = !!data.is_non_gst;
    const is_debit_note = doc_type === 'dn';
    const is_credit_note = doc_type === 'cn';

    const client_name = (data.client_name || '').trim();
    const client_email = (data.client_email || '').trim();
    const client_mobile = (data.client_mobile || '').trim();

    if (client_name && !is_edit) {
      const existingClients = await loadClients(req);
      if (!existingClients[client_name]) {
        for (const [extName, extData] of Object.entries(existingClients)) {
          if (client_email && extData.email === client_email) {
            return res.status(409).json({ error: `Email '${client_email}' is already registered to '${extName}'.` });
          }
          if (client_mobile && extData.mobile === client_mobile) {
            return res.status(409).json({ error: `Mobile '${client_mobile}' is already registered to '${extName}'.` });
          }
        }
      }
    }

    const client_details = {
      address1: data.client_address1, address2: data.client_address2,
      pincode: data.client_pincode, district: data.client_district,
      state: data.client_state, gstin: data.client_gstin,
      email: client_email, mobile: client_mobile,
    };

    let particulars = data.particulars || [];
    if (typeof particulars === 'string') particulars = [particulars.trim()];
    const qtys = data.qtys || [];
    const rates = data.rates || [];
    const taxrates = data.taxrates || [];
    const hsns = data.hsns || [];
    const amounts_inclusive = data.amounts || [];
    const invoice_type = data.invoice_type || 'goods';
    const is_service = invoice_type === 'service';

    if (is_edit) {
      const billNoToCheck = String(data.manual_bill_no || '').trim();
      const invoices = await loadInvoices(req);
      const existingInv = invoices.find((i) => i.bill_no === billNoToCheck);
      if (existingInv && existingInv.timestamp) {
        try {
          const t = new Date(existingInv.timestamp).getTime();
          if (Date.now() - t > 24 * 60 * 60 * 1000) {
            return res.status(403).json({ error: 'Edit window (24 hours) expired.' });
          }
        } catch {}
      }
    }

    // Smart case-insensitive merging for items
    const existingParticulars = await loadParticulars(req);
    const particulars_lower_map = {};
    for (const k of Object.keys(existingParticulars)) particulars_lower_map[k.toLowerCase()] = k;

    const sub_particulars_list = data.sub_particulars || [];
    for (let i = 0; i < particulars.length; i++) {
      const item_name = particulars[i];
      if (!item_name) continue;
      const main_item_name = String(item_name).split('\n')[0].trim();
      const base_name = is_non_gst ? `${main_item_name}_NONGST` : main_item_name;
      let final_save_name;
      if (particulars_lower_map[base_name.toLowerCase()]) {
        final_save_name = particulars_lower_map[base_name.toLowerCase()];
      } else {
        final_save_name = base_name;
        particulars_lower_map[base_name.toLowerCase()] = final_save_name;
      }
      const existing_data = existingParticulars[final_save_name] || existingParticulars[base_name] || {};
      const existing_subs = existing_data.sub_particulars || [];
      const sub_details = existing_data.sub_details || {};
      if (existing_data.sub_particular && !existing_subs.includes(existing_data.sub_particular)) {
        existing_subs.push(existing_data.sub_particular);
      }
      const new_sub = (sub_particulars_list[i] || '').trim();
      if (new_sub) {
        if (!existing_subs.includes(new_sub)) existing_subs.push(new_sub);
        sub_details[new_sub] = {
          hsn: is_non_gst ? '' : (hsns[i] || ''),
          rate: rates[i] || 0,
          taxrate: is_non_gst ? 0 : (taxrates[i] || 0),
        };
      }
      await saveSingleParticular(req, final_save_name, {
        hsn: is_non_gst ? '' : (hsns[i] || ''),
        rate: rates[i] || 0,
        taxrate: is_non_gst ? 0 : (taxrates[i] || 0),
        sub_particulars: existing_subs,
        sub_details,
      });
    }
    if (client_name) await saveSingleClient(req, client_name, client_details);

    // Bill number generation
    let bill_no;
    let invoice_date_str;
    const prof = await getSellerProfile(req);
    if ((data.auto_generate === undefined || data.auto_generate) && !is_edit) {
      const prefix = String(prof.invoice_prefix || 'TE').toUpperCase();
      const fy_str = fyString();

      const getFyCounter = async (cat, dtype, is_cn = false, is_dn = false) => {
        const docs = await loadInvoices(req);
        let count = 0;
        for (const d of docs) {
          if ((d.doc_category || 'sale') === cat &&
              (d.doc_type || 'invoice') === dtype &&
              !!d.is_credit_note === is_cn &&
              !!d.is_debit_note === is_dn) {
            if ((d.bill_no || '').includes(fy_str)) count++;
          }
        }
        return count + 1;
      };

      const pad3 = (n) => String(n).padStart(3, '0');

      if (doc_category === 'purchase') {
        if (doc_type === 'po') bill_no = `${prefix}-PO/${fy_str}/${pad3(await getFyCounter('purchase', 'po'))}`;
        else if (doc_type === 'grn') bill_no = `${prefix}-GRN/${fy_str}/${pad3(await getFyCounter('purchase', 'grn'))}`;
        else if (doc_type === 'bill') bill_no = `${prefix}-PB/${fy_str}/${pad3(await getFyCounter('purchase', 'bill'))}`;
        else if (doc_type === 'dn') bill_no = `${prefix}-PDN/${fy_str}/${pad3(await getFyCounter('purchase', 'dn', false, true))}`;
        else bill_no = `TEMP-${Math.floor(1000 + Math.random() * 9000)}`;
      } else {
        if (doc_type === 'cn') bill_no = `${prefix}-CN/${fy_str}/${pad3(await getFyCounter('sale', 'cn', true))}`;
        else bill_no = `${prefix}/${fy_str}/${pad3(await getFyCounter('sale', 'invoice'))}`;
      }
      invoice_date_str = formatDDMonYYYY();
    } else {
      bill_no = data.manual_bill_no || data.bill_no || `TEMP-${Date.now()}`;
      invoice_date_str = data.invoice_date || formatDDMonYYYY();
    }

    const is_intra = intraStateFromGstinOrState(
      prof.gstin || '',
      (prof.state || '').trim(),
      (data.client_gstin || '').trim(),
      (data.client_state || '').trim()
    );

    const line_taxable = [];
    const line_tax = [];
    const line_total = [];
    let total_igst = 0, total_cgst = 0, total_sgst = 0, total_discount_amt = 0;

    for (let i = 0; i < amounts_inclusive.length; i++) {
      const inc_exc = parseFloat(amounts_inclusive[i]) || 0;
      const q_val = parseFloat(qtys[i] || 0);
      const r_val = parseFloat(rates[i] || 0);
      const t_rate = is_non_gst ? 0 : (parseFloat(taxrates[i] || 0));

      let taxable, tax_amt, total_val;
      if (is_service) {
        taxable = Math.round(inc_exc * 100) / 100;
        tax_amt = Math.round(taxable * t_rate / 100 * 100) / 100;
        total_val = taxable + tax_amt;
        if (q_val * r_val > taxable) total_discount_amt += (q_val * r_val) - taxable;
      } else {
        const line_gross = q_val * r_val;
        if (line_gross > inc_exc) total_discount_amt += line_gross - inc_exc;
        taxable = Math.round((inc_exc / (1 + t_rate / 100)) * 100) / 100;
        tax_amt = Math.round((inc_exc - taxable) * 100) / 100;
        total_val = inc_exc;
      }
      line_taxable.push(taxable);
      line_tax.push(tax_amt);
      line_total.push(Math.round(total_val * 100) / 100);

      if (!is_non_gst) {
        if (is_intra) {
          const half = Math.round((tax_amt / 2) * 100) / 100;
          total_cgst += half;
          total_sgst += tax_amt - half;
        } else {
          total_igst += tax_amt;
        }
      }
    }

    const invoice_data = {
      bill_no, invoice_date: invoice_date_str, timestamp: nowIso(),
      doc_category, doc_type, invoice_type,
      is_non_gst, is_debit_note, is_credit_note,
      original_invoice_no: data.original_invoice_no || '', client_name,
      ...Object.fromEntries(Object.entries(client_details).map(([k, v]) => [`client_${k}`, v])),
      shipto_name: data.shipto_name, shipto_address1: data.shipto_address1,
      shipto_address2: data.shipto_address2, shipto_pincode: data.shipto_pincode,
      shipto_district: data.shipto_district, shipto_state: data.shipto_state,
      shipto_gstin: data.shipto_gstin, shipto_email: data.shipto_email, shipto_mobile: data.shipto_mobile,
      po_number: data.po_number, my_gstin: prof.gstin || '', tds_applicable: !!data.tds_applicable,
      particulars, qtys, rates, taxrates, hsns, discounts: data.discounts || [],
      amounts: line_taxable, total_discount: Math.round(total_discount_amt * 100) / 100,
      sub_total: Math.round(line_taxable.reduce((a, b) => a + b, 0) * 100) / 100,
      igst: Math.round(total_igst * 100) / 100,
      cgst: Math.round(total_cgst * 100) / 100,
      sgst: Math.round(total_sgst * 100) / 100,
      grand_total: Math.round(line_total.reduce((a, b) => a + b, 0) * 100) / 100,
      line_tax_amounts: line_tax, line_total_amounts: line_total,
    };

    // Inventory updates
    if (!is_edit) {
      let direction = 0;
      if (doc_category === 'purchase') direction = doc_type === 'grn' ? 1 : (doc_type === 'dn' ? -1 : 0);
      else if (doc_category === 'sale') direction = doc_type === 'invoice' ? -1 : (doc_type === 'cn' ? 1 : 0);

      if (direction !== 0) {
        const ts = nowIso();
        for (let k = 0; k < particulars.length; k++) {
          const iname = particulars[k];
          const iqty = parseFloat(qtys[k] || 0);
          if (!iname || iqty <= 0) continue;
          const sid = safeItemId(iname);
          if (!sid) continue;
          const existing = await getProduct(req, sid);
          const cur_stock = existing ? parseFloat(existing.current_stock || 0) : 0;
          const new_stock = cur_stock + iqty * direction;
          await upsertProduct(req, sid, { item_name: iname, current_stock: new_stock, last_updated: ts });
          await addLedgerEntry(req, {
            ref_doc_no: bill_no, date: invoice_date_str, doc_type: `${doc_category}_${doc_type}`,
            item_name: iname, qty_change: iqty * direction, running_balance: new_stock, timestamp: ts,
          });
        }
      }
    }

    await saveSingleInvoice(req, invoice_data);

    // Auto-link if this doc was converted from a parent (PO -> GRN, GRN -> Bill, etc).
    if (!is_edit && data._parent_bill_no && data._parent_type) {
      try {
        const idxs = data._parent_line_indexes || [];
        const qs = data._parent_line_qtys || [];
        const line_map = {};
        for (let i = 0; i < idxs.length; i++) {
          const k = String(idxs[i]);
          line_map[k] = parseFloat(qs[i]) || 0;
        }
        await linkDocs(req, String(data._parent_bill_no), String(data._parent_type), bill_no, doc_type, line_map);
      } catch (e) { console.warn('[doc_links] link failed:', e.message); }
    }

    const pdfBuf = await generateInvoicePdf(invoice_data, prof, { is_credit_note, is_debit_note });
    const doc_id = bill_no.replace(/\//g, '_');
    const prefix = doc_category === 'purchase' ? doc_type.toUpperCase() : (is_credit_note ? 'CreditNote' : 'Invoice');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${prefix}_${doc_id}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    console.error('Generate Error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/delete-invoice/:bill_no(*)', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    const ok = await deleteDocument(req, billNo);
    if (ok) return res.json({ success: true });
    res.status(404).json({ error: 'Invoice not found or already deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/download-invoice/:bill_no(*)', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    const invoices = await loadInvoices(req);
    const inv = invoices.find((i) => i.bill_no === billNo);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const profile = await getSellerProfile(req);
    const is_cn = !!inv.is_credit_note;
    const is_dn = !!inv.is_debit_note;
    const prefix = is_cn ? 'CreditNote' : (is_dn ? 'DebitNote' : 'Invoice');
    const pdfBuf = await generateInvoicePdf(inv, profile, { is_credit_note: is_cn, is_debit_note: is_dn });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${prefix}_${billNo.replace(/\//g, '_')}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/download-zip', loginRequired, async (req, res) => {
  try {
    const bill_nos = (req.body && req.body.bill_nos) || [];
    if (!bill_nos.length) return res.status(400).json({ error: 'No invoices selected' });
    const all = await loadInvoices(req);
    const profile = await getSellerProfile(req);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Invoices_Bundle.zip"');
    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.pipe(res);
    for (const bno of bill_nos) {
      const inv = all.find((i) => i.bill_no === bno);
      if (!inv) continue;
      const is_cn = !!inv.is_credit_note;
      const is_dn = !!inv.is_debit_note;
      const pdfBuf = await generateInvoicePdf(inv, profile, { is_credit_note: is_cn, is_debit_note: is_dn });
      const prefix = is_cn ? 'CreditNote' : (is_dn ? 'DebitNote' : ((inv.doc_type === 'po') ? 'PO' : 'Invoice'));
      zip.append(pdfBuf, { name: `${prefix}_${bno.replace(/\//g, '_')}.pdf` });
    }
    await zip.finalize();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/generate-credit-note/:bill_no(*)', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    const invoices = await loadInvoices(req);
    const profile = await getSellerProfile(req);
    const existing_cn = invoices.find((inv) => inv.original_invoice_no === billNo && inv.is_credit_note);
    if (existing_cn) {
      const pdfBuf = await generateInvoicePdf(existing_cn, profile, { is_credit_note: true });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="CreditNote_${existing_cn.bill_no.replace(/\//g, '_')}.pdf"`);
      return res.send(pdfBuf);
    }
    const orig = invoices.find((inv) => inv.bill_no === billNo);
    if (!orig) return res.status(404).json({ error: 'Original Invoice not found' });

    const fy_str = fyString();
    const count = invoices.filter((d) => d.is_credit_note && (d.bill_no || '').includes(fy_str)).length + 1;
    const prefix = String(profile.invoice_prefix || 'TE').toUpperCase();
    const cn_no = `${prefix}-CN/${fy_str}/${String(count).padStart(3, '0')}`;
    const cn_data = { ...orig };
    Object.assign(cn_data, {
      bill_no: cn_no,
      original_invoice_no: billNo,
      invoice_date: formatDDMonYYYY(),
      is_credit_note: true,
      sub_total: -Math.abs(orig.sub_total || 0),
      igst: -Math.abs(orig.igst || 0),
      cgst: -Math.abs(orig.cgst || 0),
      sgst: -Math.abs(orig.sgst || 0),
      grand_total: -Math.abs(orig.grand_total || 0),
      qtys: (orig.qtys || []).map((q) => -Math.abs(parseFloat(q) || 0)),
      amounts: (orig.amounts || []).map((a) => -Math.abs(parseFloat(a) || 0)),
      line_tax_amounts: (orig.line_tax_amounts || []).map((t) => -Math.abs(parseFloat(t) || 0)),
      line_total_amounts: (orig.line_total_amounts || []).map((t) => -Math.abs(parseFloat(t) || 0)),
    });

    const tenant = await getTenantId(req);
    await supabase.from('documents').upsert(
      { tenant_id: tenant, bill_no: cn_no.replace(/\//g, '_'), collection_name: 'sales_credit_notes', data: cn_data },
      { onConflict: 'tenant_id,bill_no' }
    );
    const pdfBuf = await generateInvoicePdf(cn_data, profile, { is_credit_note: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CreditNote_${cn_no.replace(/\//g, '_')}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/update-status/:bill_no(*)', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    const newStatus = (req.body && req.body.status);
    if (!['Draft', 'Confirmed', 'Paid', 'Cancelled'].includes(newStatus)) return res.status(400).json({ error: 'Invalid status' });
    const { row } = await getDocumentRow(req, billNo);
    if (!row || !row.data) return res.status(404).json({ error: 'Invoice not found' });
    const dt = row.data;
    dt.status = newStatus;
    dt.status_updated_at = nowIso();
    await updateDocumentData(req, billNo, dt);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- Document workflow (PO -> GRN -> Bill) ----------------

router.get('/v2/doc/:bill_no(*)/pending', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    const p = await getPending(req, billNo);
    if (!p) return res.status(404).json({ error: 'Document not found' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/doc/:bill_no(*)/prefill/:to_type', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    const r = await prefillFromParent(req, billNo, req.params.to_type);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/doc/:bill_no(*)/children', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    res.json({ rows: await listChildren(req, billNo) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/doc/:bill_no(*)/parents', loginRequired, async (req, res) => {
  try {
    const billNo = decodeURIComponent(req.params.bill_no);
    res.json({ rows: await listParents(req, billNo) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/v2/doc/link/:child_bill_no(*)', loginRequired, async (req, res) => {
  try {
    await unlinkChild(req, decodeURIComponent(req.params.child_bill_no));
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Roll-up of open POs and GRNs for dashboard widget.
router.get('/v2/workflow/open', loginRequired, async (req, res) => {
  try {
    const invoices = await loadInvoices(req);
    const poDocs  = invoices.filter((i) => (i.doc_category === 'purchase') && (i.doc_type === 'po'));
    const grnDocs = invoices.filter((i) => (i.doc_category === 'purchase') && (i.doc_type === 'grn'));
    const countWithPending = async (docs) => {
      let open = 0, partial = 0;
      for (const d of docs) {
        const p = await getPending(req, d.bill_no).catch(() => null);
        if (!p) continue;
        if (p.status === 'Open') open++;
        else if (p.status === 'Partial') partial++;
      }
      return { open, partial, total: docs.length };
    };
    const [po, grn] = await Promise.all([countWithPending(poDocs), countWithPending(grnDocs)]);
    res.json({ po, grn });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
