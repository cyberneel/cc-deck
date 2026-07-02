// Shared "New Claude session" modal used by both the dashboard and the terminal
// sidebar, so the two can't drift. Caller supplies:
//   api      - fetch helper: api(path, opts) -> parsed JSON (throws on error)
//   cfg      - /api/config result ({ roots, home, launchCommand })
//   onCreated(name) - what to do once a session is launched (navigate / switch)
import { SEED_FIELD_HTML, wireSeedSection } from './seedpicker.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function openNewModal({ api, cfg = {}, onCreated }) {
  let currentPath = (cfg.roots && cfg.roots[0]) || cfg.home || '/';
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <h2>New Claude session</h2>
      <div class="field">
        <label>Directory</label>
        <input id="dir-input" value="${esc(currentPath)}" spellcheck="false" />
        <div class="browser" id="browser"></div>
        <div class="mkdir-row">
          <input id="mkdir-name" placeholder="new-folder-name" spellcheck="false" autocapitalize="off" autocomplete="off" />
          <button type="button" id="mkdir-btn">+ Create folder here</button>
        </div>
      </div>
      <div class="field">
        <label>Title <span class="faint">(optional)</span></label>
        <input id="title-input" placeholder="defaults to the folder name" spellcheck="false" />
      </div>
      ${SEED_FIELD_HTML}
      <div class="error" id="modal-error"></div>
      <div class="modal-actions">
        <button id="cancel-btn">Cancel</button>
        <button class="primary" id="launch-btn">Launch ${esc(cfg.launchCommand || 'claude')}</button>
      </div>
    </div>`;
  document.body.appendChild(bg);

  const dirInput = bg.querySelector('#dir-input');
  const browser = bg.querySelector('#browser');
  const errEl = bg.querySelector('#modal-error');

  async function browse(path) {
    try {
      const { path: abs, dirs } = await api(`/api/fs?path=${encodeURIComponent(path)}`);
      currentPath = abs;
      dirInput.value = abs;
      const parent = abs.split('/').slice(0, -1).join('/') || '/';
      browser.innerHTML =
        `<div class="row up" data-path="${esc(parent)}">⬆ ..</div>` +
        dirs.map((d) => `<div class="row" data-path="${esc(d.path)}">📁 ${esc(d.name)}</div>`).join('');
      browser.querySelectorAll('.row').forEach((r) => r.addEventListener('click', () => browse(r.dataset.path)));
    } catch (e) {
      errEl.textContent = e.message;
    }
  }
  browse(currentPath);
  dirInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') browse(dirInput.value); });

  // Create a new subfolder under the current path, then navigate into it.
  const mkdirName = bg.querySelector('#mkdir-name');
  async function createFolder() {
    const name = mkdirName.value.trim();
    if (!name) { mkdirName.focus(); return; }
    errEl.textContent = '';
    try {
      const { created } = await api('/api/fs', { method: 'POST', body: JSON.stringify({ parent: currentPath, name }) });
      mkdirName.value = '';
      await browse(created);
      bg.querySelector('#title-input').focus();
    } catch (e) { errEl.textContent = e.message; }
  }
  bg.querySelector('#mkdir-btn').addEventListener('click', createFolder);
  mkdirName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createFolder(); } });

  const getSeed = wireSeedSection(bg);
  const close = () => bg.remove();
  bg.querySelector('#cancel-btn').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

  bg.querySelector('#launch-btn').addEventListener('click', async () => {
    errEl.textContent = '';
    const btn = bg.querySelector('#launch-btn');
    const seed = getSeed();
    const orig = btn.textContent;
    btn.disabled = true;
    try {
      const title = bg.querySelector('#title-input').value;
      let name;
      if (seed) {
        btn.textContent = seed.scope === 'summary' ? 'Generating context…' : 'Preparing…';
        ({ name } = await api('/api/handoff', {
          method: 'POST',
          body: JSON.stringify({ sources: seed.sources, scope: seed.scope, dest: 'new', targetDir: dirInput.value, title }),
        }));
      } else {
        ({ name } = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ dir: dirInput.value, title }) }));
      }
      close();
      onCreated(name);
    } catch (e) {
      btn.disabled = false; btn.textContent = orig;
      errEl.textContent = e.message;
    }
  });
}
