// csv.js
// Turns the current list into a CSV file you can open in Excel, Google Sheets or Numbers.

// The columns, in order: [header, how to get the value from an aircraft].
export const CSV_COLUMNS = [
  ['hex', (a) => a.hex],
  ['callsign', (a) => a.callsign],
  ['registration', (a) => a.registration],
  ['type', (a) => a.typeCode],
  ['type_description', (a) => a.typeDescription],
  ['route', (a) => a.routeLabel], // "(?)" = doesn't match where the plane is
  ['altitude_ft', (a) => a.altitudeFt],
  ['on_ground', (a) => a.onGround],
  ['ground_speed_kt', (a) => a.groundSpeedKt],
  ['track_deg', (a) => a.trackDeg],
  ['vertical_rate_fpm', (a) => a.verticalRateFpm],
  ['squawk', (a) => a.squawk],
  ['distance_nm', (a) => a.distanceNm],
  ['lat', (a) => a.lat],
  ['lon', (a) => a.lon],
];

// Make one value safe for a CSV cell.
export function cell(value) {
  if (value === null || value === undefined) return ''; // empty cell = unknown
  let s = String(value);
  // Spreadsheet apps run cells starting with = + - @ as formulas. Text from the internet
  // shouldn't be able to do that, so prefix it with ' (numbers are left alone).
  if (typeof value === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
  // Quote cells containing commas, quotes or line breaks; double any quotes inside.
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// sourceName goes in a last "source" column, so the attribution travels with the data.
export function toCsv(aircraft, sourceName = '') {
  const lines = [[...CSV_COLUMNS.map(([header]) => header), 'source'].join(',')];
  for (const ac of aircraft) lines.push([...CSV_COLUMNS.map(([, get]) => cell(get(ac))), cell(sourceName)].join(','));
  return lines.join('\r\n') + '\r\n';
}

// Ask the browser to save the CSV as a file.
export function downloadCsv(aircraft, sourceName) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([toCsv(aircraft, sourceName)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `aircraft-${stamp}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000); // free the memory afterwards
}
