// Verifying a Supabase access token at the edge, with no dependency.
//
// The project signs with ES256 and publishes the public half at
// /auth/v1/.well-known/jwks.json, so a Worker can check a token without ever
// holding a secret. That is the whole reason this design is safe to run
// outside Supabase: the Worker can prove WHO somebody is, and cannot mint a
// token for anybody.
//
// `jose` would do this in three lines. It is not used because this is the only
// cryptography in the Worker, WebCrypto already ships in the runtime, and a
// dependency-free Worker has no supply chain and no bundle step to get wrong.

const b64urlToBytes = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

// One fetch per isolate, not per connection. Workers KV is deliberately not
// used: its free tier allows 1,000 writes a day, and an isolate-global costs
// nothing. A cold isolate pays one request; every socket after that is free.
//
// Keyed by `kid`, so a key rotation does not serve stale keys forever - an
// unknown kid forces exactly one refetch.
let jwksCache = null;
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function getKey(jwksUrl, kid) {
  const fresh = jwksCache && Date.now() - jwksFetchedAt < JWKS_TTL_MS;
  if (fresh && jwksCache.has(kid)) return jwksCache.get(kid);

  const res = await fetch(jwksUrl, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!res.ok) throw new Error('jwks_unavailable');
  const { keys } = await res.json();

  const next = new Map();
  for (const jwk of keys || []) {
    if (jwk.kty !== 'EC' || jwk.alg !== 'ES256') continue;
    next.set(jwk.kid, await crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    ));
  }
  jwksCache = next;
  jwksFetchedAt = Date.now();
  if (!next.has(kid)) throw new Error('unknown_kid');
  return next.get(kid);
}

// Returns the claims, or throws. Never returns a partially-checked token:
// every caller treats a return value as fully authenticated.
export async function verifySupabaseJwt(token, { jwksUrl, issuer }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const [h, p, s] = parts;

  const header = b64urlToJson(h);
  if (header.alg !== 'ES256') throw new Error('bad_alg');   // never trust alg:none
  if (!header.kid) throw new Error('no_kid');

  const key = await getKey(jwksUrl, header.kid);
  // A JWS ES256 signature is raw r||s, which is exactly what WebCrypto's
  // ECDSA verify expects. No DER unwrapping needed.
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error('bad_signature');

  const claims = b64urlToJson(p);
  const now = Math.floor(Date.now() / 1000);
  // 60s of skew, the usual allowance. exp is the one that matters: a token
  // that has expired must not be able to open or hold a socket.
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('expired');
  if (claims.nbf && claims.nbf > now + 60) throw new Error('not_yet_valid');
  if (issuer && claims.iss && claims.iss !== issuer) throw new Error('bad_issuer');
  if (!claims.sub) throw new Error('no_subject');
  return claims;
}
