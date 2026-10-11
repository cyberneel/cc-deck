// Antigravity (agy) CLI provider — Gemini-backed, Claude-Code-style. Resume is
// `--conversation <id>`; its "permission mode" is `--mode accept-edits|plan`; and
// it has no fork-by-id, so a fork request just resumes the conversation. MCP is
// managed via `agy mcp` (persistent config, no per-launch flag), so the Polymux
// handoff MCP is registered once at startup (registerAgyMcp), giving agy sessions
// the same handoff-aware toolset as Claude/Codex plus the CLI-agnostic surface.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { enabled as turnTelemetry, hookCurl } from '../turn-telemetry.js';

const pexec = promisify(execFile);

// agy conversation ids aren't a fixed shape; keep it to safe chars (it's spliced
// into the launch line) and reject anything else.
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
function badId() { const e = new Error('Invalid resume conversation id'); e.statusCode = 400; return e; }

export const agy = {
  kind: 'agy',
  label: 'Agy',
  command: () => config.agyCommand,
  resumeIdRe: ID_RE,
  // "Do you trust the contents of this project?" — Yes is the default; the shared
  // trust handler navigates to the "Yes" line regardless.
  trust: { re: /do you trust|trust the contents of this (project|directory|folder)/i, yes: /\byes\b/i },

  launchArgs({ resume }) {
    let args = '';
    if (resume) {
      if (!ID_RE.test(resume)) throw badId();
      args = ` --conversation ${resume}`; // agy has no fork; resume continues the conversation
    }
    if (/^(accept-edits|plan)$/.test(config.agyMode)) args += ` --mode ${config.agyMode}`;
    return args;
  },

  // MCP is registered globally (registerAgyMcp), not per launch. Nothing to append.
  async wireFlags() { return ''; },

  // Live status + conversation (agents.js). The running agy holds its conversation open
  // (antigravity-cli/conversations/<id>.db, or a file under brain/<id>/); the readable log of
  // it is brain/<id>/.system_generated/logs/transcript.jsonl, one line per step.
  // ponytail: which of those files agy keeps open is unverified on a live agy (none ran here).
  transcriptOf(path) {
    const m = /^(.*\/antigravity-cli)\/(?:conversations\/([^/]+)\.db|brain\/([^/]+)\/)/.exec(path);
    const id = m && (m[2] || m[3]);
    return id && ID_RE.test(id) ? { id, file: join(m[1], 'brain', id, '.system_generated', 'logs', 'transcript.jsonl') } : null;
  },
  // A turn ends on a model response that calls no tool; anything after it means a new one started.
  turnEnded(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const d = rec(lines[i]);
      if (d) return d.type === 'PLANNER_RESPONSE' && !d.tool_calls?.length;
    }
    return null;
  },
  messages(lines) {
    return lines.map(rec).filter((d) => d?.content && (d.type === 'USER_INPUT' || d.type === 'PLANNER_RESPONSE'))
      .map((d) => d.type === 'USER_INPUT'
        ? { role: 'user', text: (/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(d.content)?.[1] ?? d.content).trim() }
        : { role: 'assistant', text: d.content.trim() });
  },
};
const rec = (l) => { try { return JSON.parse(l); } catch { return null; } };

// Register (idempotently) the read-only Polymux MCP with agy, so every agy session
// gets the handoff-aware toolset. agy has no per-launch MCP flag, so this persists
// to agy's own config; the static bearer goes in an Authorization header. Called
// once at startup when session-MCP wiring is enabled. Best-effort: agy may be
// absent (that's fine — the provider still lists) so failures are swallowed.
export async function registerAgyMcp() {
  if (!config.sessionMcp || !config.mcpTokenReadonly) return;
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const bin = config.agyCommand.split(/\s+/); // e.g. "agy" or a full path
  // Drop the entry registered under the old cc-deck name, or agy would load the tools twice.
  await pexec(bin[0], [...bin.slice(1), 'mcp', 'remove', 'cc-deck']).catch(() => {});
  try {
    await pexec(bin[0], [...bin.slice(1), 'mcp', 'add', '--type', 'http',
      '--header', `Authorization: Bearer ${config.mcpTokenReadonly}`, 'polymux', url]);
  } catch { /* agy not installed / add failed — agy sessions just launch without the MCP */ }
}

// Turn-telemetry hooks (see turn-telemetry.js). No per-launch hook flag either, so like the MCP
// they persist to agy's global hooks.json — merged in under our own name, the user's own hooks
// left as-is. agy hooks must print a JSON object, hence `echo {}`.
const AGY_HOOKS_PATH = join(homedir(), '.gemini', 'config', 'hooks.json');
export async function registerAgyHooks() {
  if (!turnTelemetry()) return;
  let cur = {};
  try { cur = JSON.parse(await readFile(AGY_HOOKS_PATH, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return; } // unparseable → don't touch it
  const h = (ev) => [{ type: 'command', command: `${hookCurl('agy', ev)}; echo {}`, timeout: 5 }];
  const want = { PreInvocation: h('PreInvocation'), Stop: h('Stop') };
  if (JSON.stringify(cur['cc-deck-telemetry']) === JSON.stringify(want)) return;
  await mkdir(dirname(AGY_HOOKS_PATH), { recursive: true });
  await writeFile(AGY_HOOKS_PATH, JSON.stringify({ ...cur, 'cc-deck-telemetry': want }, null, 2));
}
