// Cloudflare Worker: stores push subscriptions in D1 and sends a Web Push
// to each one when its reminder time arrives (cron runs every minute).

const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const SEND_WINDOW_MINUTES = 15; // keep retrying this long if a send fails or cron is late

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function bytesToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToB64u(str) {
  return bytesToB64u(new TextEncoder().encode(str));
}

async function vapidAuthHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = strToB64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = strToB64u(
    JSON.stringify({
      aud,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    })
  );
  const key = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `vapid t=${header}.${payload}.${bytesToB64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Empty-body push: the service worker builds the notification text itself.
async function sendPush(endpoint, env) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(endpoint, env),
      TTL: '3600',
      Urgency: 'high',
    },
  });
}

function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
    day: DAY_MAP[p.weekday],
  };
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function runReminders(env) {
  const { results } = await env.DB.prepare('SELECT * FROM subscriptions').all();
  const now = new Date();

  await Promise.allSettled(
    results.map(async (row) => {
      let days, local;
      try {
        days = JSON.parse(row.days);
        local = localParts(now, row.tz);
      } catch {
        return;
      }
      if (!days.includes(String(local.day))) return;
      if (row.last_sent_date === local.date) return;

      const [h, m] = row.time.split(':').map(Number);
      const diff = local.minutes - (h * 60 + m);
      if (diff < 0 || diff >= SEND_WINDOW_MINUTES) return;

      const res = await sendPush(row.endpoint, env);
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(row.endpoint).run();
      } else if (res.ok) {
        await env.DB.prepare('UPDATE subscriptions SET last_sent_date = ? WHERE endpoint = ?')
          .bind(local.date, row.endpoint)
          .run();
      } else {
        console.error('Push failed', res.status, await res.text().catch(() => ''));
      }
    })
  );
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 8192) throw new Error('Body too large');
  return JSON.parse(text);
}

async function handleApi(request, env, url) {
  if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
    return json({ key: env.VAPID_PUBLIC_KEY });
  }

  if (url.pathname === '/api/subscribe' && request.method === 'POST') {
    let body;
    try {
      body = await readJson(request);
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const sub = body.subscription;
    const cfg = body.config || {};
    const tz = body.tz;

    if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) {
      return json({ error: 'Invalid subscription' }, 400);
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.time || '')) return json({ error: 'Invalid time' }, 400);
    if (!Array.isArray(cfg.days) || !cfg.days.every((d) => /^[0-6]$/.test(String(d)))) {
      return json({ error: 'Invalid days' }, 400);
    }
    if (typeof tz !== 'string' || !validTimeZone(tz)) return json({ error: 'Invalid time zone' }, 400);
    const dosage = String(parseInt(cfg.dosage, 10) || 5);

    // Upsert; if the time/days change, allow a fresh send today.
    await env.DB.prepare(
      `INSERT INTO subscriptions (endpoint, p256dh, auth, time, days, dosage, tz, last_sent_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         last_sent_date = CASE WHEN subscriptions.time != excluded.time OR subscriptions.days != excluded.days
                               OR subscriptions.tz != excluded.tz THEN NULL ELSE subscriptions.last_sent_date END,
         time = excluded.time,
         days = excluded.days,
         dosage = excluded.dosage,
         tz = excluded.tz`
    )
      .bind(
        sub.endpoint,
        sub.keys?.p256dh || null,
        sub.keys?.auth || null,
        cfg.time,
        JSON.stringify(cfg.days.map(String)),
        dosage,
        tz,
        Date.now()
      )
      .run();
    return json({ ok: true });
  }

  if (url.pathname === '/api/test' && request.method === 'POST') {
    let body;
    try {
      body = await readJson(request);
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const row = await env.DB.prepare('SELECT endpoint FROM subscriptions WHERE endpoint = ?')
      .bind(body.endpoint || '')
      .first();
    if (!row) return json({ error: 'Not subscribed' }, 404);
    let res;
    try {
      res = await sendPush(row.endpoint, env);
    } catch (err) {
      return json({ ok: false, error: 'Could not sign or send: ' + err.message }, 500);
    }
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    return json({ ok: res.ok, status: res.status, detail }, res.ok ? 200 : 502);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: 'Server error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
