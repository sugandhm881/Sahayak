/* Sahayak — Purchase Order page. Builds a purchasing document and submits it to
   the shared /generate-invoice pipeline (doc_type: 'po'). */
const CFG = window.PURCHASE_CFG || {};
const SELLER_STATE = (CFG.seller_state || '').toLowerCase();
const GST_RATES = [18, 5, 12, 28, 0];
const INDIAN_STATES = [
  "Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat",
  "Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra",
  "Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim",
  "Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal",
  "Andaman and Nicobar Islands","Chandigarh","Dadra and Nagar Haveli","Daman and Diu",
  "Delhi","Lakshadweep","Puducherry","Jammu and Kashmir","Ladakh"
];

let vendorData = {};      // name -> saved party data
let productData = {};     // name -> { product_id, hsn, rate, taxrate }
let tsVendor, tsVState, tsSState;
let poEditMode = false, poEditBillNo = '';

const MON = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
function toDateInput(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = String(s).split('-');            // DD-Mon-YYYY
  if (p.length === 3 && MON[p[1]]) return `${p[2]}-${MON[p[1]]}-${p[0].padStart(2, '0')}`;
  return '';
}

function stateOptions() { return INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join(''); }

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('po_date').value = new Date().toISOString().slice(0, 10);

  document.getElementById('v_state').innerHTML = '<option value="">Select</option>' + stateOptions();
  document.getElementById('s_state').innerHTML = '<option value="">Select</option>' + stateOptions();
  tsVState = new TomSelect('#v_state', { onChange: calcTotals });
  tsSState = new TomSelect('#s_state', {});

  // Deliver-to toggle
  document.getElementById('showDeliverTo').addEventListener('change', function () {
    document.getElementById('deliverToBox').style.display = this.checked ? '' : 'none';
  });

  // Pincode auto-fill (vendor + warehouse)
  document.getElementById('v_pincode').addEventListener('input', () => fillPincode('v_', tsVState));
  document.getElementById('s_pincode').addEventListener('input', () => fillPincode('s_', tsSState));

  // Vendor select becomes a TomSelect immediately (no native-select flash);
  // its options fill in when /clients returns.
  tsVendor = new TomSelect('#vendorSelect', {
    create: true, persist: false,
    placeholder: 'Search or type vendor name...',
    onChange: (name) => fillVendor(name),
  });
  loadVendors();

  await loadProducts();   // products are needed before the first item row
  const editBill = new URLSearchParams(location.search).get('edit');
  if (editBill) { await loadPoForEdit(editBill); } else { addPoRow(); }
  document.getElementById('createPoBtn').addEventListener('click', submitPO);
});

