// Codex CLI provider. Codex differs from Claude in the launch surface: resume/fork
// are SUBCOMMANDS (`codex resume <id>` / `codex fork <id>`, not flags), and its
// "permission mode" is the approval policy (`-a`). The cc-deck handoff MCP is
// wired per-launch via Codex's `-c mcp_servers.*` config overrides (scoped to
// this session, so the user's global ~/.codex/config.toml isn't touched); the
// read-only bearer is passed through the CCDECK_RO env var (Codex only supports
// an env-var bearer for HTTP MCP), which createSession exports on the launch line.
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { enabled as turnTelemetry, hookCurl } from '../turn-telemetry.js';

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
    let flags = '';
    if (config.sessionMcp && config.mcpTokenReadonly) {
      const url = `http://127.0.0.1:${config.port}/mcp`;
      flags += ` -c 'mcp_servers.cc-deck.url="${url}"' -c 'mcp_servers.cc-deck.bearer_token_env_var="CCDECK_RO"'`;
    }
    // Only once trusted: an untrusted hook stops the TUI on a "Hooks need review" modal.
    if (turnTelemetry() && await (hooksTrusted ??= trustCodexHooks().catch(() => false))) flags += hookOverrides().map((o) => ` -c '${o}'`).join('');
    return flags;
  },
};

// Turn-telemetry hooks, as `-c` overrides like the MCP. hookCurl is quote-free, so it nests in
// the single-quoted flag.
let hooksTrusted = null; // Promise<boolean>, once per process
const hookOverrides = () => ['UserPromptSubmit', 'Stop'].map((ev) => `hooks.${ev}=[{hooks=[{type="command",command="${hookCurl('codex')}"}]}]`);

// Codex only runs a hook whose exact definition is trusted: a hash persisted in the user's
// config.toml, keyed per source (`-c` overrides included). Trust OUR two the way its TUI does —
// ask an app-server for their key+hash, write hooks.state — and nothing else. Not
// --dangerously-bypass-hook-trust: that would also run any cloned repo's .codex hooks.
// Resolves true once both are trusted; false (→ no hooks) on any failure.
async function trustCodexHooks() {
  const bin = config.codexCommand.split(/\s+/);
  const p = spawn(bin[0], [...bin.slice(1), ...hookOverrides().flatMap((o) => ['-c', o]), 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let n = 0, buf = '';
  const settle = () => { for (const r of pending.values()) r({}); pending.clear(); };
  p.on('error', settle); p.on('close', settle); p.stdin.on('error', () => {});
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      try { const m = JSON.parse(buf.slice(0, i)); pending.get(m.id)?.(m); pending.delete(m.id); } catch { /* not ours */ }
    }
  });
  const rpc = (method, params) => new Promise((res) => { pending.set(++n, res); p.stdin.write(JSON.stringify({ id: n, method, params }) + '\n'); });
  const kill = setTimeout(() => p.kill(), 30_000);
  try {
    await rpc('initialize', { clientInfo: { name: 'cc-deck', version: '1' } });
    p.stdin.write('{"method":"initialized"}\n');
    const ours = hookCurl('codex');
    const hooks = (await rpc('hooks/list', {})).result?.data?.flatMap((d) => d.hooks) ?? [];
    const mine = hooks.filter((h) => h.source === 'sessionFlags' && h.command === ours);
    const state = Object.fromEntries(mine.filter((h) => h.trustStatus !== 'trusted').map((h) => [h.key, { trusted_hash: h.currentHash }]));
    if (mine.length !== 2) return false;
    if (!Object.keys(state).length) return true;
    const w = await rpc('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'upsert' }] });
    return w.result?.status === 'ok';
  } finally { clearTimeout(kill); p.kill(); }
}
