// cloudflare-worker.js — OPTIONAL relay for the GitHub Pages version. See proxy/README.md.
//
// Only needed if the provider doesn't send CORS headers (then a browser page can't read its
// answers). It fetches the provider URL and passes the answer back with a CORS header.
// It only relays to ALLOWED_HOSTS, so nobody can use it as a general-purpose proxy.

const ALLOWED_HOSTS = ['api.adsb.lol', 'api.airplanes.live'];

// Set this to your GitHub Pages address so only your site can use the relay.
const ALLOWED_ORIGIN = 'https://themagicianleo.github.io';

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url') ?? '';
    let host = '';
    try {
      host = new URL(target).hostname;
    } catch {
      // not a valid URL; handled below
    }
    if (!target.startsWith('https://') || !ALLOWED_HOSTS.includes(host)) {
      return new Response('Not allowed', { status: 400 });
    }

    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'SpottersCompanion/1.0 (personal non-commercial project)' },
      // Ask Cloudflare to cache answers for 5 s, so many viewers = few provider requests.
      cf: { cacheTtl: 5, cacheEverything: true },
    });

    const headers = new Headers({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    });
    const retryAfter = upstream.headers.get('Retry-After');
    if (retryAfter) headers.set('Retry-After', retryAfter);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
