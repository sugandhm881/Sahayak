const env = require('../config/env');
const { safeItemId, getProduct, upsertProduct, listProducts } = require('../repositories/inventory.repo');
const { getSellerProfile, patchSellerProfile } = require('../repositories/configs.repo');
const { loadParticulars } = require('../repositories/particulars.repo');

const BASE = env.EASYECOM_API_URL.replace(/\/$/, '');

// Per-process JWT cache keyed by api_key
const jwtCache = {};

// ─── Auth ────────────────────────────────────────────────────────────────────

// Merge .env fallbacks so credentials from .env work even if not saved to profile yet
function mergedProfile(profile) {
  return {
    easyecom_api_key:      (profile.easyecom_api_key      || '').trim() || (process.env.EASYECOM_API_KEY || '').trim(),
    easyecom_jwt_token:    (profile.easyecom_jwt_token    || '').trim() || (process.env.EASYECOM_JWT     || '').trim(),
    easyecom_email:        (profile.easyecom_email        || '').trim() || (process.env.EASYECOM_EMAIL   || '').trim(),
    easyecom_password:     (profile.easyecom_password     || '').trim() || (process.env.EASYECOM_PASSWORD|| '').trim(),
    easyecom_location_key: (profile.easyecom_location_key || '').trim() || (process.env.EASYECOM_WH_KEY  || '').trim(),
  };
}

