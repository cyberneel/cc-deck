// Shared upload helpers used by the terminal and the dashboard file explorer.

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Open the OS file picker; `folder` => directory picker (desktop). Calls
// onPicked(fileArray, withPaths) once files are chosen.
export function pickFiles(folder, onPicked) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (folder) input.webkitdirectory = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => { const files = [...input.files]; input.remove(); if (files.length) onPicked(files, !!folder); });
  input.click();
}

const relOf = (f, withPaths) => (withPaths && f.webkitRelativePath) || f.name;
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Ask how to handle existing files. Resolves 'overwrite' | 'rename' | null(cancel).
function conflictChoice(exists) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    const shown = exists.slice(0, 8).map((n) => `<div class="up-f">${escH(n)}</div>`).join('');
    const more = exists.length > 8 ? `<div class="faint" style="margin-top:4px">…and ${exists.length - 8} more</div>` : '';
    bg.innerHTML = `
      <div class="modal">
        <h2>${exists.length} ${exists.length === 1 ? 'file already exists' : 'files already exist'} here</h2>
        <div class="up-files">${shown}</div>${more}
        <p class="faint" style="margin:14px 0 4px">How do you want to upload these?</p>
        <div class="modal-actions">
          <button id="cf-cancel">Cancel</button>
          <button id="cf-keep">Keep both</button>
          <button class="primary" id="cf-over">Overwrite</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    const done = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('#cf-cancel').addEventListener('click', () => done(null));
    bg.querySelector('#cf-keep').addEventListener('click', () => done('rename'));
    bg.querySelector('#cf-over').addEventListener('click', () => done('overwrite'));
    bg.addEventListener('click', (e) => { if (e.target === bg) done(null); });
  });
}

// Upload files into `dir`. Pre-checks for existing files and asks for one
// confirmation before overwriting any. Returns true on success.
export async function sendFiles(files, withPaths, dir) {
  if (!files.length || !dir) return false;
  const names = files.map((f) => relOf(f, withPaths));

  let mode = '';
  try {
    const r = await fetch(`/api/upload/check?dir=${encodeURIComponent(dir)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }),
    });
    const exists = r.ok ? ((await r.json()).exists || []) : [];
    if (exists.length) {
      const choice = await conflictChoice(exists); // 'overwrite' | 'rename' | null
      if (!choice) return false;
      mode = choice;
    }
  } catch { /* check failed: fall through; server defaults to skip-existing */ }

  const form = new FormData();
  // Carry each file's relative path in the field name so folder structure survives.
  for (const f of files) form.append('f:' + relOf(f, withPaths), f, f.name);
  toast(`Uploading ${files.length} item(s)…`);
  try {
    const r = await fetch(`/api/upload?dir=${encodeURIComponent(dir)}${mode ? `&mode=${mode}` : ''}`, { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const skip = j.skipped && j.skipped.length ? `, skipped ${j.skipped.length} existing` : '';
    toast(`Added ${j.count} file(s) to ${dir.split('/').slice(-2).join('/')}${skip}`);
    return true;
  } catch (e) { toast('Upload failed: ' + e.message); return false; }
}
