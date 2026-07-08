/* Sahayak — GRN (Goods Receipt Note) page. Receive against a Purchase Order with
   an Ordered / Received / Pending / Receive-Now grid, or a direct (no-PO) receipt.
   Submits to the shared /generate-invoice pipeline (doc_type: 'grn'). */
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

let poList = [];          // full purchase-order documents
let selectedPO = null;
let vendorData = {}, productData = {};
let tsPo, tsDvSelect, tsDvState;
let grnEditMode = false, grnEditBillNo = '';

const MON = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
function toDateInput(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = String(s).split('-');
  if (p.length === 3 && MON[p[1]]) return `${p[2]}-${MON[p[1]]}-${p[0].padStart(2, '0')}`;
  return '';
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('grn_date').value = new Date().toISOString().slice(0, 10);

  document.getElementById('directGrn').addEventListener('change', toggleDirect);
  document.getElementById('postGrnBtn').addEventListener('click', submitGRN);

  // PO select becomes a TomSelect immediately; options fill in async.
  tsPo = new TomSelect('#poSelect', {
    placeholder: 'Search open Purchase Orders...',
    onChange: (v) => { if (v) selectPO(v); },
  });
  document.getElementById('recvEmpty').style.display = 'block';
  loadPOs();
  const editBill = new URLSearchParams(location.search).get('edit');
  if (editBill) await loadGrnForEdit(editBill);
  document.getElementById('postGrnBtn').disabled = false;
});