// Load an existing PO into the form for editing.
async function loadPoForEdit(billNo) {
  let doc = null;
  try { const list = await (await fetch('/invoices-list')).json(); doc = (list || []).find(d => d.bill_no === billNo); } catch {}
  if (!doc) { sdError('Could not load ' + billNo + ' for editing.', 'Not Found'); addPoRow(); return; }
  poEditMode = true; poEditBillNo = billNo;

  const banner = document.getElementById('poEditBanner');
  if (banner) { banner.style.display = 'flex'; document.getElementById('poEditNo').textContent = billNo; }
  document.getElementById('createPoBtn').innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> Update Purchase Order`;

  if (tsVendor) { tsVendor.addOption({ value: doc.client_name, text: doc.client_name }); tsVendor.setValue(doc.client_name, true); }
  document.getElementById('v_name').value = doc.client_name || '';
  ['mobile', 'email', 'address1', 'address2', 'pincode', 'district', 'gstin'].forEach(f => {
    const el = document.getElementById('v_' + f); if (el) el.value = doc['client_' + f] || '';
  });
  if (tsVState) tsVState.setValue(doc.client_state || '');
  document.getElementById('v_contact').value = doc.vendor_contact_person || '';

  document.getElementById('po_date').value = toDateInput(doc.invoice_date) || document.getElementById('po_date').value;
  document.getElementById('po_expected_delivery').value = toDateInput(doc.expected_delivery_date) || doc.expected_delivery_date || '';
  document.getElementById('po_payment_term').value = doc.payment_term || '';
  document.getElementById('po_payment_mode').value = doc.payment_mode || '';
  document.getElementById('po_vendor_invoice').value = doc.vendor_invoice_number || '';

  if (doc.shipto_name || doc.shipto_address1) {
    document.getElementById('showDeliverTo').checked = true;
    document.getElementById('deliverToBox').style.display = '';
    document.getElementById('s_name').value = doc.shipto_name || '';
    document.getElementById('s_address1').value = doc.shipto_address1 || '';
    document.getElementById('s_address2').value = doc.shipto_address2 || '';
    document.getElementById('s_pincode').value = doc.shipto_pincode || '';
    document.getElementById('s_district').value = doc.shipto_district || '';
    if (tsSState) tsSState.setValue(doc.shipto_state || '');
  }

  document.getElementById('poItemsBody').innerHTML = '';
  (doc.particulars || []).forEach((name, i) => {
    const tr = addPoRow();
    const n = String(name).split('\n')[0];
    const sel = tr.querySelector('.po-item');
    if (sel.tomselect) {
      sel.tomselect.addOption({ value: n, text: n, product_id: (productData[n] && productData[n].product_id) || '' });
      sel.tomselect.setValue(n, true);   // silent — don't overwrite the stored values below
    }
    tr.querySelector('.po-hsn').value = doc.hsns ? (doc.hsns[i] || '') : '';
    tr.querySelector('.po-qty').value = doc.qtys ? Math.abs(doc.qtys[i]) : 1;
    tr.querySelector('.po-rate').value = doc.rates ? Math.abs(doc.rates[i]) : 0;
    const gst = tr.querySelector('.po-gst'); const g = doc.taxrates ? doc.taxrates[i] : 0;
    if (gst.tomselect) gst.tomselect.setValue(String(g)); else gst.value = String(g);
    calcRow(tr);
  });
  calcTotals();
}

async function loadVendors() {
  try { const r = await fetch('/clients'); vendorData = r.ok ? await r.json() : {}; } catch { vendorData = {}; }
  let docs = [];
  try { const r = await fetch('/invoices-list'); docs = r.ok ? await r.json() : []; } catch { docs = []; }
  // A party is a "vendor" if it's typed vendor/both, or it appears in any purchase document.
  const purchaseParties = new Set((docs || [])
    .filter(d => (d.doc_category || 'sale') === 'purchase')
    .map(d => (d.client_name || '').toLowerCase()).filter(Boolean));
  const names = Object.keys(vendorData).filter(n => {
    const t = (vendorData[n] && vendorData[n].type) || '';
    return t === 'vendor' || t === 'both' || purchaseParties.has(n.toLowerCase());
  });
  if (!tsVendor) return;
  tsVendor.addOptions(names.map(n => ({ value: n, text: n })));
  tsVendor.refreshOptions(false);
}

function fillVendor(name) {
  document.getElementById('v_name').value = name || '';
  const d = vendorData[name];
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  if (d) {
    set('v_mobile', d.mobile); set('v_email', d.email);
    set('v_address1', d.address1); set('v_address2', d.address2);
    set('v_pincode', d.pincode); set('v_district', d.district); set('v_gstin', d.gstin);
    if (tsVState) tsVState.setValue(d.state || '');
  }
  calcTotals();
}

async function loadProducts() {
  try {
    const r = await fetch('/particulars');
    productData = r.ok ? await r.json() : {};
  } catch { productData = {}; }
}

function productOptions() {
  return Object.entries(productData).map(([name, d]) => ({ value: name, text: name, product_id: d.product_id || '' }));
}

function addPoRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="po-item"></select></td>
    <td><input type="text" class="po-hsn" style="text-align:center;"></td>
    <td class="qty-cell"><input type="number" class="po-qty" min="0" step="1" value="1" style="text-align:center;"></td>
    <td><input type="number" class="po-rate" min="0" step="0.01" value="0" style="text-align:right;"></td>
    <td><select class="po-gst" data-no-enhance>${GST_RATES.map(g => `<option value="${g}">${g}%</option>`).join('')}</select></td>
    <td><input type="number" class="po-amount" readonly style="text-align:right; background:var(--surface-2);"></td>
    <td style="text-align:center;"><button type="button" class="row-remove" title="Remove">×</button></td>`;
  document.getElementById('poItemsBody').appendChild(tr);

  const sel = tr.querySelector('.po-item');
  const ts = new TomSelect(sel, {
    options: productOptions(), create: true, persist: false,
    searchField: ['text', 'product_id'],
    sortField: { field: 'text', direction: 'asc' },
    dropdownParent: 'body',
    placeholder: 'Search item or SKU...',
    render: {
      option: (data, escape) => {
        const badge = data.product_id
          ? `<span style="margin-left:8px;padding:1px 6px;border-radius:3px;background:#eef2ff;color:#3730a3;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.3px;">${escape(data.product_id)}</span>`
          : '';
        return `<div style="padding:9px 12px;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:8px;"><span>${escape(data.text)}</span>${badge}</div>`;
      },
      item: (data, escape) => `<div>${escape(data.text)}</div>`,
    },
    onChange: (val) => {
      const d = productData[val];
      if (d) {
        tr.querySelector('.po-hsn').value = d.hsn || '';
        tr.querySelector('.po-rate').value = d.rate || 0;
        const gst = tr.querySelector('.po-gst');
        if (gst.tomselect) gst.tomselect.setValue(String(d.taxrate || 0)); else gst.value = String(d.taxrate || 0);
      }
      calcRow(tr);
    },
  });

  tr.querySelector('.po-qty').addEventListener('input', () => calcRow(tr));
  tr.querySelector('.po-rate').addEventListener('input', () => calcRow(tr));
  const gstSel = tr.querySelector('.po-gst');
  gstSel.addEventListener('change', () => calcRow(tr));
  tr.querySelector('.row-remove').addEventListener('click', () => {
    if (ts) try { ts.destroy(); } catch {}
    tr.remove(); calcTotals();
  });
  return tr;
}

