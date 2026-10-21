// filters.js
// Pure functions (no page code), so they are easy to test. Takes the full aircraft list
// and the filter settings, and returns only the aircraft that match ALL active filters.

// Read the raw text typed in the filter boxes and turn it into clean values.
//   types:  "a359, b77w"  -> ['A359', 'B77W']
//   minAlt / maxAlt: "" -> null (meaning "no limit")
//   prefix: " sia " -> 'SIA'
export function parseFilterInputs({ types = '', minAlt = '', maxAlt = '', prefix = '', includeGround = true, search = '' }) {
  const toNumberOrNull = (s) => (String(s).trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
  return {
    types: types.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean),
    minAlt: toNumberOrNull(minAlt),
    maxAlt: toNumberOrNull(maxAlt),
    prefix: prefix.trim().toUpperCase(),
    includeGround,
    search: search.trim().toUpperCase(),
  };
}

export function applyFilters(aircraft, f) {
  return aircraft.filter((ac) => {
    // Type: aircraft with an unknown type are hidden while a type filter is active.
    if (f.types.length && !f.types.includes(ac.typeCode)) return false;

    // On-ground aircraft count as altitude 0 for the range filter.
    if (ac.onGround && !f.includeGround) return false;
    const alt = ac.onGround ? 0 : ac.altitudeFt;
    if (f.minAlt !== null || f.maxAlt !== null) {
      if (alt === null) return false; // unknown altitude can't be in a range
      if (f.minAlt !== null && alt < f.minAlt) return false;
      if (f.maxAlt !== null && alt > f.maxAlt) return false;
    }

    // Callsign or airline prefix: "SIA" matches SIA321; "SIA3" matches SIA321 and SIA38.
    if (f.prefix && !(ac.callsign ?? '').toUpperCase().startsWith(f.prefix)) return false;

    // Search box: text anywhere in the callsign, registration, type code or route ("SIN", "A359").
    if (f.search) {
      const haystack = [ac.callsign, ac.registration, ac.typeCode, ac.routeLabel].filter(Boolean).join(' ').toUpperCase();
      if (!haystack.includes(f.search)) return false;
    }

    return true;
  });
}

// Sort by one field. Missing values always go to the bottom, whichever direction.
export function sortAircraft(aircraft, key, direction = 'asc') {
  const sign = direction === 'asc' ? 1 : -1;
  const value = (ac) => (key === 'altitudeFt' && ac.onGround ? 0 : ac[key]);
  return [...aircraft].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb)) * sign;
  });
}
