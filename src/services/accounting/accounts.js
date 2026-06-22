// Standard chart of accounts seeded per tenant.
// Codes are stable identifiers used by the journal posting service.

const STANDARD_ACCOUNTS = [
  { code: 'SALES',            name: 'Sales',                    type: 'income' },
  { code: 'PURCHASES',        name: 'Purchases',                type: 'expense' },
  // Output GST (collected on sales) — split so GSTR-1/3B can read directly
  { code: 'CGST_OUTPUT',      name: 'CGST Payable (Output)',    type: 'liability' },
  { code: 'SGST_OUTPUT',      name: 'SGST Payable (Output)',    type: 'liability' },
  { code: 'IGST_OUTPUT',      name: 'IGST Payable (Output)',    type: 'liability' },
  // Input GST (paid on purchases)
  { code: 'CGST_INPUT',       name: 'CGST Receivable (Input)',  type: 'asset' },
  { code: 'SGST_INPUT',       name: 'SGST Receivable (Input)',  type: 'asset' },
  { code: 'IGST_INPUT',       name: 'IGST Receivable (Input)',  type: 'asset' },
  // Legacy aggregate accounts (kept for old journal rows posted before the split)
  { code: 'GST_OUTPUT',       name: 'GST Output (legacy)',      type: 'liability' },
  { code: 'GST_INPUT',        name: 'GST Input (legacy)',       type: 'asset' },
  // Party control + cash-likes
  { code: 'SUBLEDGER',        name: 'Party Subledger',          type: 'asset',     is_control: true },
  { code: 'BANK',             name: 'Bank',                     type: 'asset' },
  { code: 'CASH',             name: 'Cash',                     type: 'asset' },
  { code: 'TDS_RECEIVABLE',   name: 'TDS Receivable',           type: 'asset' },
  // Expense categories
  { code: 'EXP_GENERAL',      name: 'General Expense',          type: 'expense' },
  { code: 'EXP_RENT',         name: 'Rent',                     type: 'expense' },
  { code: 'EXP_SALARY',       name: 'Salary & Wages',           type: 'expense' },
  { code: 'EXP_UTILITIES',    name: 'Utilities',                type: 'expense' },
  { code: 'EXP_TRAVEL',       name: 'Travel',                   type: 'expense' },
  { code: 'EXP_BANK_CHARGES', name: 'Bank Charges',             type: 'expense' },
  { code: 'EXP_PROF_FEES',    name: 'Professional Fees',        type: 'expense' },
  { code: 'DISCOUNT_GIVEN',   name: 'Discount Given',           type: 'expense' },
  { code: 'ROUND_OFF',        name: 'Rounding Off',             type: 'expense' },
  { code: 'OPENING_EQUITY',   name: 'Opening Balance Equity',   type: 'equity' },
];

async function seedAccounts(supabase, tenant_id) {
  const rows = STANDARD_ACCOUNTS.map((a) => ({
    tenant_id,
    code: a.code,
    name: a.name,
    type: a.type,
    is_control: !!a.is_control,
  }));
  // Upsert is safe + idempotent (unique on tenant_id,code)
  await supabase.from('accounts').upsert(rows, { onConflict: 'tenant_id,code', ignoreDuplicates: true });
}

// Cash-like account code from payment mode string.
function accountForMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (m.includes('cash')) return 'CASH';
  return 'BANK';
}

module.exports = { STANDARD_ACCOUNTS, seedAccounts, accountForMode };
