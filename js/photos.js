// photos.js
// Aircraft photos from Planespotters.net's public photo API.
//
// Response shape (confirmed from two open-source projects' parsers and test fixtures, since
// the build environment couldn't reach planespotters.net itself):
//   { "photos": [ { "id", "thumbnail": {"src", "size"}, "thumbnail_large": {"src", "size"},
//                   "link": <photo page URL>, "photographer": <name> } ] }
//
// Planespotters' terms: photos stay the photographer's property. We must show the
// photographer's credit ("© name") and link the image to its page on planespotters.net. We
// hotlink their image URL unchanged and never copy or re-host the picture.

import { CONFIG } from './config.js';

const cache = new Map(); // hex -> Promise<photo | null>  (memory only, for this visit)

// Only accept https URLs on planespotters' own domains, so a bad response can't point us elsewhere.
const isSafe = (url, hosts) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
};

// Pick the first usable photo. Returns { src, pageUrl, photographer } or null.
export function parsePhotos(data) {
  if (!data || !Array.isArray(data.photos)) throw new Error('Unexpected photo response format');
  for (const p of data.photos) {
    const src = p?.thumbnail_large?.src ?? p?.thumbnail?.src;
    if (!isSafe(src, ['plnspttrs.net', 'planespotters.net']) || !isSafe(p.link, ['planespotters.net'])) continue;
    return {
      src,
      pageUrl: p.link,
      photographer: typeof p.photographer === 'string' && p.photographer.trim() ? p.photographer.trim() : null,
    };
  }
  return null;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchPhoto(hex) {
  const url = `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex)}`;
  try {
    return parsePhotos(await getJson(url)); // 1) ask Planespotters directly
  } catch (directError) {
    if (!CONFIG.proxyBase) throw directError;
    // 2) Blocked (CORS) or refused? Try once through our relay, which sends a User-Agent with contact info.
    return parsePhotos(await getJson(CONFIG.proxyBase + encodeURIComponent(url)));
  }
}

// Get the photo for one aircraft. Each hex is looked up at most once per visit.
export function getPhoto(hex) {
  if (!hex || hex.startsWith('~')) return Promise.resolve(null); // non-ICAO address: no photos
  const key = hex.toLowerCase();
  if (!cache.has(key)) {
    const lookup = fetchPhoto(key);
    lookup.catch(() => cache.delete(key)); // failed lookups can be retried on the next click
    cache.set(key, lookup);
  }
  return cache.get(key);
}
