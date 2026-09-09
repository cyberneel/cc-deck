// CLI provider registry. cc-deck is CLI-agnostic: each session records its `kind`
// (claude | codex | …) and the matching provider owns everything CLI-specific
// (launch/resume/fork args, auto-wire, and — later — live status + history). Add a
// new CLI by dropping in one provider file and registering it here.
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { agy } from './agy.js';

const PROVIDERS = { claude, codex, agy };

// Default to Claude so sessions created before `kind` existed keep working.
export const DEFAULT_KIND = 'claude';
export const PROVIDER_KINDS = Object.keys(PROVIDERS);
export function getProvider(kind) { return PROVIDERS[kind] || PROVIDERS[DEFAULT_KIND]; }
export function providerList() { return PROVIDER_KINDS.map((k) => ({ kind: k, label: PROVIDERS[k].label })); }

// Is a provider's launch binary actually installed? An absolute/relative path is
// checked directly; a bare name is looked up on PATH. Used so cc-deck only OFFERS
// CLIs that exist here (a tenant that never installed agy shouldn't see it in the
// picker and crash on "command not found"), and so createSession fails cleanly.
export async function providerAvailable(kind) {
  const cmd = (getProvider(kind).command() || '').split(/\s+/)[0]; // strip any args
  if (!cmd) return false;
  if (cmd.includes('/')) { try { await access(cmd, constants.X_OK); return true; } catch { return false; } }
  for (const dir of (process.env.PATH || '').split(':').filter(Boolean)) {
    try { await access(join(dir, cmd), constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

// Providers whose binary is present here — what the New Session picker should show.
// Never empty: if nothing resolves (a broken install) fall back to the default so
// the UI still works. Claude, Codex, agy all resolve on a normal owner box.
export async function availableProviders() {
  const avail = [];
  for (const k of PROVIDER_KINDS) if (await providerAvailable(k)) avail.push({ kind: k, label: PROVIDERS[k].label });
  return avail.length ? avail : [{ kind: DEFAULT_KIND, label: PROVIDERS[DEFAULT_KIND].label }];
}
