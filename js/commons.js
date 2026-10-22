// commons.js
// More photos of an aircraft from Wikimedia Commons (free-licence photos uploaded by volunteers).
//
// Why Commons: Planespotters' free API returns ONE photo per aircraft (checked 22 Oct 2026: 1 photo
// for each of 11 aircraft, even an Emirates A380 with hundreds on its site), and Flightradar24's
// galleries come from JetPhotos, which has no public API. Commons allows web pages to call its API
// (Access-Control-Allow-Origin: *) and every photo carries its own licence and author.
//
// How we find photos (2 small requests, one after the other, cached per registration):
//   1. the airframe's category, "Category:<registration> (aircraft)", curated by Commons volunteers;
//   2. a file search for the registration, keeping only files whose TITLE contains it (registrations
//      get reused, so a search alone also finds older aircraft that had the same one). Both are needed:
//      on 22 Oct 2026 the A6-EOW category missed its newest photo (Oct 2025), which the search found.
// The two lists are merged (no duplicates) and sorted NEWEST FIRST by the date the photo was taken;
// photos without a readable date go last.
// Fields used, all seen in real responses (22 Oct 2026): title, imageinfo[0].thumburl / thumbwidth /
// thumbheight / descriptionurl / mime, extmetadata.Artist / LicenseShortName / LicenseUrl /
// DateTimeOriginal (seen as "2025-10-26 17:47:23", "2017-10-24" and "Taken on 1 August 2024").
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

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// When the photo was taken, from Commons' DateTimeOriginal text. Returns { ms, precision } or null.
// precision is 'day', 'month' or 'year', so the page never shows more detail than it has.
export function parseTaken(raw) {
  const text = plainText(raw);
  if (!text) return null;
  let m = /\b(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(text); // 2025-10-26 17:47 / 2017-10-24 / 2018-06
  if (m) return { ms: Date.UTC(+m[1], +m[2] - 1, +(m[3] ?? 1)), precision: m[3] ? 'day' : 'month' };
  m = /\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/.exec(text); // "Taken on 1 August 2024"
  if (m && MONTHS.includes(m[2].toLowerCase())) return { ms: Date.UTC(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1]), precision: 'day' };
  m = /\b([A-Za-z]+)\s+(\d{4})\b/.exec(text); // "August 2024"
  if (m && MONTHS.includes(m[1].toLowerCase())) return { ms: Date.UTC(+m[2], MONTHS.indexOf(m[1].toLowerCase()), 1), precision: 'month' };
  m = /\b(19[5-9]\d|20\d{2})\b/.exec(text); // just a year
  if (m) return { ms: Date.UTC(+m[1], 0, 1), precision: 'year' };
  return null;
}

// Newest first; photos without a date keep their order at the end.
export function newestFirst(photos) {
  return photos
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.taken?.ms ?? -Infinity) - (a.p.taken?.ms ?? -Infinity) || a.i - b.i)
    .map((x) => x.p);
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
        taken: parseTaken(md.DateTimeOriginal?.value),
      };
    })
    .filter((ph) => isHttps(ph.src) && isHttps(ph.pageUrl) && ph.license && /^image\/(jpeg|png|webp)$/.test(ph.mime))
    .filter((ph) => !titleMustContain || ph.title.toUpperCase().includes(reg));
}

async function query(params) {
  const url = `${API}?${new URLSearchParams({ action: 'query', format: 'json', origin: '*', prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime', iiurlwidth: '960', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|DateTimeOriginal', ...params })}`;
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
  // 1. The airframe's own category (up to 50 files, so the newest aren't cut off before sorting).
  const cat = parseCommons(await query({ generator: 'categorymembers', gcmtitle: `Category:${reg} (aircraft)`, gcmtype: 'file', gcmlimit: '50' }), reg);
  // 2. A file search, keeping only files with the registration in their title.
  const found = parseCommons(await query({ generator: 'search', gsrsearch: `"${reg}"`, gsrnamespace: '6', gsrlimit: '20' }), reg, { titleMustContain: true });
  // Merge without duplicates, then newest first.
  const seen = new Set();
  const all = [...cat, ...found].filter((p) => !seen.has(p.title) && seen.add(p.title));
  return newestFirst(all).slice(0, MAX);
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
