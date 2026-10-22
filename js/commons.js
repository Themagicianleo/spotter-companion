// commons.js
// More photos of an aircraft from Wikimedia Commons (free-licence photos uploaded by volunteers).
//
// Why Commons: Planespotters' free API returns ONE photo per aircraft (checked 22 Oct 2026: 1 photo
// for each of 11 aircraft, even an Emirates A380 with hundreds on its site), and Flightradar24's
// galleries come from JetPhotos, which has no public API. Commons allows web pages to call its API
// (Access-Control-Allow-Origin: *) and every photo carries its own licence and author.
//
// How we find photos (2 small requests at most, one after the other, cached per registration):
//   1. the airframe's category, "Category:<registration> (aircraft)", curated by Commons volunteers;
//   2. otherwise a file search for the registration, keeping only files whose TITLE contains it
//      (registrations get reused, so a search alone also finds older aircraft that had the same one).
// Fields used, all seen in real responses (22 Oct 2026): title, imageinfo[0].thumburl / thumbwidth /
// thumbheight / descriptionurl / mime, extmetadata.Artist / LicenseShortName / LicenseUrl.
// Wikimedia asks browser apps to identify themselves with the Api-User-Agent header.

const API = 'https://commons.wikimedia.org/w/api.php';
const AGENT = 'SkyWatchSG/1.0 (https://github.com/Themagicianleo/spotter-companion; hobby project)';
const MAX = 12;
const cache = new Map(); // registration -> Promise<photo[]>

// "<a href=...>Ian Gratton</a>" -> "Ian Gratton". Artist comes as HTML; we only ever show text.
export function plainText(html) {
  const text = String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

const isHttps = (u) => typeof u === 'string' && u.startsWith('https://');

// Turn the API's pages into photo objects; drop anything without a licence, picture or https links.
export function parseCommons(data, registration, { titleMustContain = false } = {}) {
  const pages = Object.values(data?.query?.pages ?? {});
  const reg = registration.toUpperCase();
  return pages
    .filter((p) => p.ns === 6 && Array.isArray(p.imageinfo) && p.imageinfo[0])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => {
      const ii = p.imageinfo[0];
      const md = ii.extmetadata ?? {};
      return {
        source: 'commons',
        title: String(p.title ?? '').replace(/^File:/, ''),
        src: ii.thumburl,
        width: ii.thumbwidth ?? null,
        height: ii.thumbheight ?? null,
        pageUrl: ii.descriptionurl,
        mime: ii.mime ?? '',
        photographer: plainText(md.Artist?.value),
        license: plainText(md.LicenseShortName?.value),
        licenseUrl: isHttps(md.LicenseUrl?.value) ? md.LicenseUrl.value : null,
      };
    })
    .filter((ph) => isHttps(ph.src) && isHttps(ph.pageUrl) && ph.license && /^image\/(jpeg|png|webp)$/.test(ph.mime))
    .filter((ph) => !titleMustContain || ph.title.toUpperCase().includes(reg));
}

async function query(params) {
  const url = `${API}?${new URLSearchParams({ action: 'query', format: 'json', origin: '*', prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime', iiurlwidth: '960', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl', ...params })}`;
  let r;
  try {
    r = await fetch(url, { headers: { 'Api-User-Agent': AGENT } });
  } catch {
    r = await fetch(url); // if a browser refuses the extra header, ask without it
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function lookup(registration) {
  const reg = registration.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,9}$/.test(reg)) return [];
  // 1. The airframe's own category.
  const cat = parseCommons(await query({ generator: 'categorymembers', gcmtitle: `Category:${reg} (aircraft)`, gcmtype: 'file', gcmlimit: String(MAX) }), reg);
  if (cat.length) return cat.slice(0, MAX);
  // 2. A file search, keeping only files with the registration in their title.
  const found = parseCommons(await query({ generator: 'search', gsrsearch: `"${reg}"`, gsrnamespace: '6', gsrlimit: String(MAX) }), reg, { titleMustContain: true });
  return found.slice(0, MAX);
}

// Photos of the aircraft with this registration (may be empty). Failed lookups aren't kept, so a later card retries.
export function getCommonsPhotos(registration) {
  if (!registration) return Promise.resolve([]);
  const key = registration.trim().toUpperCase();
  if (!cache.has(key)) {
    const p = lookup(key);
    p.catch(() => cache.delete(key)); // let a later card try again
    cache.set(key, p);
  }
  return cache.get(key);
}
