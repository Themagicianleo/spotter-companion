// flags.js
// Which aircraft the community database marks as military or "interesting".
// Data: data/aircraft_flags.json, built from tar1090-db's flags column by scripts/build_aircraft_db.py.
// The lists are incomplete (many military aircraft aren't in it) and can be wrong.

let flags = null; // { military: Set, interesting: Set, builtAt }
let loading = null;

export function loadFlags() {
  loading ??= fetch('data/aircraft_flags.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((doc) => {
      flags = { military: new Set(doc.military), interesting: new Set(doc.interesting), builtAt: doc.builtAt };
    })
    .catch(() => {
      loading = null; // no flag-based alerts this time; allow a retry later
    });
  return loading;
}

// For tests: use a ready-made set of flags instead of the file.
export function setFlags(military, interesting) {
  flags = { military: new Set(military), interesting: new Set(interesting), builtAt: null };
}

export function flagsFor(hex) {
  if (!flags || !hex) return { military: false, interesting: false };
  return { military: flags.military.has(hex), interesting: flags.interesting.has(hex) };
}
