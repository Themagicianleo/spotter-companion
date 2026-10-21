// track.js
// Remembers where each aircraft has been while this page is open, so the map can draw its
// track. No extra requests: we just keep the positions from each regular update.
// (adsb.lol's API has no documented track/history endpoint, so this is a "since you opened
// the page" track, not the whole flight.)
//
// If the recorder is set up (CONFIG.recorderBase), getTrack() also includes the positions it
// recorded before you opened the page (one per minute, up to CONFIG.recordedTrackMinutes).

import { CONFIG } from './config.js';

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

const recorded = new Map(); // hex -> { fetchedAt, points }  (answers from the recorder)
const RECORDED_CACHE_MS = 60 * 1000; // the recorder only adds a point per minute

// Ask the recorder for this aircraft's earlier positions. Resolves to true if it got any.
// Failures (recorder not set up, offline, localhost) just mean no earlier points.
export async function loadRecordedTrack(hex) {
  if (!CONFIG.recorderBase || !hex || !/^[0-9a-f]{6}$/.test(hex)) return false;
  const cached = recorded.get(hex);
  if (cached && Date.now() - cached.fetchedAt < RECORDED_CACHE_MS) return cached.points.length > 0;
  try {
    const url = `${CONFIG.recorderBase}/track?hex=${hex}&minutes=${CONFIG.recordedTrackMinutes}`;
    const response = await fetch(url);
    if (!response.ok) return false;
    const data = await response.json();
    const points = (Array.isArray(data.points) ? data.points : [])
      .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number' && typeof p.t === 'number')
      .map((p) => ({ lat: p.lat, lon: p.lon, alt: typeof p.alt === 'number' ? p.alt : null, time: p.t * 1000, recorded: true }));
    recorded.set(hex, { fetchedAt: Date.now(), points });
    return points.length > 0;
  } catch {
    return false;
  }
}

// The points for one aircraft, oldest first (empty if none): the recorder's earlier positions,
// followed by the ones this page has seen itself.
const MAX_GAP_MS = 5 * 60 * 1000; // a bigger gap means a different flight (or lost coverage)

export function getTrack(hex) {
  const own = tracks.get(hex)?.points ?? [];
  const earlier = (recorded.get(hex)?.points ?? []).filter((p) => !own.length || p.time < own[0].time);
  // Walk back from the newest point and stop at the first big gap, so an earlier flight of the
  // same aircraft (it may have landed and taken off again) isn't joined onto this one.
  const kept = [];
  let next = own.length ? own[0].time : Infinity;
  for (let i = earlier.length - 1; i >= 0; i--) {
    if (next !== Infinity && next - earlier[i].time > MAX_GAP_MS) break;
    kept.unshift(earlier[i]);
    next = earlier[i].time;
  }
  return [...kept, ...own];
}