// ── Edit an existing GRN — loads it into the direct/editable items table ──────
async function loadGrnForEdit(billNo) {
  let doc = null;
  try { const list = await (await fetch('/invoices-list')).json(); doc = (list || []).find(d => d.bill_no === billNo); } catch {}
  if (!doc) { sdError('Could not load ' + billNo + ' for editing.', 'Not Found'); return; }
  grnEditMode = true; grnEditBillNo = billNo;

  // Force the direct (editable) table; the PO-select flow is for new receipts only.
  const chk = document.getElementById('directGrn');
  chk.checked = true; chk.disabled = true;
  await toggleDirect();                                   // inits tsDvSelect/productData, adds a blank row
  document.getElementById('directBody').innerHTML = '';   // drop the blank row

  const banner = document.getElementById('grnEditBanner');
  if (banner) { banner.style.display = 'flex'; document.getElementById('grnEditNo').textContent = billNo; }
  document.getElementById('postGrnBtn').innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> Update GRN`;

  document.getElementById('grn_date').value = toDateInput(doc.invoice_date) || document.getElementById('grn_date').value;
  document.getElementById('grn_challan').value = doc.vendor_invoice_number || '';

  document.getElementById('dv_name').value = doc.client_name || '';
  document.getElementById('dv_gstin').value = doc.client_gstin || '';
  if (tsDvState) tsDvState.setValue(doc.client_state || '');
  if (tsDvSelect) { tsDvSelect.addOption({ value: doc.client_name, text: doc.client_name }); tsDvSelect.setValue(doc.client_name, true); }

  (doc.particulars || []).forEach((name, i) => {
    addDirectRow();
    const tr = document.getElementById('directBody').lastElementChild;
    const n = String(name).split('\n')[0];
    const sel = tr.querySelector('.d-item');
    if (sel.tomselect) {
      sel.tomselect.addOption({ value: n, text: n, product_id: (productData[n] && productData[n].product_id) || '' });
      sel.tomselect.setValue(n, true);   // silent — keep the stored values below
    }
    tr.querySelector('.d-hsn').value = doc.hsns ? (doc.hsns[i] || '') : '';
    tr.querySelector('.d-qty').value = doc.qtys ? Math.abs(doc.qtys[i]) : 1;
    tr.querySelector('.d-rate').value = doc.rates ? Math.abs(doc.rates[i]) : 0;
    const gst = tr.querySelector('.d-gst'); const g = doc.taxrates ? doc.taxrates[i] : 0;
    if (gst.tomselect) gst.tomselect.setValue(String(g)); else gst.value = String(g);
  });
  calcGrnTotals();
}

// ── Load open Purchase Orders ────────────────────────────────────────────────
async function loadPOs() {
  try {
    const r = await fetch('/invoices-list');
    const all = r.ok ? await r.json() : [];
    poList = all.filter(d => (d.doc_category === 'purchase') && (d.doc_type === 'po'));
  } catch { poList = []; }
  poList.sort((a, b) => (b.bill_no || '').localeCompare(a.bill_no || '', undefined, { numeric: true }));
  if (!tsPo) return;
  tsPo.addOptions(poList.map(p => ({ value: p.bill_no, text: `${p.bill_no} — ${p.client_name || 'Unknown'}` })));
  tsPo.refreshOptions(false);
}

async function selectPO(billNo) {
  selectedPO = poList.find(p => p.bill_no === billNo);
  if (!selectedPO) return;
  sdLoading('Loading PO…', 'Fetching pending items');
  let pending;
  try {
    pending = await fetch(`/v2/doc/${encodeURIComponent(billNo)}/pending`).then(x => x.json());
  } catch (e) { sdDismiss(); sdError('Could not load PO: ' + e.message, 'Error'); return; }
  sdDismiss();
  if (pending.error) { sdError(pending.error, 'Error'); return; }

  // Vendor card
  const v = selectedPO;
  const addr = [v.client_address1, v.client_address2, [v.client_district, v.client_state].filter(Boolean).join(', ')].filter(Boolean).join(', ');
  document.getElementById('vendorCard').innerHTML =
    `<b>${v.client_name || ''}</b><br>${addr || ''}${v.client_gstin ? '<br>GSTIN ' + v.client_gstin : ''}${v.client_mobile ? '<br>Mobile ' + v.client_mobile : ''}`;
  document.getElementById('vendorCard').style.display = '';

  // Receiving grid — only lines with pending qty
  const lines = (pending.lines || []).filter(l => l.qty_pending > 0.0001);
  const body = document.getElementById('recvBody');
  body.innerHTML = '';
  if (!lines.length) {
    document.getElementById('recvGridWrap').style.display = 'none';
    document.getElementById('recvActions').style.display = 'none';
    document.getElementById('recvEmpty').style.display = 'block';
    document.getElementById('recvEmpty').textContent = 'This PO has no pending items left to receive.';
    calcGrnTotals();
    return;
  }
  lines.forEach(l => {
    const tr = document.createElement('tr');
    tr.dataset.parentIdx = String(l.index);
    tr.dataset.rate = l.rate; tr.dataset.tax = l.taxrate; tr.dataset.hsn = l.hsn || '';
    tr.dataset.name = String(l.particular || '').split('\n')[0];
    tr.innerHTML = `
      <td class="item">${tr.dataset.name}</td>
      <td class="recv-num">${l.hsn || '-'}</td>
      <td class="recv-num">${l.qty_ordered}</td>
      <td class="recv-num">${l.qty_carried}</td>
      <td class="recv-pending">${l.qty_pending}</td>
      <td><input type="number" class="recv-now" min="0" max="${l.qty_pending}" step="0.001" value="${l.qty_pending}"></td>
      <td class="recv-num">${(l.rate || 0).toFixed(2)}</td>
      <td class="recv-num recv-amt">0.00</td>`;
    body.appendChild(tr);
    tr.querySelector('.recv-now').addEventListener('input', () => calcGrnTotals());
  });
  document.getElementById('recvGridWrap').style.display = '';
  document.getElementById('recvActions').style.display = 'block';
  document.getElementById('recvEmpty').style.display = 'none';
  calcGrnTotals();
}

function receiveAll(fill) {
  document.querySelectorAll('#recvBody tr').forEach(tr => {
    const inp = tr.querySelector('.recv-now');
    inp.value = fill ? inp.max : 0;
  });
  calcGrnTotals();
}

// ── Direct (no-PO) receipt ───────────────────────────────────────────────────
async function toggleDirect() {
  const direct = document.getElementById('directGrn').checked;
  document.getElementById('poReceiveSection').style.display = direct ? 'none' : '';
  document.getElementById('directSection').style.display = direct ? '' : 'none';
  if (direct && !tsDvSelect) {
    document.getElementById('dv_state').innerHTML = '<option value="">Select</option>' + INDIAN_STATES.map(s => `<option value="${s}">${s}</option>`).join('');
    tsDvState = new TomSelect('#dv_state', { onChange: calcGrnTotals });
    try { vendorData = await (await fetch('/clients')).json(); } catch { vendorData = {}; }
    try { productData = await (await fetch('/particulars')).json(); } catch { productData = {}; }
    // Vendors only: typed vendor/both, or a party seen in any purchase document.
    const purchaseParties = new Set((poList || []).map(p => (p.client_name || '').toLowerCase()).filter(Boolean));
    const vendorNames = Object.keys(vendorData).filter(n => {
      const t = (vendorData[n] && vendorData[n].type) || '';
      return t === 'vendor' || t === 'both' || purchaseParties.has(n.toLowerCase());
    });
    tsDvSelect = new TomSelect('#dv_select', {
      options: vendorNames.map(n => ({ value: n, text: n })), create: true, persist: false,
      onChange: (name) => {
        document.getElementById('dv_name').value = name || '';
        const d = vendorData[name];
        if (d) { document.getElementById('dv_gstin').value = d.gstin || ''; if (tsDvState) tsDvState.setValue(d.state || ''); }
      },
    });
    addDirectRow();
  }
  calcGrnTotals();
}

function addDirectRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="d-item"></select></td>
    <td><input type="text" class="d-hsn" style="text-align:center;"></td>
    <td><input type="number" class="d-qty" min="0" step="1" value="1" style="text-align:center;"></td>
    <td><input type="number" class="d-rate" min="0" step="0.01" value="0" style="text-align:right;"></td>
    <td><select class="d-gst" data-no-enhance>${GST_RATES.map(g => `<option value="${g}">${g}%</option>`).join('')}</select></td>
    <td><input type="number" class="d-amount" readonly style="text-align:right; background:var(--surface-2);"></td>
    <td style="text-align:center;"><button type="button" class="row-remove">×</button></td>`;
  document.getElementById('directBody').appendChild(tr);
  const ts = new TomSelect(tr.querySelector('.d-item'), {
    options: Object.entries(productData).map(([name, d]) => ({ value: name, text: name, product_id: d.product_id || '' })),
    create: true, persist: false, searchField: ['text', 'product_id'],
    sortField: { field: 'text', direction: 'asc' }, dropdownParent: 'body', placeholder: 'Search item or SKU...',
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
      if (d) { tr.querySelector('.d-hsn').value = d.hsn || ''; tr.querySelector('.d-rate').value = d.rate || 0;
        const g = tr.querySelector('.d-gst'); if (g.tomselect) g.tomselect.setValue(String(d.taxrate || 0)); }
      calcGrnTotals();
    },
  });
  tr.querySelector('.d-qty').addEventListener('input', calcGrnTotals);
  tr.querySelector('.d-rate').addEventListener('input', calcGrnTotals);
  tr.querySelector('.d-gst').addEventListener('change', calcGrnTotals);
  tr.querySelector('.row-remove').addEventListener('click', () => { try { ts.destroy(); } catch {} tr.remove(); calcGrnTotals(); });
}

