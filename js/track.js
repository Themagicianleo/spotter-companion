// track.js
// Remembers where each aircraft has been while this page is open, so the map can draw its
// track. No extra requests: we just keep the positions from each regular update.
// (adsb.lol's API has no documented track/history endpoint, so this is a "since you opened
// the page" track, not the whole flight.)

const MAX_POINTS = 720; // 2 hours at one point per 10 s
const FORGET_AFTER_MS = 15 * 60 * 1000; // drop aircraft we haven't seen for 15 minutes

const tracks = new Map(); // hex -> { points: [{lat, lon, alt, time}], lastSeen }

// Call after every successful update with the full (unfiltered) aircraft list.
export function recordPositions(aircraft, time = Date.now()) {
  for (const ac of aircraft) {
    if (!ac.hex || ac.lat === null || ac.lon === null) continue;
    let track = tracks.get(ac.hex);
    if (!track) {
      track = { points: [], lastSeen: time };
      tracks.set(ac.hex, track);
    }
    track.lastSeen = time;
    const last = track.points.at(-1);
    // Only add a point if the aircraft actually moved (the feed may repeat an old position).
    if (last && last.lat === ac.lat && last.lon === ac.lon) continue;
    track.points.push({ lat: ac.lat, lon: ac.lon, alt: ac.onGround ? 0 : ac.altitudeFt, time });
    if (track.points.length > MAX_POINTS) track.points.shift();
  }
  for (const [hex, track] of tracks) {
    if (time - track.lastSeen > FORGET_AFTER_MS) tracks.delete(hex);
  }
}

// The remembered points for one aircraft, oldest first (empty if none).
export function getTrack(hex) {
  return tracks.get(hex)?.points ?? [];
}
