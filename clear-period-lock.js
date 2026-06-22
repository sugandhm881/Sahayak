// Run once: node clear-period-lock.js
// Deletes ALL period locks so invoices can be saved again.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const { data, error } = await supabase.from('period_locks').select('*');
  if (error) { console.error('Read error:', error.message); process.exit(1); }
  console.log('Current period locks:', data);

  if (!data || data.length === 0) {
    console.log('No period locks found — nothing to delete.');
    process.exit(0);
  }

  const { error: delErr } = await supabase.from('period_locks').delete().neq('fy', '___never___');
  if (delErr) { console.error('Delete error:', delErr.message); process.exit(1); }
  console.log('All period locks cleared. You can now create invoices.');
}

main();
