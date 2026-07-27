# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue.

Use GitHub's **[private vulnerability reporting](https://github.com/cyberneel/cc-deck/security/advisories/new)**
("Report a vulnerability" under the repository's **Security** tab). Include:

- what the issue is and its impact,
- steps to reproduce (or a proof of concept),
- affected version / commit.

You'll get an acknowledgement as soon as the maintainer sees it. Since this is a small
self-hosted project maintained in spare time, please allow a reasonable window for a fix before
any public disclosure.

## Scope & deployment notes

cc-deck is designed to run **behind a private boundary**, not open on the internet:

- Keep `CCDECK_BIND=127.0.0.1` so the raw, unauthenticated port is never exposed on the network.
  Reach it through Tailscale or a Cloudflare Tunnel + Access, as described in the README.
- It uses a **single shared password** (no multi-user accounts) — layer Cloudflare Access (or
  similar) in front if you need per-identity control.
- Treat `CCDECK_MCP_TOKEN` like a password: a holder of the static bearer can **create and drive
  sessions** via MCP. Use `CCDECK_MCP_TOKEN_READONLY` for callers that should only read + leave
  notes.
- cc-deck can launch and attach to real shells/`claude` processes under `CCDECK_ROOTS`. Anyone
  who can authenticate effectively has that access — scope `CCDECK_ROOTS` accordingly.

Reports about running cc-deck in a configuration it explicitly warns against (e.g. binding to a
public interface without an auth layer) are still welcome, but hardening guidance may be the
answer rather than a code change.