// ── Totals (shared) ──────────────────────────────────────────────────────────
function calcGrnTotals() {
  const direct = document.getElementById('directGrn').checked;
  let qty = 0, taxable = 0, tax = 0, grand = 0;
  if (direct) {
    document.querySelectorAll('#directBody tr').forEach(tr => {
      const q = parseFloat(tr.querySelector('.d-qty').value) || 0;
      const r = parseFloat(tr.querySelector('.d-rate').value) || 0;
      const g = tr.querySelector('.d-gst'); const gv = parseFloat(g.tomselect ? g.tomselect.getValue() : g.value) || 0;
      const amt = q * r; tr.querySelector('.d-amount').value = amt.toFixed(2);
      const tx = amt - amt / (1 + gv / 100);
      qty += q; taxable += amt - tx; tax += tx; grand += amt;
    });
  } else {
    document.querySelectorAll('#recvBody tr').forEach(tr => {
      const q = parseFloat(tr.querySelector('.recv-now').value) || 0;
      const r = parseFloat(tr.dataset.rate) || 0;
      const g = parseFloat(tr.dataset.tax) || 0;
      const amt = q * r; tr.querySelector('.recv-amt').textContent = amt.toFixed(2);
      const tx = amt - amt / (1 + g / 100);
      qty += q; taxable += amt - tx; tax += tx; grand += amt;
    });
  }
  document.getElementById('grnQty').textContent = qty;
  document.getElementById('grnSubTotal').textContent = taxable.toFixed(2);
  document.getElementById('grnTax').textContent = tax.toFixed(2);
  document.getElementById('grnGrandTotal').textContent = grand.toFixed(2);
}

