import { resolve } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

function parseRoots(raw) {
  const list = (raw || process.env.HOME || '/home/cyber')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  return list;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  bind: process.env.CCDECK_BIND || '127.0.0.1',
  password: process.env.CCDECK_PASSWORD || '',
  secret: process.env.CCDECK_SECRET || '',
  // Directories under which new sessions may be launched / browsed.
  roots: parseRoots(process.env.CCDECK_ROOTS),
  // tmux session name prefix for sessions this app manages.
  prefix: 'ccdeck-',
  // Command launched inside each new session.
  launchCommand: process.env.CCDECK_LAUNCH || 'claude',
  cookieName: 'ccdeck',
  cookieMaxAge: 60 * 60 * 24 * 30, // 30 days (seconds)
};

if (!config.password) {
  console.warn('[cc-deck] WARNING: CCDECK_PASSWORD is not set — login is effectively disabled. Set it in .env.');
}
if (!config.secret) {
  console.warn('[cc-deck] WARNING: CCDECK_SECRET is not set — using an insecure default. Set a random value in .env.');
  config.secret = 'insecure-development-secret-change-me';
}
