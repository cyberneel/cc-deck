// Dashboard file explorer: browse the allowed roots, create folders, upload
// (with overwrite confirmation), download files, delete, and launch a session
// in any folder. Confined server-side to CCDECK_ROOTS.
import { pickFiles, sendFiles, toast } from './upload.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' MB' : `${n || 0} KB`);
async function gj(u, opts) {
  const r = await fetch(u, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

let cwd = localStorage.getItem('ccdeck.filespath') || '';

export function renderFiles(container) {
  container.innerHTML = `<div class="fx"><div class="fx-bar" id="fx-bar"></div><div class="fx-list" id="fx-list"><div class="empty muted">Loading…</div></div></div>`;
  load(cwd, container);
}

async function load(path, container) {
  const listEl = container.querySelector('#fx-list');
  let data;
  try { data = await gj(`/api/files?path=${encodeURIComponent(path || '')}`); }
  catch (e) { if (listEl) listEl.innerHTML = `<div class="empty muted">${esc(e.message)}</div>`; return; }
  cwd = data.path;
  localStorage.setItem('ccdeck.filespath', cwd);
  renderBar(data, container);
  renderList(data, container);
}

function renderBar(data, container) {
  const bar = container.querySelector('#fx-bar');
  const root = (data.roots || []).find((r) => data.path === r || data.path.startsWith(r + '/')) || data.path;
  const rel = data.path.slice(root.length).split('/').filter(Boolean);
  let acc = root;
  const crumbs = [`<button class="fx-crumb" data-path="${esc(root)}">${esc(root.split('/').pop() || root)}</button>`];
  for (const seg of rel) { acc += '/' + seg; crumbs.push(`<span class="fx-sep">›</span><button class="fx-crumb" data-path="${esc(acc)}">${esc(seg)}</button>`); }
  bar.innerHTML = `
    <div class="fx-crumbs">${crumbs.join('')}</div>
    <div class="spacer"></div>
    <button id="fx-up" ${data.parent ? '' : 'disabled'} title="Up one level">↑</button>
    <button id="fx-mkdir">+ Folder</button>
    <button id="fx-upload" class="primary">Upload here</button>`;
  bar.querySelectorAll('.fx-crumb').forEach((b) => b.addEventListener('click', () => load(b.dataset.path, container)));
  bar.querySelector('#fx-up').addEventListener('click', () => { if (data.parent) load(data.parent, container); });
  bar.querySelector('#fx-mkdir').addEventListener('click', () => mkdirHere(data.path, container));
  bar.querySelector('#fx-upload').addEventListener('click', () =>
    pickFiles(false, async (files, wp) => { if (await sendFiles(files, wp, data.path)) load(data.path, container); }));
}

function renderList(data, container) {
  const list = container.querySelector('#fx-list');
  if (!data.entries.length) { list.innerHTML = `<div class="empty muted">Empty folder</div>`; return; }
  list.innerHTML = data.entries.map((e) => {
    const full = data.path.replace(/\/$/, '') + '/' + e.name;
    const lead = e.type === 'file'
      ? `<a class="fx-act" href="/api/files/download?path=${encodeURIComponent(full)}" title="Download" download>⬇</a>`
      : `<button class="fx-act fx-sess" data-path="${esc(full)}" title="New session here">▶</button>`;
    return `<div class="fx-row ${e.type}" data-name="${esc(e.name)}" data-full="${esc(full)}">
      <span class="fx-ico">${e.type === 'dir' ? '📁' : '📄'}</span>
      <span class="fx-name">${esc(e.name)}</span>
      <span class="faint fx-meta">${e.type === 'file' ? kb(e.sizeKb) : ''}</span>
      ${lead}
      <button class="fx-act fx-del" data-full="${esc(full)}" title="Delete">🗑</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.fx-row.dir').forEach((r) =>
    r.addEventListener('click', (ev) => { if (!ev.target.closest('.fx-act')) load(r.dataset.full, container); }));
  list.querySelectorAll('.fx-sess').forEach((b) =>
    b.addEventListener('click', async (e) => { e.stopPropagation(); await newSessionHere(b.dataset.path); }));
  list.querySelectorAll('.fx-del').forEach((b) =>
    b.addEventListener('click', async (e) => { e.stopPropagation(); await del(b.dataset.full, data.path, container); }));
}

async function mkdirHere(path, container) {
  const name = (prompt('New folder name') || '').trim();
  if (!name) return;
  try { await gj('/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: path, name }) }); load(path, container); }
  catch (e) { toast(e.message); }
}

async function del(full, parent, container) {
  if (!confirm(`Permanently delete "${full.split('/').pop()}"? This can’t be undone.`)) return;
  try {
    const r = await gj('/api/files/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [full] }) });
    if (r.errors && r.errors.length) toast(r.errors[0]); else toast('Deleted');
    load(parent, container);
  } catch (e) { toast(e.message); }
}

async function newSessionHere(dir) {
  try {
    const { name } = await gj('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir }) });
    location.href = `/terminal.html?session=${encodeURIComponent(name)}`;
  } catch (e) { toast('Could not start session: ' + e.message); }
}