// ── Submit ───────────────────────────────────────────────────────────────────
async function submitGRN() {
  const direct = document.getElementById('directGrn').checked;
  const challan = document.getElementById('grn_challan').value.trim();
  let data;

  if (direct) {
    const vName = document.getElementById('dv_name').value.trim();
    if (!vName) { sdAlert('Vendor name is required.', 'Missing Info'); return; }
    const rows = Array.from(document.querySelectorAll('#directBody tr')).filter(tr =>
      (tr.querySelector('.d-item').tomselect?.getValue() || '') && (parseFloat(tr.querySelector('.d-qty').value) || 0) > 0);
    if (!rows.length) { sdAlert('Add at least one item.', 'Missing Info'); return; }
    data = {
      doc_category: 'purchase', doc_type: 'grn', invoice_type: 'goods', is_non_gst: false,
      client_name: vName, client_gstin: document.getElementById('dv_gstin').value.trim(),
      client_state: tsDvState ? tsDvState.getValue() : '',
      vendor_invoice_number: challan,
      particulars: rows.map(tr => tr.querySelector('.d-item').tomselect.getValue()),
      qtys: rows.map(tr => parseFloat(tr.querySelector('.d-qty').value) || 0),
      rates: rows.map(tr => parseFloat(tr.querySelector('.d-rate').value) || 0),
      taxrates: rows.map(tr => { const g = tr.querySelector('.d-gst'); return parseFloat(g.tomselect ? g.tomselect.getValue() : g.value) || 0; }),
      hsns: rows.map(tr => tr.querySelector('.d-hsn').value.trim()),
      discounts: rows.map(() => 0),
      amounts: rows.map(tr => parseFloat(tr.querySelector('.d-amount').value) || 0),
      auto_generate: true,
    };
  } else {
    if (!selectedPO) { sdAlert('Select a Purchase Order first.', 'Missing Info'); return; }
    const rows = Array.from(document.querySelectorAll('#recvBody tr')).filter(tr => (parseFloat(tr.querySelector('.recv-now').value) || 0) > 0);
    if (!rows.length) { sdAlert('Enter a "Receive Now" quantity for at least one item.', 'Nothing to Receive'); return; }
    const v = selectedPO;
    data = {
      doc_category: 'purchase', doc_type: 'grn', invoice_type: 'goods', is_non_gst: !!v.is_non_gst,
      client_name: v.client_name, client_mobile: v.client_mobile, client_email: v.client_email,
      client_address1: v.client_address1, client_address2: v.client_address2,
      client_pincode: v.client_pincode, client_district: v.client_district,
      client_state: v.client_state, client_gstin: v.client_gstin,
      po_number: v.bill_no, vendor_invoice_number: challan,
      particulars: rows.map(tr => tr.dataset.name),
      qtys: rows.map(tr => parseFloat(tr.querySelector('.recv-now').value) || 0),
      rates: rows.map(tr => parseFloat(tr.dataset.rate) || 0),
      taxrates: rows.map(tr => parseFloat(tr.dataset.tax) || 0),
      hsns: rows.map(tr => tr.dataset.hsn || ''),
      discounts: rows.map(() => 0),
      amounts: rows.map(tr => (parseFloat(tr.querySelector('.recv-now').value) || 0) * (parseFloat(tr.dataset.rate) || 0)),
      _parent_bill_no: v.bill_no, _parent_type: 'po',
      _parent_line_indexes: rows.map(tr => parseInt(tr.dataset.parentIdx, 10)),
      _parent_line_qtys: rows.map(tr => parseFloat(tr.querySelector('.recv-now').value) || 0),
      auto_generate: true,
    };
  }

  if (grnEditMode) {
    data.is_edit = true;
    data.manual_bill_no = grnEditBillNo;
    data.auto_generate = false;
    data.manual_invoice_date = document.getElementById('grn_date').value;
  }

  const btn = document.getElementById('postGrnBtn');
  btn.disabled = true;
  sdLoading(grnEditMode ? 'Updating GRN…' : 'Posting GRN…', 'Saving and generating PDF');
  try {
    const res = await fetch('/generate-invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok) {
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = window.URL.createObjectURL(blob);
      a.download = 'GRN.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      sdSuccess(grnEditMode ? 'GRN Updated' : 'GRN Posted',
        grnEditMode ? 'The GRN PDF is downloading.' : 'The GRN PDF is downloading. The PO\'s pending quantities have been updated.',
        null, () => { window.location.href = '/purchase/grn/new'; });
    } else {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      sdError(e.error || 'Failed to post GRN.', 'Error');
    }
  } catch (e) { sdError('Network error: ' + e.message, 'Error'); }
  finally { btn.disabled = false; }
}