function calcRow(tr) {
  const q = parseFloat(tr.querySelector('.po-qty').value) || 0;
  const r = parseFloat(tr.querySelector('.po-rate').value) || 0;
  tr.querySelector('.po-amount').value = (q * r).toFixed(2);
  calcTotals();
}

function calcTotals() {
  const vState = tsVState ? tsVState.getValue() : '';
  const inter = (vState || '').toLowerCase() !== SELLER_STATE;
  let taxable = 0, tax = 0, grand = 0;
  document.querySelectorAll('#poItemsBody tr').forEach(tr => {
    const amt = parseFloat(tr.querySelector('.po-amount').value) || 0;   // tax-inclusive
    const gstSel = tr.querySelector('.po-gst');
    const g = parseFloat(gstSel.tomselect ? gstSel.tomselect.getValue() : gstSel.value) || 0;
    const tx = amt - amt / (1 + g / 100);
    taxable += amt - tx; tax += tx; grand += amt;
  });
  document.getElementById('poSubTotal').textContent = taxable.toFixed(2);
  document.getElementById('poCgst').textContent = inter ? '0.00' : (tax / 2).toFixed(2);
  document.getElementById('poSgst').textContent = inter ? '0.00' : (tax / 2).toFixed(2);
  document.getElementById('poIgst').textContent = inter ? tax.toFixed(2) : '0.00';
  document.getElementById('poGrandTotal').textContent = grand.toFixed(2);
}

