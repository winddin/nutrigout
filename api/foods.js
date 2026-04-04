// /api/foods.js — Vercel Serverless Function
// GET  /api/foods?q=keyword  → search foods from Supabase
// POST /api/foods             → save AI-generated food to Supabase

const ALLOWED_ORIGINS = [
  'https://nutrigout.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const SB_URL = () => process.env.SUPABASE_URL;
const SB_KEY = () => process.env.SUPABASE_KEY;

function sbH() {
  return {
    'Content-Type': 'application/json',
    'apikey': SB_KEY(),
    'Authorization': `Bearer ${SB_KEY()}`,
    'Prefer': 'return=representation',
  };
}

function sbUrl(path) {
  return `${SB_URL()}/rest/v1/${path}`;
}

function setCORS(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_URL() || !SB_KEY()) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    // ── GET: search or load all foods ─────────────────────────────
    if (req.method === 'GET') {
      const q = (req.query?.q || '').trim();
      const qs = q
        ? `foods?name=ilike.*${encodeURIComponent(q)}*&order=name.asc&limit=20`
        : 'foods?order=name.asc&limit=500';
      const r = await fetch(sbUrl(qs), { headers: sbH() });
      if (!r.ok) return res.status(r.status).json({ error: 'DB error: ' + r.status });
      const data = await r.json();
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // ── POST: save AI-generated food ──────────────────────────────
    if (req.method === 'POST') {
      const food = req.body;
      if (!food?.name) return res.status(400).json({ error: 'food.name required' });
      const row = {
        name:        food.name,
        unit:        food.unit        || '100g',
        kcal:        Number(food.kcal)    || 0,
        protein:     Number(food.protein) || 0,
        carb:        Number(food.carb)    || 0,
        fat:         Number(food.fat)     || 0,
        purin:       Number(food.purin)   || 0,
        purin_level: food.purinLevel      || 'low',
        cat:         Number(food.cat)     || 1,
        category:    food.category        || 'other',
        tip:         food.tip             || '',
        source:      'ai',
      };
      const r = await fetch(sbUrl('foods'), {
        method: 'POST',
        headers: { ...sbH(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      if (!r.ok) {
        const err = await r.text();
        if (r.status === 409 || err.includes('duplicate')) {
          return res.status(200).json({ ok: true, saved: false, reason: 'already_exists' });
        }
        return res.status(502).json({ error: 'DB insert failed' });
      }
      const saved = await r.json();
      return res.status(200).json({ ok: true, saved: true, food: Array.isArray(saved) ? saved[0] : saved });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[foods]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
