// seatmap.js
// Links to seat maps on aeroLOPA (aerolopa.com), a site of to-scale cabin layouts. It has no open data
// or API, so we only build links to its own pages; nothing is fetched and no images are copied.
//
// Two kinds of page, as seen on the site:
//   - an airline's fleet page, with a seat map for each aircraft it flies:  /sq  (IATA code, lower case)
//   - an aircraft type page, with the seat maps of every airline:           /aircraft/airbus-a350-900
// An airline fleet page is the more useful of the two, because layouts differ a lot between airlines,
// so it is preferred when the airline is known. The exact per-layout pages (e.g. /sq-359-m) carry a
// layout letter we can't know, so we never guess those.

const BASE = 'https://www.aerolopa.com';

// "Airbus A350-900" -> "airbus-a350-900". Notes in brackets and alternative models after a "/" are
// dropped ("Boeing 777-200 / -200ER" -> "boeing-777-200"). Returns null when nothing usable is left.
export function aerolopaTypeSlug(type) {
  if (!type?.manufacturer || !type?.model) return null;
  const model = String(type.model).replace(/\(.*?\)/g, '').split('/')[0];
  // The model already starts with the maker ("Airbus A350-900"); only add it when it doesn't.
  const full = model.trim().toLowerCase().startsWith(type.manufacturer.toLowerCase()) ? model : `${type.manufacturer} ${model}`;
  const slug = full
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.includes('-') ? slug : null;
}

export function aerolopaTypeUrl(type) {
  const slug = aerolopaTypeSlug(type);
  return slug ? `${BASE}/aircraft/${slug}` : null;
}

// Only a two-character IATA code (letters or digits) makes a URL, so nothing odd ends up in it.
export function aerolopaAirlineUrl(iata) {
  const code = String(iata ?? '').trim().toLowerCase();
  return /^[a-z0-9]{2}$/.test(code) ? `${BASE}/${code}` : null;
}

// The best single link for a flight card: the airline's fleet page, else the type page.
export function aerolopaUrl({ airlineIata, type } = {}) {
  return aerolopaAirlineUrl(airlineIata) ?? aerolopaTypeUrl(type);
}
