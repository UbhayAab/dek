// Link unfurl: fetch OG tags server-side, cache 1h, replace Google favicon leak.
// Usage: POST { url: "https://example.com" }
// Returns: { title, description, image, url, error? }
// CORS: * so the client can call it from any origin.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

// In-memory cache: url -> { expiry: number, data: any }
// Shared across invocations within the same cold start; persists for the life of the container.
// TTL: 1 hour (3600 seconds).
const cache = new Map();

function isCacheValid(key) {
  const entry = cache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return false;
  }
  return true;
}

async function fetchOgTags(urlStr) {
  const apiUrl = new URL(urlStr);
  // Strip scheme-relative and ensure https
  if (apiUrl.protocol !== 'https:' && apiUrl.protocol !== 'http:') return null;

  try {
    const res = await fetch(urlStr, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Dek/1.0; +https://dek.local)',
        Accept: 'text/html,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });

    if (!res.ok) return null;

    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    if (doc.querySelector('html') === null) return null;

    const getMeta = (prop) => {
      // og:* prefixed
      const og = doc.querySelector(`meta[property="og:${prop}"]`);
      if (og && og.content) return og.content;
      // twitter:* prefixed
      const tw = doc.querySelector(`meta[name="twitter:${prop}"]`);
      if (tw && tw.content) return tw.content;
      // fallback: name=description|title
      if (prop === 'description' || prop === 'title') {
        const fb = doc.querySelector(`meta[name="${prop}"]`);
        if (fb && fb.content) return fb.content;
      }
      return null;
    };

    return {
      title: getMeta('title') || getMeta('site_name') || null,
      description: getMeta('description') || null,
      image: getMeta('image') || null,
      url: apiUrl.href,
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { url } = await req.json().catch(() => ({}));
    if (!url) return json({ error: 'url is required' }, 400);

    // Normalize: ensure we have a valid URL string
    let urlStr = String(url).trim();
    try { new URL(urlStr); } catch { return json({ error: 'invalid url' }, 400); }

    // Check cache first (1h TTL)
    if (isCacheValid(urlStr)) {
      return json(cache.get(urlStr).data);
    }

    const data = await fetchOgTags(urlStr);

    if (!data || !data.title) {
      return json({ error: 'no og tags found' }, 404);
    }

    const entry = { expiry: Date.now() + 3_600_000, data };
    cache.set(urlStr, entry);

    return json(data);
  } catch (e) {
    console.error('[dek-unfurl] unhandled', e);
    return json({ error: 'failed' }, 500);
  }
});