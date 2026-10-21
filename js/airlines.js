// airlines.js
// Airline name and IATA code from the callsign: "SIA321" -> SIA -> Singapore Airlines (SQ).
// Data: data/airlines.json, built from Virtual Radar Server standing data (CC0) by
// scripts/build_routes.py. (No logos: airline logos are copyrighted trademarks with no open licence.)

let airlines = null; // Map: ICAO code -> { name, iata }, once loaded
let loading = null;

export function loadAirlines() {
  loading ??= fetch('data/airlines.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((doc) => {
      airlines = new Map(Object.entries(doc.airlines).map(([icao, [name, iata]]) => [icao, { icao, name, iata }]));
    })
    .catch(() => {
      loading = null; // no badges this time; allow a retry later
    });
  return loading;
}

// Returns { icao, name, iata } or null. Only airline-style callsigns (3 letters + a digit) count;
// a registration used as a callsign (e.g. "9VSJA") is not an airline.
export function airlineFor(callsign) {
  if (!airlines || !callsign) return null;
  const m = callsign.trim().toUpperCase().match(/^([A-Z]{3})\d/);
  return m ? airlines.get(m[1]) ?? null : null;
}