async function resolveJwt(rawProfile) {
  const p = mergedProfile(rawProfile);

  // Priority 1: direct JWT token (90-day, from Easyecom dashboard)
  if (p.easyecom_jwt_token) return p.easyecom_jwt_token;

  // Priority 2: auto-generate from email + password
  if (!p.easyecom_email || !p.easyecom_password)
    throw new Error('Easyecom: JWT token not configured. Go to Settings → Integrations and paste your Easyecom JWT Token.');

  const cacheKey = p.easyecom_api_key || p.easyecom_email;
  const cached   = jwtCache[cacheKey];
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`${BASE}${env.EASYECOM_JWT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(p.easyecom_api_key && { 'x-api-key': p.easyecom_api_key }) },
    body: JSON.stringify({ email: p.easyecom_email, password: p.easyecom_password, location_key: p.easyecom_location_key || '' }),
  });
  const data = await res.json();
  const token = data?.data?.jwt_token || data?.jwt_token || data?.token;
  if (!token) throw new Error(`Easyecom login failed: ${data?.message || data?.error || JSON.stringify(data)}`);

  jwtCache[cacheKey] = { token, expiresAt: Date.now() + 85 * 24 * 60 * 60 * 1000 };
  return token;
}

// Invalidate cached JWT after a 401
function invalidateJwt(profile) {
  const p = mergedProfile(profile);
  const key = (p.easyecom_api_key || p.easyecom_email || '').trim();
  delete jwtCache[key];
}

function bearerHeaders(jwt, apiKey) {
  const h = { 'Authorization': `Bearer ${jwt}` };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

function fullHeaders(jwt, apiKey) {
  return {
    'Content-Type':  'application/json',
    'x-api-key':     apiKey,
    'Authorization': `Bearer ${jwt}`,
  };
}

function requireConfig(profile) {
  const p = mergedProfile(profile);
  const apiKey = p.easyecom_api_key;
  const hasJwt = !!(p.easyecom_jwt_token || p.easyecom_email);
  if (!apiKey) throw new Error('Easyecom API key not configured. Go to Settings → Integrations.');
  if (!hasJwt) throw new Error('Easyecom JWT token (or email + password) not configured. Go to Settings → Integrations.');
  return apiKey;
}

// ─── Hit Counter ─────────────────────────────────────────────────────────────

function hitStatus(profile) {
  const limit        = parseInt(profile.easyecom_hit_limit || 250);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const count        = profile.easyecom_hits_month === currentMonth
    ? parseInt(profile.easyecom_hits_count || 0)
    : 0;
  return { count, limit, remaining: limit - count, ok: count < limit };
}

async function addHits(req, n) {
  const profile      = await getSellerProfile(req);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const base         = profile.easyecom_hits_month === currentMonth
    ? parseInt(profile.easyecom_hits_count || 0)
    : 0;
  await patchSellerProfile(req, {
    easyecom_hits_count: base + n,
    easyecom_hits_month: currentMonth,
  });
  return base + n;
}

// ─── Fetch Inventory from Easyecom ───────────────────────────────────────────
// GET /getInventoryDetailsV3 — Bearer token only, paginated (limit 50 per page)

async function fetchInventory(profile) {
  const apiKey = requireConfig(profile);
  const jwt    = await resolveJwt(profile);
  const p      = mergedProfile(profile);
  const locKey = p.easyecom_location_key;
  const all    = [];
  let nextUrl  = `/getInventoryDetailsV3?includeLocations=1&limit=50`;
  let pages    = 0;

  while (nextUrl) {
    const url = `${BASE}${nextUrl}`;
    const res  = await fetch(url, { headers: bearerHeaders(jwt, apiKey) });
    pages++;

    // Safe JSON parse — Easyecom sometimes returns plain-text errors on 4xx
    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (res.status === 401) { invalidateJwt(profile); throw new Error('Easyecom: Unauthorized — check your JWT token or credentials.'); }
    if (!res.ok) throw new Error(`Easyecom inventory fetch failed (${res.status}): ${data?.message || data?.error || res.statusText}`);

    const rows     = data?.data?.inventoryData || [];
    const filtered = locKey ? rows.filter(r => r.location_key === locKey) : rows;
    all.push(...filtered);

    nextUrl = data?.data?.nextUrl || null;
    if (!rows.length) break;
  }

  all._pages = pages;
  return all;
}

// ─── Update a single SKU in Easyecom ─────────────────────────────────────────
// POST /inventory — x-api-key + Bearer, body {sku, quantity}
// quantity is a DELTA: positive = add, negative = deduct
// Requires account set to "Add new stock" mode in Easyecom settings

async function updateOneSku(profile, jwt, apiKey, sku, quantity) {
  const body = { sku, quantity };
  console.log(`[Easyecom] POST /inventory body:`, JSON.stringify(body));
  const res = await fetch(`${BASE}/inventory`, {
    method: 'POST',
    headers: fullHeaders(jwt, apiKey),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log(`[Easyecom] POST /inventory status:${res.status} response:`, JSON.stringify(data));
  if (res.status === 401) throw new Error('401_UNAUTHORIZED');
  if (!res.ok) throw new Error(`SKU "${sku}" failed (${res.status}): ${data?.message || JSON.stringify(data)}`);
  return data;
}

// ─── Push ALL pending adjustments ────────────────────────────────────────────
// POST /inventory sets ABSOLUTE stock, so we send: easyecom_stock + pending_adj
// 1 API hit per distinct SKU — counts each toward the monthly limit

async function pushAllPending(req, profile) {
  const apiKey = requireConfig(profile);
  const products = await listProducts(req);
  const pending  = products.filter(p => parseFloat(p.pending_easyecom_adj || 0) !== 0
    && (p.easyecom_sku || p.product_id));

  if (!pending.length) return { pushed: 0, message: 'No pending adjustments.' };

  let jwt;
  try { jwt = await resolveJwt(profile); }
  catch (e) { throw new Error(`Easyecom auth error: ${e.message}`); }

  const errors  = [];
  let pushed    = 0;

  for (const p of pending) {
    const sku          = p.easyecom_sku || p.product_id;
    const pendingAdj   = parseFloat(p.pending_easyecom_adj);
    const cachedStock  = parseFloat(p.easyecom_stock ?? p.current_stock ?? 0);
    // POST /inventory takes ABSOLUTE quantity — send last-known Easyecom stock + our delta
    const newAbsolute  = Math.max(0, cachedStock + pendingAdj);
    const sid          = safeItemId(p.item_name);

    try {
      await updateOneSku(profile, jwt, apiKey, sku, newAbsolute);
      // Clear pending and update cached easyecom_stock on success
      if (sid) await upsertProduct(req, sid, {
        pending_easyecom_adj: 0,
        easyecom_stock: newAbsolute,
      });
      pushed++;
    } catch (e) {
      if (e.message === '401_UNAUTHORIZED') {
        invalidateJwt(profile);
        errors.push(`${sku}: Unauthorized — refresh your JWT token`);
        break;
      }
      errors.push(`${sku}: ${e.message}`);
    }
  }

  // Count actual API hits (one per SKU attempted)
  await addHits(req, pending.length);

  const result = { pushed, total: pending.length };
  if (errors.length) result.errors = errors;
  return result;
}

// ─── Sync Easyecom stock → local Supabase cache ───────────────────────────────

async function syncInventoryToLocal(req, profile) {
  const items = await fetchInventory(profile);
  const pages = items._pages || Math.max(1, Math.ceil(items.length / 50));
  await addHits(req, pages);

  // Only sync SKUs that exist in the product catalog (particulars.product_id)
  // item_name always comes from the catalog, not Easyecom
  // All SKU lookups are case-insensitive (catalog may store 'TE-test1', Easyecom returns 'TE-TEST1')
  const catalogBySku = {};   // UPPER(sku) → item_name
  const catalogSkuMap = {};  // UPPER(sku) → original product_id (for ensured step)
  const catalog = await loadParticulars(req);
  for (const [name, data] of Object.entries(catalog)) {
    const pid = (data.product_id || '').trim();
    if (pid) { catalogBySku[pid.toUpperCase()] = name; catalogSkuMap[pid.toUpperCase()] = pid; }
  }

  // Index existing local inventory by UPPER(easyecom_sku) so we reuse the right safe_id
  // Also keep the full product so we can read pending_easyecom_adj during sync
  const local = await listProducts(req);
  const localBySku    = {};  // UPPER(sku) → _safe_id
  const localDataBySku = {}; // UPPER(sku) → product data
  for (const p of local) {
    const s = (p.easyecom_sku || '').trim().toUpperCase();
    if (s && !localBySku[s]) { localBySku[s] = p._safe_id; localDataBySku[s] = p; }
  }

  let synced = 0;
  const now = new Date().toISOString();
  const syncedSkus = new Set();

  for (const item of items) {
    const sku    = (item.sku || item.master_sku || item.product_sku || '').trim();
    const skuKey = sku.toUpperCase();
    const qty    = parseFloat(item.availableInventory ?? item.available_quantity ?? 0);
    if (!sku) continue;

    const catalogName = catalogBySku[skuKey];
    if (!catalogName) continue; // skip items not in product catalog

    // Prefer the existing safe_id (avoids duplicates); fall back to deriving from catalog name
    const sid = localBySku[skuKey] || safeItemId(catalogName);
    if (!sid) continue;

    // Preserve any unsent B2B adjustments: current_stock = easyecom_qty + pending
    const existing    = localDataBySku[skuKey] || {};
    const pendingAdj  = parseFloat(existing.pending_easyecom_adj || 0);

    await upsertProduct(req, sid, {
      item_name:          catalogName,
      easyecom_stock:     qty,
      easyecom_sku:       sku,
      easyecom_synced_at: now,
      current_stock:      qty + pendingAdj,
      last_updated:       now,
    });
    syncedSkus.add(skuKey);
    synced++;
  }

  // Ensure every catalog product exists in local inventory,
  // even if Easyecom has no stock entry for it
  let ensured = 0;
  for (const [name, catData] of Object.entries(catalog)) {
    const pid    = (catData.product_id || '').trim();
    const pidKey = pid.toUpperCase();
    if (!pid || syncedSkus.has(pidKey)) continue; // already handled above
    const sid = localBySku[pidKey] || safeItemId(name);
    if (!sid) continue;
    // Only create the row — don't overwrite stock if it already exists
    const existing = local.find(p => p._safe_id === sid || (p.easyecom_sku || '').trim().toUpperCase() === pidKey);
    if (!existing) {
      await upsertProduct(req, sid, { item_name: name, easyecom_sku: pid, current_stock: 0, last_updated: now });
      ensured++;
    } else if (!existing.item_name) {
      // Fix missing name on existing item
      await upsertProduct(req, existing._safe_id || sid, { item_name: name, easyecom_sku: pid });
      ensured++;
    }
  }

  return { synced, ensured, total: items.length, pages };
}

// ─── Queue pending + optional auto-push (called from invoice create/delete) ──

async function queueAndMaybePush(req, profile, particulars, qtys, direction, refDocNo) {
  if (!Array.isArray(particulars) || !particulars.length) return;

  // Load product catalog once to resolve product_id (SKU) for each item
  const catalog = await loadParticulars(req);

  // Step 1: accumulate pending per item — no API hits
  for (let i = 0; i < particulars.length; i++) {
    const name = particulars[i];
    const qty  = parseFloat(qtys[i] || 0);
    if (!name || qty <= 0) continue;
    const sid = safeItemId(name);
    if (!sid) continue;

    const existing       = await getProduct(req, sid) || {};
    const catalogSku     = (catalog[name] && catalog[name].product_id || '').trim();
    const currentPending = parseFloat(existing.pending_easyecom_adj || 0);
    await upsertProduct(req, sid, {
      pending_easyecom_adj: currentPending + qty * direction,
      easyecom_sku:         existing.easyecom_sku || catalogSku || null,
    });
  }

  // Step 2: auto-push if enabled, configured, and hits remain
  const p        = mergedProfile(profile);
  const apiKey   = p.easyecom_api_key;
  const hasAuth  = !!(p.easyecom_jwt_token || p.easyecom_email);
  const autoPush = profile.easyecom_auto_push === true || profile.easyecom_auto_push === 'true';
  const { ok }   = hitStatus(profile);

  if (!apiKey || !hasAuth || !autoPush || !ok) return;

  try {
    await pushAllPending(req, profile);
  } catch (e) {
    // Never block the invoice save
    console.error(`[Easyecom] auto-push after "${refDocNo}" failed: ${e.message}`);
  }
}

module.exports = {
  hitStatus,
  queueAndMaybePush,
  pushAllPending,
  syncInventoryToLocal,
};