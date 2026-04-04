// /api/ledger.js — Vercel Serverless Function
// Ledger model: inventory_log + shopping_trips + shopping_items
// GET  /api/ledger?type=inventory          → inventory master + computed balances
// GET  /api/ledger?type=inventory_log&item_id=xxx → transaction history for one item
// GET  /api/ledger?type=shopping           → all trips + items
// POST /api/ledger  { type, ...payload }   → write operations

const ALLOWED_ORIGINS = [
  'https://nutrigout.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

// ─── JWT decode ──────────────────────────────────────────────────
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
    const data = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function getUserId(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const payload = decodeJWT(token);
  return payload?.sub || null;
}

// ─── Supabase helpers ────────────────────────────────────────────
const SB_URL  = () => process.env.SUPABASE_URL;
const SB_KEY  = () => process.env.SUPABASE_KEY;

function sbH(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'apikey': SB_KEY(),
    'Authorization': `Bearer ${SB_KEY()}`,
    'Prefer': 'return=representation',
    ...extra,
  };
}

function url(table, qs = '') {
  return `${SB_URL()}/rest/v1/${table}${qs}`;
}

async function sbGet(table, qs) {
  const r = await fetch(url(table, qs), { headers: sbH() });
  if (!r.ok) throw new Error(`GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbPost(table, body, prefer = 'resolution=merge-duplicates,return=representation') {
  const r = await fetch(url(table), {
    method: 'POST',
    headers: sbH({ Prefer: prefer }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbPatch(table, qs, body) {
  const r = await fetch(url(table, qs), {
    method: 'PATCH',
    headers: sbH({ Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbDelete(table, qs) {
  const r = await fetch(url(table, qs), { method: 'DELETE', headers: sbH() });
  if (!r.ok) throw new Error(`DELETE ${table}: ${r.status} ${await r.text()}`);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL() || !SB_KEY()) return res.status(500).json({ error: 'Supabase not configured' });

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const type = req.query?.type || req.body?.type;

  try {
    // ══ GET ══════════════════════════════════════════════════════
    if (req.method === 'GET') {

      // GET inventory — master list + computed balance from log
      if (type === 'inventory') {
        const [items, logs] = await Promise.all([
          sbGet('inventory', `?user_id=eq.${userId}&order=sort_order.asc,name.asc`),
          sbGet('inventory_log', `?user_id=eq.${userId}&order=created_at.asc`),
        ]);
        // Compute balance per item_id
        const balances = {};
        for (const log of logs) {
          balances[log.item_id] = (balances[log.item_id] || 0) + Number(log.delta);
        }
        const result = items.map(item => ({
          ...item,
          qty: balances[item.id] || 0,
        }));
        return res.status(200).json(result);
      }

      // GET inventory_log for one item
      if (type === 'inventory_log') {
        const itemId = req.query.item_id;
        if (!itemId) return res.status(400).json({ error: 'item_id required' });
        const logs = await sbGet('inventory_log',
          `?user_id=eq.${userId}&item_id=eq.${itemId}&order=created_at.desc&limit=50`);
        return res.status(200).json(logs);
      }

      // GET shopping — trips + items
      if (type === 'shopping') {
        const [trips, items] = await Promise.all([
          sbGet('shopping_trips', `?user_id=eq.${userId}&order=trip_date.desc,created_at.desc`),
          sbGet('shopping_items', `?user_id=eq.${userId}&order=created_at.asc`),
        ]);
        // Attach items to trips
        const result = trips.map(trip => ({
          ...trip,
          items: items.filter(i => i.trip_id === trip.id),
        }));
        return res.status(200).json(result);
      }

      return res.status(400).json({ error: 'invalid type' });
    }

    // ══ POST ══════════════════════════════════════════════════════
    if (req.method === 'POST') {
      const body = req.body || {};

      // Add inventory item (master) + initial log entry
      if (type === 'add_inventory_item') {
        const { item, initialQty, note } = body;
        if (!item?.id || !item?.name) return res.status(400).json({ error: 'item required' });
        // Upsert master record — only send known DB columns
        // Build row with only columns that exist in DB
        // sort_order = timestamp ms → always unique, always newest last
        const invRow = {
          id:         item.id,
          user_id:    userId,
          name:       item.name,
          unit:       item.unit     || 'g',
          min_qty:    item.min_qty  || item.minQty || 0,
          category:   item.category || 'other',
          sort_order: Date.now(),
          qty:        0,
        };
        if (item.emoji)  invRow.emoji  = item.emoji;
        if (item.expiry) invRow.expiry = item.expiry;
        await sbPost('inventory', invRow);
        // Log initial quantity
        if (initialQty && initialQty !== 0) {
          await sbPost('inventory_log', {
            user_id:   userId,
            item_id:   item.id,
            item_name: item.name,
            unit:      item.unit || 'g',
            delta:     Number(initialQty),
            note:      note || 'Khởi tạo',
          }, 'return=representation');
        }
        return res.status(200).json({ ok: true });
      }

      // Log a transaction (+ or -)
      if (type === 'log_transaction') {
        const { item_id, item_name, unit, delta, note } = body;
        if (!item_id || delta === undefined) return res.status(400).json({ error: 'item_id and delta required' });
        const entry = await sbPost('inventory_log', {
          user_id: userId, item_id, item_name, unit: unit || 'g',
          delta: Number(delta), note: note || '',
        }, 'return=representation');
        return res.status(200).json({ ok: true, entry: Array.isArray(entry) ? entry[0] : entry });
      }

      // Update inventory master (name, unit, emoji, etc.) — NOT qty
      if (type === 'update_inventory_item') {
        const { id, ...fields } = body.item || {};
        if (!id) return res.status(400).json({ error: 'item.id required' });
        delete fields.qty; // never store qty in master
        await sbPatch('inventory', `?id=eq.${id}&user_id=eq.${userId}`, fields);
        return res.status(200).json({ ok: true });
      }

      // Delete inventory item + all its logs
      if (type === 'delete_inventory_item') {
        const { item_id } = body;
        if (!item_id) return res.status(400).json({ error: 'item_id required' });
        await sbDelete('inventory_log', `?item_id=eq.${item_id}&user_id=eq.${userId}`);
        await sbDelete('inventory', `?id=eq.${item_id}&user_id=eq.${userId}`);
        return res.status(200).json({ ok: true });
      }

      // Create shopping trip
      if (type === 'create_trip') {
        const { trip } = body;
        if (!trip?.id) return res.status(400).json({ error: 'trip required' });
        const saved = await sbPost('shopping_trips', { ...trip, user_id: userId });
        return res.status(200).json({ ok: true, trip: Array.isArray(saved) ? saved[0] : saved });
      }

      // Add item to trip
      if (type === 'add_trip_item') {
        const { item } = body;
        if (!item?.id || !item?.trip_id) return res.status(400).json({ error: 'item required' });
        const saved = await sbPost('shopping_items', { ...item, user_id: userId });
        return res.status(200).json({ ok: true, item: Array.isArray(saved) ? saved[0] : saved });
      }

      // Mark item as bought → auto-log to inventory
      if (type === 'mark_bought') {
        const { item_id, trip_item } = body;
        if (!item_id) return res.status(400).json({ error: 'item_id required' });
        // Mark bought in shopping_items
        await sbPatch('shopping_items',
          `?id=eq.${item_id}&user_id=eq.${userId}`,
          { bought: true, bought_at: new Date().toISOString() }
        );
        // Auto-log to inventory_log if linked to inventory item
        if (trip_item?.inventory_item_id) {
          await sbPost('inventory_log', {
            user_id:   userId,
            item_id:   trip_item.inventory_item_id,
            item_name: trip_item.name,
            unit:      trip_item.unit || 'g',
            delta:     Number(trip_item.qty),
            note:      `Mua ${trip_item.qty}${trip_item.unit} — ${trip_item.trip_note || ''}`.trim(),
          }, 'return=representation');
        }
        return res.status(200).json({ ok: true });
      }

      // Update trip status
      if (type === 'update_trip') {
        const { trip_id, ...fields } = body;
        if (!trip_id) return res.status(400).json({ error: 'trip_id required' });
        await sbPatch('shopping_trips', `?id=eq.${trip_id}&user_id=eq.${userId}`, fields);
        return res.status(200).json({ ok: true });
      }

      // Delete trip (cascades to items)
      if (type === 'delete_trip') {
        const { trip_id } = body;
        if (!trip_id) return res.status(400).json({ error: 'trip_id required' });
        await sbDelete('shopping_trips', `?id=eq.${trip_id}&user_id=eq.${userId}`);
        return res.status(200).json({ ok: true });
      }

      // Delete shopping item
      if (type === 'delete_trip_item') {
        const { item_id } = body;
        if (!item_id) return res.status(400).json({ error: 'item_id required' });
        await sbDelete('shopping_items', `?id=eq.${item_id}&user_id=eq.${userId}`);
        return res.status(200).json({ ok: true });
      }

      // Bulk update sort_order — single upsert call instead of N patches
      if (type === 'update_sort_order') {
        const { items } = body;
        if (!Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ error: 'items[] required' });
        }
        const rows = items.map(({ id, sort_order }) => ({ id, user_id: userId, sort_order }));
        await sbPost('inventory', rows, 'resolution=merge-duplicates');
        return res.status(200).json({ ok: true, updated: items.length });
      }

      return res.status(400).json({ error: 'unknown type: ' + type });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[ledger]', type, err.message);
    return res.status(500).json({ error: err.message });
  }
};
