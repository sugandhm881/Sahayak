const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');

async function listChildren(req, parentBillNo) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('doc_links').select('*')
    .eq('tenant_id', tenant).eq('parent_bill_no', parentBillNo);
  return data || [];
}

async function listParents(req, childBillNo) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('doc_links').select('*')
    .eq('tenant_id', tenant).eq('child_bill_no', childBillNo);
  return data || [];
}

async function linkDocs(req, parent_bill_no, parent_type, child_bill_no, child_type, line_map) {
  const tenant = await getTenantId(req);
  await supabase.from('doc_links').upsert({
    tenant_id: tenant,
    parent_bill_no, parent_type,
    child_bill_no, child_type,
    line_map: line_map || null,
  }, { onConflict: 'tenant_id,parent_bill_no,child_bill_no' });
}

async function unlinkChild(req, childBillNo) {
  const tenant = await getTenantId(req);
  await supabase.from('doc_links').delete().eq('tenant_id', tenant).eq('child_bill_no', childBillNo);
}

module.exports = { listChildren, listParents, linkDocs, unlinkChild };
