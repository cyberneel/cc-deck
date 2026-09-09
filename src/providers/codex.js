// Codex CLI provider. Codex differs from Claude in the launch surface: resume/fork
// are SUBCOMMANDS (`codex resume <id>` / `codex fork <id>`, not flags), and its
// "permission mode" is the approval policy (`-a`). The cc-deck handoff MCP is
// wired per-launch via Codex's `-c mcp_servers.*` config overrides (scoped to
// this session, so the user's global ~/.codex/config.toml isn't touched); the
// read-only bearer is passed through the CCDECK_RO env var (Codex only supports
// an env-var bearer for HTTP MCP), which createSession exports on the launch line.
import { config } from '../config.js';

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
function badId() { const e = new Error('Invalid resume session id'); e.statusCode = 400; return e; }

export const codex = {
  kind: 'codex',
  label: 'Codex',
  command: () => config.codexCommand,
  resumeIdRe: UUID_RE,
  // Codex's "Do you trust the contents of this directory?" gate; `yes` matches its
  // "Yes, continue" menu line (navigated to, so ordering changes don't break it).
  trust: { re: /do you trust|trust the contents of this directory/i, yes: /\byes\b/i },

  launchArgs({ resume, fork }) {
    let args = '';
    if (resume) {
      if (!UUID_RE.test(resume)) throw badId();
      args = fork ? ` fork ${resume}` : ` resume ${resume}`; // codex subcommands
    }
    if (config.codexApproval) args += ` -a ${config.codexApproval}`; // approval policy = its permission mode
    return args;
  },

  // Wire the read-only cc-deck MCP as a streamable-HTTP server via `-c` config
  // overrides (scoped to this launch). Bearer comes from CCDECK_RO in the env.
  // Same handoff-aware toolset the Claude sessions get: search / get_context /
  // list_sessions / save_session_summary (leave a note) / browser_*.
  async wireFlags() {
    if (!config.sessionMcp || !config.mcpTokenReadonly) return '';
    const url = `http://127.0.0.1:${config.port}/mcp`;
    return ` -c 'mcp_servers.cc-deck.url="${url}"' -c 'mcp_servers.cc-deck.bearer_token_env_var="CCDECK_RO"'`;
  },
};
