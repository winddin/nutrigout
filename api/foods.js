// /api/foods.js — Vercel Serverless Function
// GET  /api/foods?q=keyword  → search foods from DB
// POST /api/foods             → save new AI-generated food to DB

const ALLOWED_ORIGINS = [
  'https://nutrigout.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': process.env.SUPABASE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  };
}

function sbUrl(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}

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

  // ── GET: search foods ─────────────────────────────────────────
  if (req.method === 'GET') {
    const q = (req.query?.q || '').trim();
    if (!q) {
      // Return all foods (for ranking tab)
      const res2 = await fetch(
        sbUrl('foods?order=name.asc&limit=500'),
        { headers: sbHeaders() }
      );
      const data = await res2.json();
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // Search by name (case-insensitive, Vietnamese-friendly)
    const encoded = encodeURIComponent(q);
    const res2 = await fetch(
      sbUrl(`foods?name=ilike.*${encoded}*&order=name.asc&limit=20`),
      { headers: sbHeaders() }
    );
    if (!res2.ok) {
      return res.status(502).json({ error: 'DB search failed' });
    }
    const data = await res2.json();
    return res.status(200).json(Array.isArray(data) ? data : []);
  }

  // ── POST: save AI-generated food ──────────────────────────────
  if (req.method === 'POST') {
    const food = req.body;
    if (!food || !food.name) {
      return res.status(400).json({ error: 'food.name required' });
    }

    // Map AI result fields → DB columns
    const row = {
      name:        food.name,
      unit:        food.unit        || '100g',
      kcal:        Number(food.kcal)        || 0,
      protein:     Number(food.protein)     || 0,
      carb:        Number(food.carb)        || 0,
      fat:         Number(food.fat)         || 0,
      purin:       Number(food.purin)       || 0,
      purin_level: food.purinLevel          || 'low',
      cat:         Number(food.cat)         || 1,
      category:    food.category            || 'other',
      tip:         food.tip                 || '',
      source:      'ai',
    };

    try {
      const r = await fetch(sbUrl('foods'), {
        method: 'POST',
        headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      if (!r.ok) {
        const err = await r.text();
        // Conflict (already exists) is OK — not an error
        if (r.status === 409 || err.includes('duplicate')) {
          return res.status(200).json({ ok: true, saved: false, reason: 'already_exists' });
        }
        console.error('Insert food error:', r.status, err);
        return res.status(502).json({ error: 'DB insert failed' });
      }
      const saved = await r.json();
      return res.status(200).json({ ok: true, saved: true, food: Array.isArray(saved) ? saved[0] : saved });
    } catch (err) {
      console.error('POST foods error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
