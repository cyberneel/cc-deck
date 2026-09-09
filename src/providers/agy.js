// Antigravity (agy) CLI provider — Gemini-backed, Claude-Code-style. Resume is
// `--conversation <id>`; its "permission mode" is `--mode accept-edits|plan`; MCP is
// managed via `agy mcp` (config, not launch flags); and it has no fork-by-id, so a
// fork request just resumes the conversation. An agy session gets the CLI-agnostic
// surface (terminal/attach/kill/rename-label/snapshot/remote).
import { config } from '../config.js';

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

  // MCP is configured via `agy mcp`, not launch flags. Nothing to append.
  async wireFlags() { return ''; },
};
