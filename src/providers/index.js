// CLI provider registry. cc-deck is CLI-agnostic: each session records its `kind`
// (claude | codex | …) and the matching provider owns everything CLI-specific
// (launch/resume/fork args, auto-wire, and — later — live status + history). Add a
// new CLI by dropping in one provider file and registering it here.
import { claude } from './claude.js';
import { codex } from './codex.js';

const PROVIDERS = { claude, codex };

// Default to Claude so sessions created before `kind` existed keep working.
export const DEFAULT_KIND = 'claude';
export const PROVIDER_KINDS = Object.keys(PROVIDERS);
export function getProvider(kind) { return PROVIDERS[kind] || PROVIDERS[DEFAULT_KIND]; }
export function providerList() { return PROVIDER_KINDS.map((k) => ({ kind: k, label: PROVIDERS[k].label })); }
