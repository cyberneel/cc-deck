// Viewer for a session's pending "external updates" (summaries pushed back from
// outside chats via the MCP save_session_summary tool). For a running session,
// offers Apply; for a past session, notes are applied automatically on resume.
import { toast } from './upload.js';

const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function gj(u, opts) {
  const r = await fetch(u, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

// sessionId = the Claude session id (to read notes); liveName = the running
// cc-deck session name if it's active (enables Apply); onApplied = refresh cb.
export async function openNotes(sessionId, liveName, onApplied) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal" style="max-width:560px">
      <h2>External updates</h2>
      <div id="nt-body" class="nt-body"><p class="faint">Loading…</p></div>
      <div class="modal-actions">
        <button id="nt-close">Close</button>
        ${liveName ? '<button class="primary" id="nt-apply">Apply to running session</button>' : ''}
      </div>
    </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#nt-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

  const body = bg.querySelector('#nt-body');
  try {
    const { notes } = await gj(`/api/notes/${encodeURIComponent(sessionId)}`);
    if (!notes.length) {
      body.innerHTML = '<p class="faint">No pending updates.</p>';
    } else {
      body.innerHTML = notes.map((n) =>
        `<div class="nt-note"><div class="faint nt-when">${n.savedAt ? new Date(n.savedAt).toLocaleString() : ''}</div><div class="nt-text">${escH(n.text)}</div></div>`).join('')
        + (liveName ? '' : '<p class="faint" style="margin-top:10px">These are added automatically the next time you resume this session.</p>');
    }
  } catch (e) { body.innerHTML = `<p class="faint">${escH(e.message)}</p>`; }

  if (liveName) {
    bg.querySelector('#nt-apply').addEventListener('click', async () => {
      try {
        const r = await gj(`/api/sessions/${encodeURIComponent(liveName)}/apply-notes`, { method: 'POST' });
        toast(r.applied ? 'Applied — Claude is reading the update(s).' : 'No pending updates.');
        close();
        onApplied && onApplied();
      } catch (e) { toast('Failed: ' + e.message); }
    });
  }
}
