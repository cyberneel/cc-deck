// Codex CLI provider. Codex differs from Claude in the launch surface: resume/fork
// are SUBCOMMANDS (`codex resume <id>` / `codex fork <id>`, not flags), and its
// "permission mode" is the approval policy (`-a`). MCP is configured via
// ~/.codex/config.toml rather than launch flags, so the cc-deck handoff/browser
// auto-wire isn't applied here (see providers/README or the roadmap) — a Codex
// session launches clean and gets the CLI-agnostic parts (terminal, attach, kill,
// rename, snapshot, remote).
import { config } from '../config.js';

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
function badId() { const e = new Error('Invalid resume session id'); e.statusCode = 400; return e; }

export const codex = {
  kind: 'codex',
  label: 'Codex',
  command: () => config.codexCommand,
  resumeIdRe: UUID_RE,

  launchArgs({ resume, fork }) {
    let args = '';
    if (resume) {
      if (!UUID_RE.test(resume)) throw badId();
      args = fork ? ` fork ${resume}` : ` resume ${resume}`; // codex subcommands
    }
    if (config.codexApproval) args += ` -a ${config.codexApproval}`; // approval policy = its permission mode
    return args;
  },

  // Codex wires MCP through ~/.codex/config.toml, not launch flags. Nothing to append.
  async wireFlags() { return ''; },
};
