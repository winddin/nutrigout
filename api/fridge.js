// /api/fridge.js — Vercel Serverless Function
// Backend: Supabase (PostgreSQL) via REST API
// No npm packages needed — uses fetch() with Supabase REST API directly

const ALLOWED_ORIGINS = [
  'https://nutrigout.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

// ─── SUPABASE HELPERS ─────────────────────────────────────────────
function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': process.env.SUPABASE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  };
}

function sbUrl(table, params) {
  return `${process.env.SUPABASE_URL}/rest/v1/${table}${params || ''}`;
}

async function sbGetAll(table) {
  const res = await fetch(sbUrl(table, '?order=updated_at.desc'), { headers: sbHeaders() });
  if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbUpsert(table, rows) {
  const res = await fetch(sbUrl(table), {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`UPSERT ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbDeleteNotIn(table, ids) {
  // Build filter: delete rows whose id is NOT in current list
  const filter = ids.length
    ? `?id=not.in.(${ids.map(id => `"${id}"`).join(',')})`
    : '?id=neq.__none__'; // matches all (delete everything)
  const res = await fetch(sbUrl(table, filter), {
    method: 'DELETE',
    headers: sbHeaders(),
  });
  if (!res.ok) throw new Error(`DELETE stale ${table}: ${res.status}`);
}

// ─── ROW MAPPERS ──────────────────────────────────────────────────
function invToDb(item) {
  return {
    id:         item.id,
    name:       item.name,
    qty:        item.qty,
    unit:       item.unit,
    min_qty:    item.minQty || 0,
    expiry:     item.expiry || null,
    category:   item.category || 'other',
    emoji:      item.emoji || null,
    updated_at: new Date().toISOString(),
  };
}

function dbToInv(row) {
  return {
    id:       row.id,
    name:     row.name,
    qty:      Number(row.qty),
    unit:     row.unit,
    minQty:   Number(row.min_qty),
    expiry:   row.expiry || null,
    category: row.category,
    emoji:    row.emoji || '🍱',
  };
}

function shopToDb(item) {
  return {
    id:         item.id,
    name:       item.name,
    qty:        item.qty,
    unit:       item.unit,
    shop_date:  item.shopDate || null,
    note:       item.note || null,
    emoji:      item.emoji || '🛍',
    updated_at: new Date().toISOString(),
  };
}

function dbToShop(row) {
  return {
    id:       row.id,
    name:     row.name,
    qty:      Number(row.qty),
    unit:     row.unit,
    shopDate: row.shop_date || null,
    note:     row.note || '',
    emoji:    row.emoji || '🛍',
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    return res.status(500).json({
      error: 'Supabase not configured',
      hint: 'Add SUPABASE_URL and SUPABASE_KEY to Vercel Environment Variables',
    });
  }

  // ── GET ──────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const [invRows, shopRows] = await Promise.all([
        sbGetAll('inventory'),
        sbGetAll('shopping'),
      ]);
      return res.status(200).json({
        inventory: invRows.map(dbToInv),
        shopping:  shopRows.map(dbToShop),
      });
    } catch (err) {
      console.error('GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: full sync (upsert + delete removed rows) ──
  if (req.method === 'POST') {
    const { type, data } = req.body || {};
    if (!type || !Array.isArray(data)) {
      return res.status(400).json({ error: 'body must have type and data[]' });
    }
    if (!['inventory', 'shopping'].includes(type)) {
      return res.status(400).json({ error: 'type must be "inventory" or "shopping"' });
    }
    try {
      if (type === 'inventory') {
        if (data.length > 0) await sbUpsert('inventory', data.map(invToDb));
        await sbDeleteNotIn('inventory', data.map(i => i.id));
      } else {
        if (data.length > 0) await sbUpsert('shopping', data.map(shopToDb));
        await sbDeleteNotIn('shopping', data.map(i => i.id));
      }
      return res.status(200).json({ ok: true, saved: data.length });
    } catch (err) {
      console.error('POST error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
