import crypto from 'node:crypto';
import { config } from './config.js';

// Timing-safe string comparison that tolerates length differences.
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still run a comparison to keep timing roughly constant.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function checkPassword(input) {
  if (!config.password) return false;
  return safeEqual(input, config.password);
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', config.secret).update(payloadB64).digest('base64url');
}

// Token format: <base64url(json)>.<base64url(hmac)>
export function issueToken() {
  const payload = { iat: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payloadB64, mac] = token.split('.');
  if (!payloadB64 || !mac) return false;
  const expected = sign(payloadB64);
  if (!safeEqual(mac, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const ageMs = Date.now() - (payload.iat || 0);
    if (ageMs < 0 || ageMs > config.cookieMaxAge * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

// Extract and verify the auth cookie from a raw Cookie header (used at ws upgrade).
export function isRequestAuthed(rawCookieHeader) {
  if (!rawCookieHeader) return false;
  const pairs = rawCookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    if (name === config.cookieName) {
      const value = decodeURIComponent(pair.slice(idx + 1).trim());
      return verifyToken(value);
    }
  }
  return false;
}
