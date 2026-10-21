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

// Age in whole years from a year-built string like "2019". Returns null if unusable.
export function ageFromYear(yearBuilt, now = new Date()) {
  const year = Number(yearBuilt);
  if (!Number.isInteger(year) || year < 1900 || year > now.getFullYear()) return null;
  return now.getFullYear() - year;
}
