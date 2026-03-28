// /api/search.js — Vercel Serverless Function
// Proxy to OpenAI API with per-IP rate limiting
// Uses in-memory store (resets per cold start) — good enough for light traffic
// For production, swap with Vercel KV (see comments below)

// ─── CONFIGURATION ────────────────────────────────────────────────
const RATE_LIMIT = {
  perIP: {
    requestsPerHour: 10,    // max 10 AI searches per IP per hour
    requestsPerDay: 30,     // max 30 AI searches per IP per day
  },
  global: {
    requestsPerHour: 100,   // total across all users per hour
    requestsPerDay: 300,    // total across all users per day
  }
};

// Allowed origins — add your Vercel domain after deploy
const ALLOWED_ORIGINS = [
  'https://nutrigout.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  // Add your custom domain here if any, e.g.:
  // 'https://nutrigout.yourdomain.com',
];

// ─── IN-MEMORY RATE LIMIT STORE ───────────────────────────────────
// NOTE: This resets on cold starts. For stricter limits, replace with Vercel KV:
//   import { kv } from '@vercel/kv'
//   const count = await kv.incr(`rl:ip:${ip}:hour`)
//   await kv.expire(`rl:ip:${ip}:hour`, 3600)
const store = new Map();

function getKey(type, window) {
  const slot = window === 'hour'
    ? Math.floor(Date.now() / 3_600_000)
    : Math.floor(Date.now() / 86_400_000);
  return `${type}:${window}:${slot}`;
}

function increment(key) {
  const current = store.get(key) || 0;
  store.set(key, current + 1);
  // Auto-cleanup old keys to prevent memory leak
  if (store.size > 10000) {
    const now = Date.now();
    for (const [k] of store) {
      // Remove keys older than 2 days
      const parts = k.split(':');
      const slot = parseInt(parts[parts.length - 1]);
      const isDaySlot = k.includes(':day:');
      const age = isDaySlot
        ? (Math.floor(now / 86_400_000) - slot)
        : (Math.floor(now / 3_600_000) - slot);
      if (age > 2) store.delete(k);
    }
  }
  return current + 1;
}

function getCount(key) {
  return store.get(key) || 0;
}

function checkRateLimit(ip) {
  const globalHourKey = getKey('global', 'hour');
  const globalDayKey  = getKey('global', 'day');
  const ipHourKey     = getKey(`ip:${ip}`, 'hour');
  const ipDayKey      = getKey(`ip:${ip}`, 'day');

  const globalHour = getCount(globalHourKey);
  const globalDay  = getCount(globalDayKey);
  const ipHour     = getCount(ipHourKey);
  const ipDay      = getCount(ipDayKey);

  if (globalHour >= RATE_LIMIT.global.requestsPerHour) {
    return { allowed: false, reason: 'Hệ thống đang bận, thử lại sau 1 giờ nhé. (Global hourly limit reached)' };
  }
  if (globalDay >= RATE_LIMIT.global.requestsPerDay) {
    return { allowed: false, reason: 'Đã đạt giới hạn hôm nay, thử lại ngày mai. (Global daily limit reached)' };
  }
  if (ipHour >= RATE_LIMIT.perIP.requestsPerHour) {
    return { allowed: false, reason: `Bạn đã tra cứu quá ${RATE_LIMIT.perIP.requestsPerHour} lần trong 1 giờ. Thử lại sau nhé!` };
  }
  if (ipDay >= RATE_LIMIT.perIP.requestsPerDay) {
    return { allowed: false, reason: `Bạn đã tra cứu quá ${RATE_LIMIT.perIP.requestsPerDay} lần hôm nay. Thử lại ngày mai!` };
  }

  // Allowed — increment counters
  increment(globalHourKey);
  increment(globalDayKey);
  increment(ipHourKey);
  increment(ipDayKey);

  return {
    allowed: true,
    remaining: {
      ipHour:    RATE_LIMIT.perIP.requestsPerHour - ipHour - 1,
      ipDay:     RATE_LIMIT.perIP.requestsPerDay  - ipDay  - 1,
      globalHour: RATE_LIMIT.global.requestsPerHour - globalHour - 1,
    }
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';

  // CORS — only allow known origins
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get client IP (Vercel provides x-forwarded-for)
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );

  // Rate limit check
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({
      error: 'rate_limited',
      message: rl.reason,
    });
  }

  // Validate body
  const { foodName } = req.body || {};
  if (!foodName || typeof foodName !== 'string' || foodName.trim().length === 0) {
    return res.status(400).json({ error: 'foodName is required' });
  }
  if (foodName.length > 200) {
    return res.status(400).json({ error: 'foodName too long' });
  }

  // Sanitize — strip potential prompt injections
  const sanitized = foodName.trim().replace(/[`"\\]/g, '');

  const prompt = `Bạn là chuyên gia dinh dưỡng. Cung cấp thông tin dinh dưỡng cho thực phẩm: "${sanitized}".
Trả về CHỈ JSON thuần (không markdown, không giải thích thêm):
{"name":"tên thực phẩm","unit":"khẩu phần tham khảo (vd: 100g tươi)","kcal":số_nguyên,"protein":số,"carb":số,"fat":số,"purin":số_nguyên_mg_per_100g,"purinLevel":"low HOẶC mid HOẶC high","tip":"lời khuyên 1-2 câu tiếng Việt cho người bị gút và thừa cân"}
Quy tắc purinLevel: low nếu purin<100mg, mid nếu 100-200mg, high nếu >200mg.`;

  // Call OpenAI
  try {
    const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',          // rẻ + nhanh, đổi thành 'gpt-4o' nếu muốn chính xác hơn
        max_tokens: 500,
        temperature: 0.2,              // ít "sáng tạo" hơn → JSON ổn định hơn
        response_format: { type: 'json_object' }, // đảm bảo output là JSON thuần
        messages: [
          {
            role: 'system',
            content: 'Bạn là chuyên gia dinh dưỡng. Luôn trả về CHỈ JSON thuần, không markdown, không giải thích.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text();
      console.error('OpenAI error:', openaiResp.status, errText);
      return res.status(502).json({ error: 'AI service error', status: openaiResp.status });
    }

    const data = await openaiResp.json();
    const text = data.choices?.[0]?.message?.content || '';

    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Add rate limit info to response headers
    res.setHeader('X-RateLimit-IP-Hour-Remaining', rl.remaining.ipHour);
    res.setHeader('X-RateLimit-IP-Day-Remaining',  rl.remaining.ipDay);

    return res.status(200).json({ result: parsed });

  } catch (err) {
    console.error('OpenAI handler error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
