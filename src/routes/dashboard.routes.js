const express = require('express');
const router = express.Router();

const { loginRequired } = require('../middleware/auth');
const { loadInvoices } = require('../repositories/documents.repo');
const { listProducts } = require('../repositories/inventory.repo');
const { parseInvoiceDate } = require('../utils/dates');
const reports = require('./reports.routes');

router.get('/dashboard', loginRequired, (req, res) => res.render('dashboard.html'));

router.get('/dashboard-data', loginRequired, async (req, res) => {
  try {
    const fy = req.query.fy || null;
    let fyFrom = null, fyTo = null;
    if (fy) {
      const m = /^(\d{4})-(\d{2})$/.exec(fy);
      if (m) {
        const sy = parseInt(m[1]);
        fyFrom = new Date(sy, 3, 1);
        fyTo   = new Date(sy + 1, 2, 31, 23, 59, 59, 999);
      }
    }

    const invoices = await loadInvoices(req);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const this_month_num = today.getMonth() + 1;
    const this_year = today.getFullYear();
    let today_sales = 0, month_sales = 0, today_purchase = 0, month_purchase = 0;
    const monthly_trend = {};
    const top_clients = {};
    const doc_counts = { invoice: 0, cn: 0, po: 0, grn: 0, bill: 0, dn: 0 };

    for (const inv of invoices) {
      const cat = inv.doc_category || 'sale';
      const dtype = inv.doc_type || 'invoice';
      const is_cn = !!inv.is_credit_note;
      if (inv.status === 'Cancelled') continue;
      const amt = parseFloat(inv.grand_total || 0);

      let inv_date = parseInvoiceDate(inv.invoice_date || '');
      let inv_month_num = 0, inv_year = 0, inv_month_label = '', inv_today = false;
      if (inv_date) {
        inv_month_num = inv_date.getMonth() + 1;
        inv_year = inv_date.getFullYear();
        const monNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        inv_month_label = `${monNames[inv_date.getMonth()]} ${String(inv_year).slice(-2)}`;
        inv_today = (inv_date.getTime() === today.getTime());
      }
      const inFy = !fyFrom || (inv_date && inv_date >= fyFrom && inv_date <= fyTo);

      if (is_cn) doc_counts.cn = (doc_counts.cn || 0) + 1;
      else if (dtype in doc_counts) doc_counts[dtype] = (doc_counts[dtype] || 0) + 1;

      if (cat === 'sale' && !is_cn && dtype === 'invoice') {
        if (inv_today) today_sales += amt;
        if (inv_month_num === this_month_num && inv_year === this_year) month_sales += amt;
        if (inv_date && inFy) monthly_trend[inv_month_label] = (monthly_trend[inv_month_label] || 0) + amt;
        if (inFy) { const cname = inv.client_name || 'Unknown'; top_clients[cname] = (top_clients[cname] || 0) + amt; }
      } else if (cat === 'purchase' && dtype === 'bill') {
        if (inv_today) today_purchase += amt;
        if (inv_month_num === this_month_num && inv_year === this_year) month_purchase += amt;
      }
    }

    let out_count = 0, out_tot = 0;
    try {
      const out = await reports.computeOutstanding(req, fy);
      out_count = out.length;
      out_tot = out.reduce((s, o) => s + (o.balance || 0), 0);
    } catch {}

    let low_stock = [];
    try {
      const prods = await listProducts(req);
      for (const item of prods) {
        const stock = parseFloat(item.current_stock || 0);
        const reorder = parseFloat(item.reorder_level || 0);
        if (stock <= reorder) low_stock.push({ item: item.item_name || '', stock, reorder });
      }
    } catch {}

    const monNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const trendArr = Object.entries(monthly_trend)
      .sort(([a], [b]) => {
        const [ma, ya] = a.split(' '); const [mb, yb] = b.split(' ');
        const da = new Date(2000 + parseInt(ya, 10), monNames.indexOf(ma), 1);
        const db = new Date(2000 + parseInt(yb, 10), monNames.indexOf(mb), 1);
        return da - db;
      });
    const finalTrend = fyFrom ? trendArr : trendArr.slice(-6);

    res.json({
      today_sales: Math.round(today_sales * 100) / 100,
      month_sales: Math.round(month_sales * 100) / 100,
      today_purchase: Math.round(today_purchase * 100) / 100,
      month_purchase: Math.round(month_purchase * 100) / 100,
      outstanding_count: out_count,
      outstanding_total: Math.round(out_tot * 100) / 100,
      low_stock_count: low_stock.length,
      low_stock_items: low_stock.slice(0, 5),
      monthly_trend: finalTrend,
      top_clients: Object.entries(top_clients).sort((a, b) => b[1] - a[1]).slice(0, 5),
      doc_counts,
      total_invoices: invoices.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
