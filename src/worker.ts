// Cloudflare Worker entry point.
//
// Responsibilities:
//   1. Proxy /api/hasheous/* → https://hasheous.org/api/v1/* with CORS.
//   2. Serve /api/igdb/cover/<igdb_game_id> by looking up the IGDB
//      cover for that game ID and 302-redirecting to the actual image
//      URL on images.igdb.com. The Twitch OAuth token is cached
//      in-memory so subsequent requests don't re-auth.
//   3. Everything else falls through to the static assets binding.

export interface Env {
  ASSETS: Fetcher;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
}

const HASHEOUS_BASE = 'https://hasheous.org/api/v1';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/hasheous/')) {
      return proxyHasheous(req, url);
    }
    if (url.pathname.startsWith('/api/igdb/cover/')) {
      return igdbCover(url, env);
    }

    return env.ASSETS.fetch(req);
  },
};

// ---------------------------------------------------------------- Hasheous

async function proxyHasheous(req: Request, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/api\/hasheous/, '');
  const upstreamPath = rest
    .replace(/^\/lookup\/byhash\//i, '/Lookup/ByHash/')
    .replace(/^\/healthcheck/i, '/Healthcheck')
    .replace(/^\/lookup\/platforms/i, '/Lookup/Platforms');
  const upstream = HASHEOUS_BASE + upstreamPath + url.search;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders('GET, OPTIONS') });
  }
  if (req.method !== 'GET') {
    return new Response('method not allowed', { status: 405, headers: corsHeaders('GET, OPTIONS') });
  }

  const upstreamResp = await fetch(upstream, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });

  const headers = new Headers(upstreamResp.headers);
  for (const [k, v] of Object.entries(corsHeaders('GET, OPTIONS'))) headers.set(k, v);
  headers.delete('alt-svc');
  headers.delete('server');
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers,
  });
}

// ---------------------------------------------------------------- IGDB

// Worker-local cache for the Twitch app-access token. Twitch tokens
// last ~60 days; we refresh just before expiry. This cache lives in
// the Worker isolate so a single Worker handles many requests with
// one token, but cold isolates pay one extra Twitch round-trip.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getTwitchToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not configured');
  }
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  const resp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!resp.ok) throw new Error(`Twitch token request failed: ${resp.status}`);
  const json = await resp.json() as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

async function igdbCover(url: URL, env: Env): Promise<Response> {
  const idStr = url.pathname.replace(/^\/api\/igdb\/cover\//, '');
  const igdbId = parseInt(idStr, 10);
  if (!Number.isFinite(igdbId) || igdbId <= 0) {
    return new Response('bad game id', { status: 400, headers: corsHeaders('GET, OPTIONS') });
  }
  let token: string;
  try {
    token = await getTwitchToken(env);
  } catch (e) {
    return new Response((e as Error).message, { status: 500, headers: corsHeaders('GET, OPTIONS') });
  }

  // IGDB's covers endpoint — POST body in their custom Apicalypse DSL.
  // Returns at most one cover (we limit to 1) with the image_id we need.
  const body = `where game = ${igdbId}; fields image_id; limit 1;`;
  const igdbResp = await fetch('https://api.igdb.com/v4/covers', {
    method: 'POST',
    body,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Client-ID': env.TWITCH_CLIENT_ID!,
      'Accept': 'application/json',
      'Content-Type': 'text/plain',
    },
  });
  if (!igdbResp.ok) {
    return new Response('igdb cover lookup failed', {
      status: igdbResp.status,
      headers: corsHeaders('GET, OPTIONS'),
    });
  }
  const covers = await igdbResp.json() as Array<{ image_id?: string }>;
  if (!covers.length || !covers[0].image_id) {
    return new Response('no cover', { status: 404, headers: corsHeaders('GET, OPTIONS') });
  }
  const imageUrl = `https://images.igdb.com/igdb/image/upload/t_cover_big/${covers[0].image_id}.jpg`;
  // Stream the image bytes back through the worker so the browser
  // sees same-origin pixels (no CORS, no referrer leak to igdb.com)
  // and we can edge-cache the image too.
  const imageResp = await fetch(imageUrl, {
    cf: { cacheTtl: 7 * 24 * 3600, cacheEverything: true },
  });
  const headers = new Headers(imageResp.headers);
  for (const [k, v] of Object.entries(corsHeaders('GET, OPTIONS'))) headers.set(k, v);
  headers.set('Cache-Control', 'public, max-age=604800');
  return new Response(imageResp.body, {
    status: imageResp.status,
    statusText: imageResp.statusText,
    headers,
  });
}

// ---------------------------------------------------------------- CORS

function corsHeaders(allowMethods: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}
