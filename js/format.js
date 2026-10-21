// format.js
// Turns raw values into text for the page. Every missing value becomes "Unknown",
// so we never show a blank, a guess, or "undefined".

export const UNKNOWN = 'Unknown';

const isMissing = (v) => v === null || v === undefined || v === '';

export function text(value) {
  return isMissing(value) ? UNKNOWN : String(value);
}

export function altitude(ac) {
  if (ac.onGround) return 'On ground';
  return isMissing(ac.altitudeFt) ? UNKNOWN : `${ac.altitudeFt.toLocaleString('en')} ft`;
}

export function speed(kt) {
  return isMissing(kt) ? UNKNOWN : `${Math.round(kt)} kt`;
}

// Positive = climbing, negative = descending.
export function verticalRate(fpm) {
  if (isMissing(fpm)) return UNKNOWN;
  const arrow = fpm > 100 ? '↑ ' : fpm < -100 ? '↓ ' : '';
  return `${arrow}${Math.round(fpm).toLocaleString('en')} ft/min`;
}

export function distance(nm) {
  return isMissing(nm) ? UNKNOWN : `${nm.toFixed(1)} nm`;
}
