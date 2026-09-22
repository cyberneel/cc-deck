// Durable set of "proactive" Claude sessionIds — sessions Friday spun up itself
// (the create_session MCP tool: orchestrated builds, the "needs your input"
// relays). Search/history are keyed by Claude sessionId (transcript files), not
// by tmux, and a session's sessionId isn't known until it boots — so we can't
// tag it on the tmux side alone. This file is the bridge: the snapshot loop
// records proactive liveSessionIds here, and search/history read it to hide them
// so Friday-made sessions don't clutter the user's own past work.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const FILE = process.env.CCDECK_ORIGIN_FILE
  || join(homedir(), '.claude', 'cc-deck', 'proactive-sessions.json');

export async function proactiveSet() {
  try { return new Set(JSON.parse(await readFile(FILE, 'utf8'))); }
  catch { return new Set(); } // missing/corrupt → nothing hidden
}

// Add sessionIds; no-op write when nothing is new. Read-modify-write is safe here
// because the only writer is the single 120s snapshot loop in this process.
// ponytail: last-writer-wins if that ever gains a second writer; next snapshot re-adds.
export async function markProactive(ids) {
  const set = await proactiveSet();
  let changed = false;
  for (const id of ids) if (id && !set.has(id)) { set.add(id); changed = true; }
  if (!changed) return;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify([...set]), 'utf8');
}