async function fillPincode(prefix, stateTs) {
  const pin = document.getElementById(prefix + 'pincode').value;
  if (pin.length !== 6) return;
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`);
    const data = await res.json();
    if (data[0].Status === 'Success' && data[0].PostOffice && data[0].PostOffice.length) {
      const d = data[0].PostOffice[0];
      document.getElementById(prefix + 'district').value = d.District;
      if (stateTs) stateTs.setValue(d.State);
    }
  } catch {}
}

async function submitPO() {
  const vName = document.getElementById('v_name').value.trim();
  if (!vName) { sdAlert('Vendor name is required.', 'Missing Info'); return; }
  const rows = Array.from(document.querySelectorAll('#poItemsBody tr'));
  const valid = rows.filter(tr => (tr.querySelector('.po-item').tomselect?.getValue() || '') && (parseFloat(tr.querySelector('.po-qty').value) || 0) > 0);
  if (!valid.length) { sdAlert('Add at least one item with a quantity.', 'Missing Info'); return; }

  const deliver = document.getElementById('showDeliverTo').checked;
  const gv = (id) => document.getElementById(id).value.trim();
  const data = {
    doc_category: 'purchase', doc_type: 'po', invoice_type: 'goods', is_non_gst: false,
    client_name: vName,
    client_mobile: gv('v_mobile'), client_email: gv('v_email'),
    client_address1: gv('v_address1'), client_address2: gv('v_address2'),
    client_pincode: gv('v_pincode'), client_district: gv('v_district'),
    client_state: tsVState ? tsVState.getValue() : '', client_gstin: gv('v_gstin'),
    shipto_name: deliver ? gv('s_name') : '', shipto_address1: deliver ? gv('s_address1') : '',
    shipto_address2: deliver ? gv('s_address2') : '', shipto_pincode: deliver ? gv('s_pincode') : '',
    shipto_district: deliver ? gv('s_district') : '', shipto_state: deliver ? (tsSState ? tsSState.getValue() : '') : '',
    payment_term: gv('po_payment_term'), expected_delivery_date: gv('po_expected_delivery'),
    payment_mode: gv('po_payment_mode'), vendor_contact_person: gv('v_contact'),
    vendor_invoice_number: gv('po_vendor_invoice'),
    particulars: valid.map(tr => tr.querySelector('.po-item').tomselect.getValue()),
    qtys: valid.map(tr => parseFloat(tr.querySelector('.po-qty').value) || 0),
    rates: valid.map(tr => parseFloat(tr.querySelector('.po-rate').value) || 0),
    taxrates: valid.map(tr => { const g = tr.querySelector('.po-gst'); return parseFloat(g.tomselect ? g.tomselect.getValue() : g.value) || 0; }),
    hsns: valid.map(tr => tr.querySelector('.po-hsn').value.trim()),
    discounts: valid.map(() => 0),
    amounts: valid.map(tr => parseFloat(tr.querySelector('.po-amount').value) || 0),
    auto_generate: true,
  };
  if (poEditMode) {
    data.is_edit = true;
    data.manual_bill_no = poEditBillNo;
    data.auto_generate = false;
    data.manual_invoice_date = document.getElementById('po_date').value;
  }

  const btn = document.getElementById('createPoBtn');
  btn.disabled = true;
  sdLoading(poEditMode ? 'Updating Purchase Order…' : 'Creating Purchase Order…', 'Saving and generating PDF');
  try {
    const res = await fetch('/generate-invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = window.URL.createObjectURL(blob);
      a.download = 'PurchaseOrder.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      sdSuccess(poEditMode ? 'Purchase Order Updated' : 'Purchase Order Created', 'The PO PDF is downloading.', null, () => { window.location.href = '/purchase/po/new'; });
    } else {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      sdError(e.error || 'Failed to create PO.', 'Error');
    }
  } catch (e) { sdError('Network error: ' + e.message, 'Error'); }
  finally { btn.disabled = false; }
}
