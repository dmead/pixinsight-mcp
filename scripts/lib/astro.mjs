// astro.mjs — low-precision solar/lunar ephemerides and horizontal coordinates.
//
// Accuracy: sun ~0.01 deg, moon ~0.3 deg (Meeus, truncated series). That is far
// tighter than the weather term in any observability question, which is what
// actually dominates the answer — do not add terms without a reason.
import fs from 'fs';

export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const sin = (d) => Math.sin(d * D2R), cos = (d) => Math.cos(d * D2R);
export const norm = (d) => ((d % 360) + 360) % 360;

/** Days since J2000.0 for a JS Date (UTC). */
export const jd2000 = (date) => date.getTime() / 86400000 + 2440587.5 - 2451545.0;

export function sunPos(n) {
  const L = norm(280.460 + 0.9856474 * n);
  const g = norm(357.528 + 0.9856003 * n);
  const lam = L + 1.915 * sin(g) + 0.020 * sin(2 * g);
  const eps = 23.439 - 0.0000004 * n;
  return {
    ra: norm(Math.atan2(cos(eps) * sin(lam), cos(lam)) * R2D),
    dec: Math.asin(sin(eps) * sin(lam)) * R2D,
  };
}

export function moonPos(n) {
  const T = n / 36525;
  const Lp = norm(218.316 + 481267.8813 * T);
  const M = norm(357.529 + 35999.0503 * T);
  const Mp = norm(134.963 + 477198.8676 * T);
  const Dm = norm(297.850 + 445267.1115 * T);
  const F = norm(93.272 + 483202.0175 * T);
  const lam = Lp + 6.289 * sin(Mp) - 1.274 * sin(2 * Dm - Mp) + 0.658 * sin(2 * Dm)
    + 0.214 * sin(2 * Mp) - 0.186 * sin(M) - 0.114 * sin(2 * F);
  const bet = 5.128 * sin(F) + 0.281 * sin(Mp + F) - 0.278 * sin(F - Mp) - 0.173 * sin(2 * Dm - F);
  const eps = 23.439 - 0.0000004 * n;
  return {
    ra: norm(Math.atan2(sin(lam) * cos(eps) - Math.tan(bet * D2R) * sin(eps), cos(lam)) * R2D),
    dec: Math.asin(sin(bet) * cos(eps) + cos(bet) * sin(eps) * sin(lam)) * R2D,
  };
}

/** Greenwich mean sidereal time, degrees. */
export const gmst = (n) => norm(280.46061837 + 360.98564736629 * n);

/** Altitude of an equatorial position from a site, degrees. lon is east-positive. */
export function altitude(ra, dec, lat, lon, n) {
  const ha = norm(gmst(n) + lon - ra);
  return Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha)) * R2D;
}

/** Illuminated fraction of the moon's disc, 0..1. */
export function moonIllumination(n) {
  const s = sunPos(n), m = moonPos(n);
  const elong = Math.acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra)) * R2D;
  return (1 - cos(elong)) / 2;
}

/**
 * Target position and site coordinates from a master's FITS keywords, so
 * observability tooling needs no configuration.
 */
export function masterKeywords(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 8) !== 'XISF0100') throw new Error('not monolithic XISF');
    const xml = Buffer.alloc(head.readUInt32LE(8));
    fs.readSync(fd, xml, 0, xml.length, 16);
    const s = xml.toString('utf8');
    const kw = (n) => {
      const m = s.match(new RegExp(`<FITSKeyword name="${n}" value="([^"]*)"`));
      return m ? Number(m[1].replace(/'/g, '').trim()) : null;
    };
    const obj = s.match(/<FITSKeyword name="OBJECT" value="'?([^"']*)/);
    return {
      ra: kw('RA'), dec: kw('DEC'),
      lat: kw('OBSGEO-B') ?? kw('LAT-OBS'),
      lon: kw('OBSGEO-L') ?? kw('LONG-OBS'),
      object: obj ? obj[1].trim() : '?',
    };
  } finally { fs.closeSync(fd); }
}
