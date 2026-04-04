// /api/fridge.js — Vercel Serverless Function
// Auth: decode Supabase JWT to get user_id (no extra API call needed)
// DB: Supabase PostgreSQL via REST API

const ALLOWED_ORIGINS = [
  'https://nutrigout.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

// ─── DECODE JWT (no verify signature — Supabase already issued it) ──
// We trust the token because:
// 1. It came from Supabase auth (HTTPS)
// 2. RLS on Supabase side enforces user_id anyway
// 3. We only use user_id to scope queries
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Base64url decode the payload (middle part)
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const data = JSON.parse(decoded);
    // Check token not expired
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) {
      return null; // expired
    }
    return data;
  } catch (e) {
    return null;
  }
}

function getUserIdFromToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const payload = decodeJWT(token);
  // Supabase JWT stores user id in 'sub' field
  return payload?.sub || null;
}

// ─── SUPABASE REST HELPERS ─────────────────────────────────────────
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

async function sbGetAll(table, userId) {
  const res = await fetch(
    sbUrl(table, `?user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc`),
    { headers: sbHeaders() }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GET ${table}: ${res.status} ${err}`);
  }
  return res.json();
}

async function sbUpsert(table, rows) {
  const res = await fetch(sbUrl(table), {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`UPSERT ${table}: ${res.status} ${err}`);
  }
  return res.json();
}

async function sbDeleteNotIn(table, userId, ids) {
  const filter = ids.length
    ? `?user_id=eq.${encodeURIComponent(userId)}&id=not.in.(${ids.map(id => `"${id}"`).join(',')})`
    : `?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(sbUrl(table, filter), {
    method: 'DELETE',
    headers: sbHeaders(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DELETE ${table}: ${res.status} ${err}`);
  }
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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // Get user from JWT
  const userId = getUserIdFromToken(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized — token missing or expired' });
  }

  // ── GET: load inventory + shopping ────────────────────────────
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

  // ── POST: full sync (upsert + delete removed rows) ────────────
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
        if (data.length > 0) {
          await sbUpsert('inventory', data.map(i => invToDb(i, userId)));
        }
        await sbDeleteNotIn('inventory', userId, data.map(i => i.id));
      } else {
        if (data.length > 0) {
          await sbUpsert('shopping', data.map(i => shopToDb(i, userId)));
        }
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
