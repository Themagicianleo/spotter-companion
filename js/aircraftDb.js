// aircraftDb.js
// Looks up one aircraft (by hex code) in the small database built by
// scripts/build_aircraft_db.py, and the type table in data/aircraft_types.json.
//
// Caching: each file is downloaded at most once per page visit. We store the *promise* of the
// download, so if you click two planes quickly the second click reuses the first download
// instead of starting another one.

const shardCache = new Map(); // '7' -> Promise<{fields, aircraft}>
let typeTablePromise = null;
let metaPromise = null;

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status})`);
  return response.json();
}

// Returns { registration, typeCode, typeDescription, yearBuilt, operator }, or null if the
// aircraft isn't in our database. (Only Boeing/Airbus airliner types are in it.)
export async function lookupAircraft(hex) {
  if (!hex || hex.startsWith('~')) return null; // "~" = non-ICAO address, never in the database
  const key = hex.toLowerCase();
  const first = key[0];
  if (!shardCache.has(first)) {
    const download = getJson(`data/aircraft_db/${first}.json`);
    // If the download fails, forget it so the next click can try again.
    download.catch(() => shardCache.delete(first));
    shardCache.set(first, download);
  }
  const shard = await shardCache.get(first);
  const row = shard.aircraft[key];
  if (!row) return null;
  // Turn the compact list back into named fields, using the field order stored in the file.
  return Object.fromEntries(shard.fields.map((name, i) => [name, row[i]]));
}

// Information about where the database came from (shown in the panel).
export function getDbMeta() {
  metaPromise ??= getJson('data/aircraft_db/meta.json').catch((err) => {
    metaPromise = null;
    throw err;
  });
  return metaPromise;
}

// Returns the type table row for an ICAO type code (e.g. "A359"), or null.
export async function lookupType(typeCode) {
  if (!typeCode) return null;
  typeTablePromise ??= getJson('data/aircraft_types.json')
    .then((doc) => new Map(doc.types.map((t) => [t.icao, t])))
    .catch((err) => {
      typeTablePromise = null; // allow a retry next time
      throw err;
    });
  return (await typeTablePromise).get(typeCode) ?? null;
}


// ---- Exact model -> certified engines (data/aircraft_variants.json, built from official TCDS) ----

let variantsPromise = null;

// OpenSky writes the same model many ways: "Airbus A320-251N", "A320 251NSL", "AIRBUS A320-214".
// Turn it into the certificate's form ("A320-251N"). Returns null if it doesn't look like an
// Airbus model designation (Boeing customer codes such as "737-824" don't identify the engine).
export function normalizeModel(raw) {
  if (!raw) return null;
  let s = raw.toUpperCase().replace(/\(.*?\)/g, '').replace(/AIRBUS/g, '').trim(); // drop notes like "(P2F)"
  s = s.replace(/\s+/g, '-').replace(/-+/g, '-');
  s = s.replace(/SL$/, ''); // OpenSky's "SL" suffix (not part of the certified model name)
  if (/^BD-500-1A1\d$/.test(s)) return s; // A220
  return /^A3\d\d-\d{3,4}[A-Z]{0,2}$/.test(s) ? s : null;
}

// Returns { variant, matchedFrom } or null.
// Tries the exact model first, then without one trailing E/X/F letter (e.g. OpenSky's
// "A330-343E" -> certified model "A330-343"), and says when it did that.
export async function lookupVariant(rawModel) {
  const model = normalizeModel(rawModel);
  if (!model) return null;
  variantsPromise ??= getJson('data/aircraft_variants.json')
    .then((doc) => new Map(doc.variants.map((v) => [v.model, v])))
    .catch((err) => {
      variantsPromise = null;
      throw err;
    });
  const table = await variantsPromise;
  if (table.has(model)) return { variant: table.get(model), matchedFrom: null };
  const base = model.replace(/(\d)[EXF]$/, '$1');
  if (base !== model && table.has(base)) return { variant: table.get(base), matchedFrom: model };
  return null;
}
