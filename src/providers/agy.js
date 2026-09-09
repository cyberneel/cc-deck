// Antigravity (agy) CLI provider — Gemini-backed, Claude-Code-style. Resume is
// `--conversation <id>`; its "permission mode" is `--mode accept-edits|plan`; and
// it has no fork-by-id, so a fork request just resumes the conversation. MCP is
// managed via `agy mcp` (persistent config, no per-launch flag), so the cc-deck
// handoff MCP is registered once at startup (registerAgyMcp), giving agy sessions
// the same handoff-aware toolset as Claude/Codex plus the CLI-agnostic surface.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

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
};

// Register (idempotently) the read-only cc-deck MCP with agy, so every agy session
// gets the handoff-aware toolset. agy has no per-launch MCP flag, so this persists
// to agy's own config; the static bearer goes in an Authorization header. Called
// once at startup when session-MCP wiring is enabled. Best-effort: agy may be
// absent (that's fine — the provider still lists) so failures are swallowed.
export async function registerAgyMcp() {
  if (!config.sessionMcp || !config.mcpTokenReadonly) return;
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const bin = config.agyCommand.split(/\s+/); // e.g. "agy" or a full path
  try {
    await pexec(bin[0], [...bin.slice(1), 'mcp', 'add', '--type', 'http',
      '--header', `Authorization: Bearer ${config.mcpTokenReadonly}`, 'cc-deck', url]);
  } catch { /* agy not installed / add failed — agy sessions just launch without the MCP */ }
}
