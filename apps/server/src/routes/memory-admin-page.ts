/**
 * Self-contained memory curation page, served at GET /api/memory/admin.
 * Pure backend (no web build) so Florian can SEE and FIX everything Nova
 * remembers about him — the OpenClaw-style "editable memory" guarantee — and
 * so the rebuild is verifiable. Talks to the same /api/memory/* JSON routes.
 */
export const MEMORY_ADMIN_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nova · Memory</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #14131a; color: #e8e6ef; }
  header { position: sticky; top: 0; background: #1c1b25; border-bottom: 1px solid #2c2a3a; padding: 14px 18px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; color: #c7b8ff; }
  .muted { color: #8a87a0; }
  main { padding: 18px; max-width: 1100px; margin: 0 auto; }
  .add { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  input, select, textarea, button { font: inherit; background: #232231; color: #e8e6ef; border: 1px solid #393750; border-radius: 7px; padding: 7px 9px; }
  input.text { flex: 1; min-width: 280px; }
  button { cursor: pointer; background: #2d2b3e; }
  button:hover { background: #393750; }
  button.primary { background: #6c5ce7; border-color: #6c5ce7; color: #fff; }
  button.danger { background: transparent; border-color: #5a2b37; color: #ff9bb0; }
  .row { display: grid; grid-template-columns: 1fr 92px 56px auto; gap: 8px; align-items: center; padding: 9px; border: 1px solid #2c2a3a; border-radius: 9px; margin-bottom: 8px; background: #1a1924; }
  .row.deleted { opacity: .5; }
  .row .meta { grid-column: 1 / -1; font-size: 12px; color: #8a87a0; display: flex; gap: 12px; flex-wrap: wrap; }
  .tag { padding: 1px 7px; border-radius: 999px; background: #2a2838; font-size: 11px; }
  .tag.self { color: #9be3a0; } .tag.user_confirmed { color: #ffd479; } .tag.extracted { color: #9bb8ff; }
  .actions { display: flex; gap: 6px; }
  .imp { width: 48px; text-align: center; }
  #status { font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Nova · Memory</h1>
  <span class="muted" id="count">…</span>
  <label class="muted"><input type="checkbox" id="incDeleted" /> show deleted</label>
  <button id="refresh">Refresh</button>
  <span id="status" class="muted"></span>
</header>
<main>
  <div class="add">
    <input class="text" id="newText" placeholder="Add a memory about Florian (third person, e.g. 'Florian is learning Japanese')" />
    <select id="newImp" title="importance">
      <option value="1">1 · trivial</option><option value="2">2</option>
      <option value="3" selected>3 · normal</option><option value="4">4</option>
      <option value="5">5 · critical</option>
    </select>
    <button class="primary" id="add">Add</button>
  </div>
  <div id="list"></div>
</main>
<script>
const API = '/api/memory'
const $ = (s, r=document) => r.querySelector(s)
const esc = s => (s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const setStatus = (m, ok=true) => { const e = $('#status'); e.textContent = m; e.style.color = ok ? '#9be3a0' : '#ff9bb0'; setTimeout(() => e.textContent = '', 2500) }

async function api(path, opts) {
  const res = await fetch(API + path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts })
  if (!res.ok) throw new Error(path + ' ' + res.status)
  return res.json().catch(() => null)
}

function fmtDate(d) { try { return new Date(d).toISOString().slice(0, 10) } catch { return '' } }

function rowEl(m) {
  const el = document.createElement('div')
  el.className = 'row' + (m.deletedAt ? ' deleted' : '')
  el.innerHTML = \`
    <input class="rtext" value="\${esc(m.text)}" />
    <select class="rkind">
      \${['fact','preference','event','context'].map(k => \`<option \${k===m.kind?'selected':''}>\${k}</option>\`).join('')}
    </select>
    <input class="imp rimp" type="number" min="1" max="5" value="\${m.importance}" />
    <div class="actions">
      \${m.deletedAt
        ? \`<button class="restore">Restore</button>\`
        : \`<button class="save primary">Save</button><button class="del danger">Delete</button>\`}
    </div>
    <div class="meta">
      <span class="tag \${m.source}">\${m.source}</span>
      <span>conf \${(m.confidence ?? 0).toFixed(2)}</span>
      <span>seen×\${m.reinforceCount ?? 1}</span>
      <span>last \${fmtDate(m.lastSeenAt ?? m.createdAt)}</span>
      \${m.deletedAt ? \`<span>deleted \${fmtDate(m.deletedAt)}</span>\` : ''}
      <span class="muted">\${m.id.slice(0,8)}</span>
    </div>\`
  $('.save', el)?.addEventListener('click', async () => {
    try {
      await api('/update', { method: 'POST', body: JSON.stringify({ id: m.id, text: $('.rtext', el).value.trim(), kind: $('.rkind', el).value, importance: Number($('.rimp', el).value) }) })
      setStatus('saved'); load()
    } catch (e) { setStatus(e.message, false) }
  })
  $('.del', el)?.addEventListener('click', async () => {
    try { await api('/delete', { method: 'POST', body: JSON.stringify({ id: m.id }) }); setStatus('deleted'); load() }
    catch (e) { setStatus(e.message, false) }
  })
  $('.restore', el)?.addEventListener('click', async () => {
    try { await api('/restore', { method: 'POST', body: JSON.stringify({ id: m.id }) }); setStatus('restored'); load() }
    catch (e) { setStatus(e.message, false) }
  })
  return el
}

async function load() {
  try {
    const inc = $('#incDeleted').checked ? '&includeDeleted=1' : ''
    const rows = await api('/list?n=500' + inc, { method: 'GET' })
    const list = $('#list'); list.innerHTML = ''
    rows.forEach(m => list.appendChild(rowEl(m)))
    const active = rows.filter(r => !r.deletedAt).length
    $('#count').textContent = active + ' active' + (rows.length > active ? \` · \${rows.length - active} deleted\` : '')
  } catch (e) { setStatus(e.message, false) }
}

$('#add').addEventListener('click', async () => {
  const text = $('#newText').value.trim()
  if (text.length < 8) return setStatus('too short', false)
  try {
    await api('/write', { method: 'POST', body: JSON.stringify({ text, importance: Number($('#newImp').value), source: 'user_confirmed' }) })
    $('#newText').value = ''; setStatus('added'); load()
  } catch (e) { setStatus(e.message, false) }
})
$('#refresh').addEventListener('click', load)
$('#incDeleted').addEventListener('change', load)
load()
</script>
</body>
</html>`
