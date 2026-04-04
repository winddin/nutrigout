// /api/fridge.js — Vercel Serverless Function
// Auth: Supabase JWT verification → per-user data isolation
// DB: Supabase PostgreSQL via REST API

const ALLOWED_ORIGINS = [
  'https://nutrigout.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service role key for admin ops

// ─── VERIFY JWT & GET USER ID ──────────────────────────────────────
async function getUserId(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;

  // Verify token with Supabase
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.id || null;
}

// ─── SUPABASE REST HELPERS ─────────────────────────────────────────
function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  };
}

function sbUrl(table, params) {
  return `${SUPABASE_URL}/rest/v1/${table}${params || ''}`;
}

async function sbGetAll(table, userId) {
  const res = await fetch(
    sbUrl(table, `?user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc`),
    { headers: sbHeaders() }
  );
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

async function sbDeleteNotIn(table, userId, ids) {
  let filter;
  if (ids.length === 0) {
    // Delete all rows for this user
    filter = `?user_id=eq.${encodeURIComponent(userId)}`;
  } else {
    const inList = ids.map(id => `"${id}"`).join(',');
    filter = `?user_id=eq.${encodeURIComponent(userId)}&id=not.in.(${inList})`;
  }
  const res = await fetch(sbUrl(table, filter), {
    method: 'DELETE',
    headers: sbHeaders(),
  });
  if (!res.ok) throw new Error(`DELETE stale ${table}: ${res.status}`);
}

// ─── ROW MAPPERS ──────────────────────────────────────────────────
function invToDb(item, userId) {
  return {
    id:         item.id,
    user_id:    userId,
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

function shopToDb(item, userId) {
  return {
    id:         item.id,
    user_id:    userId,
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // Verify auth
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized — please sign in' });
  }

  // ── GET ──
  if (req.method === 'GET') {
    try {
      const [invRows, shopRows] = await Promise.all([
        sbGetAll('inventory', userId),
        sbGetAll('shopping',  userId),
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

  // ── POST: full sync ──
  if (req.method === 'POST') {
    const { type, data } = req.body || {};
    if (!type || !Array.isArray(data)) {
      return res.status(400).json({ error: 'body must have type and data[]' });
    }
    if (!['inventory', 'shopping'].includes(type)) {
      return res.status(400).json({ error: 'invalid type' });
    }
    try {
      if (type === 'inventory') {
        if (data.length > 0) await sbUpsert('inventory', data.map(i => invToDb(i, userId)));
        await sbDeleteNotIn('inventory', userId, data.map(i => i.id));
      } else {
        if (data.length > 0) await sbUpsert('shopping', data.map(i => shopToDb(i, userId)));
        await sbDeleteNotIn('shopping', userId, data.map(i => i.id));
      }
      return res.status(200).json({ ok: true, saved: data.length });
    } catch (err) {
      console.error('POST error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
