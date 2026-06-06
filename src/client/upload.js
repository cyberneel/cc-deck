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

// Upload files into `dir`. Pre-checks for existing files and asks for one
// confirmation before overwriting any. Returns true on success.
export async function sendFiles(files, withPaths, dir) {
  if (!files.length || !dir) return false;
  const names = files.map((f) => relOf(f, withPaths));

  let overwrite = false;
  try {
    const r = await fetch(`/api/upload/check?dir=${encodeURIComponent(dir)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }),
    });
    const exists = r.ok ? ((await r.json()).exists || []) : [];
    if (exists.length) {
      const shown = exists.slice(0, 8).map((n) => `• ${n}`).join('\n');
      const more = exists.length > 8 ? `\n…and ${exists.length - 8} more` : '';
      if (!confirm(`${exists.length} file(s) already exist here and will be overwritten:\n\n${shown}${more}\n\nOverwrite?`)) return false;
      overwrite = true;
    }
  } catch { /* if the check fails, fall through; server still won't overwrite without the flag */ }

  const form = new FormData();
  // Carry each file's relative path in the field name so folder structure survives.
  for (const f of files) form.append('f:' + relOf(f, withPaths), f, f.name);
  toast(`Uploading ${files.length} item(s)…`);
  try {
    const r = await fetch(`/api/upload?dir=${encodeURIComponent(dir)}${overwrite ? '&overwrite=1' : ''}`, { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const skip = j.skipped && j.skipped.length ? `, skipped ${j.skipped.length} existing` : '';
    toast(`Added ${j.count} file(s) to ${dir.split('/').slice(-2).join('/')}${skip}`);
    return true;
  } catch (e) { toast('Upload failed: ' + e.message); return false; }
}
