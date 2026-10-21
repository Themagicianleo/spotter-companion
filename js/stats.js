// stats.js
// Counting for the Stats panel. Pure functions (no page access), so they can be tested with Node.

// Count items by key and return the biggest n: [{ key, count }], plus { key: 'Other', count } for the rest.
// Items whose key is null/empty are skipped (they're reported separately as "unknown").
export function topCounts(items, keyFn, n = 8) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined || key === '') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const top = sorted.slice(0, n).map(([key, count]) => ({ key, count }));
  const rest = sorted.slice(n).reduce((sum, [, count]) => sum + count, 0);
  if (rest) top.push({ key: 'Other', count: rest, other: true });
  return top;
}

// Airline ICAO code from a callsign ("SIA321" -> "SIA"); registrations used as callsigns don't count.
export const airlineCode = (callsign) => /^([A-Z]{3})\d/.exec(callsign ?? '')?.[1] ?? null;

// Everything seen since the page was opened: hex -> { type, airline, firstSeen, lastSeen }.
export class SessionTally {
  constructor(now = Date.now()) {
    this.started = now;
    this.aircraft = new Map();
  }

  add(list, now = Date.now()) {
    for (const ac of list) {
      if (!ac.hex) continue;
      const seen = this.aircraft.get(ac.hex) ?? { type: null, airline: null, firstSeen: now, lastSeen: now };
      seen.type = ac.typeCode ?? seen.type;
      seen.airline = airlineCode(ac.callsign) ?? seen.airline;
      seen.lastSeen = now;
      this.aircraft.set(ac.hex, seen);
    }
  }

  get list() {
    return [...this.aircraft.values()];
  }
}

// Fill in empty hours so a chart shows gaps as zero: [{ hour, aircraft }] from `from` to `to` (unix s).
export function fillHours(perHour, from, to) {
  const byHour = new Map(perHour.map((p) => [p.hour, p.aircraft]));
  const out = [];
  for (let hour = Math.floor(from / 3600) * 3600; hour <= to; hour += 3600) out.push({ hour, aircraft: byHour.get(hour) ?? 0 });
  return out;
}
