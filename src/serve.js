/**
 * A small local UI for the crawler.
 *
 * The crawler's state lives in a SQLite file on whichever machine runs it, so this is
 * served from there rather than bolted into the app's admin console — the alternative
 * would be shipping a copy of this data to Firestore and then having two versions of the
 * truth, which is the thing the whole design avoids.
 *
 * It binds to localhost only and has no authentication, deliberately: it is a window onto
 * a local file, and it should never be reachable from anywhere else.
 *
 *   node src/cli.js serve            → http://127.0.0.1:7777
 */

const http = require('http');
const manifest = require('./manifest');
const registry = require('./registry');
const discover = require('./phases/discover');
const handoff = require('./phases/handoff');
const lookup = require('./phases/lookup');

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>gear-crawler</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:#0f0f13; color:#e4e4e8; font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.wrap { max-width:1200px; margin:0 auto; padding:24px; }
h1 { font-size:19px; margin:0 0 4px; }
h2 { font-size:14px; text-transform:uppercase; letter-spacing:.8px; color:#7a7a85; margin:26px 0 10px; }
.sub { color:#7a7a85; font-size:13px; margin-bottom:18px; }
.card { background:#16161c; border:1px solid #26262e; border-radius:10px; padding:16px 18px; margin-bottom:16px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
td,th { padding:7px 10px; border-bottom:1px solid #23232b; text-align:left; vertical-align:top; }
th { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:#7a7a85; }
td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
.pill { display:inline-block; padding:1px 8px; border-radius:20px; font-size:11px; font-weight:700; }
.ok{background:rgba(74,222,128,.12);color:#4ade80}.warn{background:rgba(251,191,36,.12);color:#fbbf24}
.bad{background:rgba(248,113,113,.12);color:#f87171}.neutral{background:#26262e;color:#9a9aa5}
button { background:#232330; border:1px solid #3a3a48; color:#d4d4d8; border-radius:6px;
         padding:5px 11px; font:inherit; font-size:12px; font-weight:600; cursor:pointer; }
button:hover { border-color:#55556a; color:#fff; } button:disabled{opacity:.4;cursor:default}
button.go { background:#2563eb; border-color:#2563eb; color:#fff; }
.muted{color:#6b6b75;font-size:12.5px}
pre { background:#0c0c10; border:1px solid #23232b; border-radius:6px; padding:10px;
      white-space:pre-wrap; font-size:12px; color:#9a9aa5; max-height:260px; overflow:auto; }
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
input,select{background:#1b1b22;border:1px solid #33333d;border-radius:6px;color:#e4e4e8;padding:6px 9px;font:inherit;font-size:13px}
</style></head><body><div class="wrap">
<h1>gear-crawler</h1>
<div class="sub">Finds manufacturer manuals and hands them to GearPlug. This page reads the local manifest — nothing here is on the internet.</div>

<div class="card">
  <h2 style="margin-top:0">Look up a company</h2>
  <div class="muted" style="margin-bottom:10px">Type a manufacturer. It checks what the library already answers for them, walks their support pages, and shows what we do not have.</div>
  <div class="row">
    <input id="brand-name" placeholder="Roland, Korg, Strymon…" size="24" list="brand-list">
    <datalist id="brand-list"></datalist>
    <input id="brand-url" placeholder="support page URL (only if it isn't known)" size="42">
    <button class="go" id="lookup">Look up</button>
    <span class="muted" id="lookup-status"></span>
  </div>
  <div id="lookup-result"></div>
</div>

<div class="card"><h2 style="margin-top:0">Budgets</h2><table id="budgets"></table></div>

<div class="card">
  <h2 style="margin-top:0">Brands</h2>
  <div class="row">
    <button class="go" id="discover-all">Discover all due</button>
    <span class="muted">A brand is re-walked when its last discovery is over 7 days old.</span>
  </div>
  <table id="brands"></table>
</div>

<div class="card">
  <h2 style="margin-top:0">Manuals found</h2>
  <div class="row">
    <input id="q" placeholder="Search gear or URL…" size="28">
    <select id="state"><option value="outstanding">still to do</option></select>
    <button class="go" id="handoff">Hand off 10 to the app</button>
    <button id="hunt-btn" title="Walk the ranked gap brands, demand-weighted, and record what fills gaps">Hunt top 10</button>
    <button id="lookup-roland" title="Probe Roland gaps by product URL">Lookup Roland</button>
    <button id="lookup-korg" title="Probe Korg gaps via the download picker">Lookup Korg</button>
    <button id="behringer-btn" title="Fill Behringer gaps through its storefront API">Behringer API</button>
    <button id="rejudge-btn" title="Re-apply current match rules to the queue (dry run)">Rejudge</button>
    <a href="/clicklist" target="_blank" style="margin-left:8px; color:#a78bfa; font-size:13px; align-self:center">Click-list (the human hour) &rarr;</a>
    <span class="muted" id="handoff-note"></span>
  </div>
  <table id="docs"></table>
</div>

<div class="card">
  <h2 style="margin-top:0">Unresolved names</h2>
  <div class="muted">Found, but no model in the registry matches. These are the registry's worklist — a wrong identity is worse than a gap.</div>
  <pre id="unmatched">—</pre>
</div>

<div class="card"><h2 style="margin-top:0">Activity</h2><pre id="log">ready</pre></div>
</div>
<script>
const $ = id => document.getElementById(id);
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const say = t => { $('log').textContent = t + '\\n' + $('log').textContent; };
const get = u => fetch(u).then(r=>r.json());
const post = (u,b) => fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());

async function load() {
  const d = await get('/api/state');
  $('budgets').innerHTML = '<tr><th>Budget</th><th class="num">Used</th><th class="num">Cap</th></tr>' +
    d.budgets.map(b=>'<tr><td>'+esc(b.key)+'</td><td class="num">'+b.used.toLocaleString()+
      '</td><td class="num">'+b.cap.toLocaleString()+'</td></tr>').join('');

  $('brands').innerHTML = '<tr><th>Brand</th><th>State</th><th class="num">Manuals</th><th class="num">Unresolved</th><th></th></tr>' +
    (d.brands.length ? d.brands.map(b=>{
      const tone = b.state.startsWith('blocked') ? 'bad' : b.state==='active' ? 'ok' : 'neutral';
      return '<tr><td><strong>'+esc(b.slug)+'</strong></td><td><span class="pill '+tone+'">'+esc(b.state)+'</span>'+
        (b.blocked_reason?'<br><span class="muted">'+esc(b.blocked_reason).slice(0,60)+'</span>':'')+'</td>'+
        '<td class="num">'+b.docs+'</td><td class="num">'+b.unmatched+'</td>'+
        '<td style="text-align:right"><button data-brand="'+esc(b.slug)+'">Discover</button></td></tr>';
    }).join('') : '<tr><td class="muted">No brands yet — add a file under registry/brands.</td></tr>');

  if (!$('state').dataset.filled) {
    const all = d.states.reduce((n,s)=>n+s.c, 0);
    $('state').innerHTML =
      '<option value="outstanding">still to do</option>' +
      '<option value="">everything (' + all + ')</option>' +
      d.states.map(s=>'<option value="'+esc(s.state)+'">'+esc(s.state)+' ('+s.c+')</option>').join('');
    $('state').dataset.filled = '1';
  }
  $('handoff-note').textContent = d.readyToHandOff
    ? d.readyToHandOff + ' named and ready'
    : 'nothing waiting — every named manual has been sent';
  $('handoff').dataset.ready = d.readyToHandOff ? '1' : '0';
  $('handoff').style.opacity = d.readyToHandOff ? '' : '.55';
  $('unmatched').textContent = d.unmatched.length ? d.unmatched.join('\\n') : 'none';
  loadDocs();
}

async function loadDocs() {
  const d = await get('/api/documents?q='+encodeURIComponent($('q').value)+'&state='+encodeURIComponent($('state').value));
  $('docs').innerHTML = '<tr><th>Gear</th><th>State</th><th class="num" title="as reported at handoff — the admin panel shows live counts">Pages†</th><th class="num" title="as reported at handoff — the admin panel shows live counts">Chunks†</th><th>Source</th></tr>' +
    (d.docs.length ? d.docs.map(x=>{
      const tone = x.state==='handed_off'?'ok':x.state.startsWith('dead')?'bad':'neutral';
      return '<tr><td>'+(x.gear_name ? esc(x.gear_name) : '<span class="muted">unresolved</span>')+'</td>'+
        '<td><span class="pill '+tone+'">'+esc(x.state)+'</span>'+(x.last_error?'<br><span class="muted">'+esc(x.last_error).slice(0,70)+'</span>':'')+'</td>'+
        '<td class="num">'+(x.pages||'—')+'</td><td class="num">'+(x.chunks||'—')+'</td>'+
        '<td class="muted">'+esc(x.source_url.split('/').pop()).slice(0,54)+'</td></tr>';
    }).join('') : '<tr><td class="muted">Nothing matches.</td></tr>') ;
  $('docs').insertAdjacentHTML('beforeend',
    '<tr><td colspan="5" class="muted">showing '+d.docs.length+' of '+d.total+
      ($('state').value==='outstanding' && d.done
        ? ' — '+d.done+' already in the library, hidden. They stay on the record: that is what stops the same PDF being handed off, and paid for, twice.'
        : '')+'</td></tr>');
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button[data-brand]');
  if (b) {
    b.disabled = true; say('discovering ' + b.dataset.brand + '…');
    const r = await post('/api/discover', { brand: b.dataset.brand });
    say(r.error ? ('failed: ' + r.error) : (b.dataset.brand + ': ' + r.added + ' new manual(s)'));
    b.disabled = false; return load();
  }
});
$('discover-all').addEventListener('click', async () => {
  const el = $('discover-all'); el.disabled = true; say('discovering all due brands…');
  const r = await post('/api/discover', {});
  say(r.error ? ('failed: ' + r.error) : (r.brands + ' brand(s), ' + r.added + ' new manual(s)'));
  el.disabled = false; load();
});
$('handoff').addEventListener('click', async () => {
  const btn = $('handoff');
  if (btn.dataset.ready === '0') {
    say('Nothing to hand off: every named manual has already been sent. Discover a brand first.');
    return;
  }
  btn.disabled = true; say('handing off…');
  const r = await post('/api/handoff', { limit: 10 });
  if (r.error) say('failed: ' + r.error);
  else if (!r.sent && !r.failed) say('Nothing was sent — no named manual is waiting.');
  else say(r.sent + ' handed off, ' + r.failed + ' failed');
  btn.disabled = false; load();
});
let PREVIEW = null;

async function runBtn(id, url, body, describe) {
  const b = $(id); b.disabled = true; const was = b.textContent; b.textContent = 'running…';
  try {
    const r = await post(url, body || {});
    alert(describe(r));
  } catch (e) { alert('failed: ' + e.message); }
  b.disabled = false; b.textContent = was; refresh();
}
$('hunt-btn').onclick = () => runBtn('hunt-btn', '/api/hunt', { top: 10 }, r => (r.log || []).slice(-6).join(' | ') || 'done');
$('lookup-roland').onclick = () => runBtn('lookup-roland', '/api/lookup-direct', { brand: 'Roland' }, r => r.error || (r.probed + ' probed, ' + r.recorded + ' recorded'));
$('lookup-korg').onclick = () => runBtn('lookup-korg', '/api/lookup-direct', { brand: 'Korg' }, r => r.error || (r.probed + ' probed, ' + r.recorded + ' recorded'));
$('behringer-btn').onclick = () => runBtn('behringer-btn', '/api/behringer', {}, r => r.error || (r.tried + ' tried, ' + r.recorded + ' recorded'));
$('rejudge-btn').onclick = () => runBtn('rejudge-btn', '/api/rejudge', {}, r => r.checked + ' checked, ' + r.dropped + ' would drop (dry run)');

get('/api/directory').then(d => {
  $('brand-list').innerHTML = d.brands.map(b => '<option value="' + esc(b.name) + '">').join('');
});

$('lookup').addEventListener('click', async () => {
  const name = $('brand-name').value.trim();
  if (!name) return;
  $('lookup').disabled = true;
  $('lookup-status').textContent = 'walking their support pages… this respects their crawl delay, so give it a moment';
  $('lookup-result').innerHTML = '';
  const d = await post('/api/lookup', { name, supportUrl: $('brand-url').value.trim() || null });
  $('lookup').disabled = false;
  $('lookup-status').textContent = '';
  PREVIEW = d;

  if (d.error) {
    $('lookup-result').innerHTML =
      '<div class="row" style="margin-top:12px"><span class="pill bad">could not read their site</span>' +
      (d.have && d.have.live ? '<span class="pill ok">' + d.have.live + ' already answering</span>' : '') +
      '</div><div class="muted" style="margin-top:8px">' + esc(d.error) + '</div>';
    return;
  }

  const rows = d.rows.slice(0, 300).map(r =>
    '<tr><td>' + esc(r.label) + (r.resolved ? '' : ' <span class="muted">(name guessed from the link)</span>') + '</td>' +
    '<td><span class="pill ' + (r.already === 'new' ? 'warn' : 'ok') + '">' +
      (r.already === 'new' ? 'we do not have this' : r.already === 'live' ? 'already answering' : 'listed, not answering') +
    '</span></td>' +
    '<td class="muted">' + esc(r.url.split('/').pop()).slice(0, 48) + '</td></tr>').join('');

  $('lookup-result').innerHTML =
    '<div class="row" style="margin-top:12px">' +
      '<span class="pill ok">' + d.have.live + ' answering</span>' +
      '<span class="pill bad">' + d.gaps + ' listed but cannot answer</span>' +
      '<span class="pill neutral">' + d.found + ' PDFs on their site</span>' +
      '<span class="pill ok">' + d.gapsFilled + ' of those gaps filled</span>' +
      '<span class="pill warn">' + (d.unfound || []).length + ' still unfound</span>' +
      (d.have.error ? '<span class="pill bad">library check failed: ' + esc(d.have.error) + '</span>' : '') +
    '</div>' +
    (d.missing ?
      '<div class="muted" style="margin-top:10px">Still unfound, by name: ' +
        esc((d.unfound || []).slice(0, 40).join(', ')) +
        ((d.unfound || []).length > 40 ? ' and ' + ((d.unfound || []).length - 40) + ' more' : '') + '</div>' +
      ((d.unmatchable || []).length ? '<div class="muted" style="margin-top:6px">' + (d.unmatchable || []).length +
        ' name(s) carry nothing distinctive enough to match on, so they are neither found nor missing: ' +
        esc((d.unmatchable || []).slice(0, 12).join(', ')) + '</div>' : '') +
      '<div class="row"><label class="muted"><input type="checkbox" id="tos"> I have read this manufacturer&#39;s terms and they do not forbid automated download</label>' +
      '<button class="go" id="adopt">Add the ' + d.missing + ' we do not have</button></div>' : '') +
    '<table>' + (rows || '<tr><td class="muted">Nothing found on those pages.</td></tr>') + '</table>';
});

document.addEventListener('click', async e => {
  if (!e.target.closest('#adopt')) return;
  if (!$('tos').checked) { alert('Confirm you have read their terms first.'); return; }
  const b = $('adopt'); b.disabled = true;
  const r = await post('/api/adopt', {
    brandName: PREVIEW.brandName, entrypoints: PREVIEW.entrypoints,
    rows: PREVIEW.rows, tosReviewed: true,
  });
  say(r.error ? ('failed: ' + r.error) : (PREVIEW.brandName + ': added ' + r.added + ' manual(s), ' + r.unresolved + ' need a name in the registry'));
  b.disabled = false;
  load();
});

$('q').addEventListener('input', () => { clearTimeout(window._t); window._t = setTimeout(loadDocs, 250); });
$('state').addEventListener('change', loadDocs);
load();
</script></body></html>`;

function json(res, body, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise(resolve => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    });
}

function start({ port = 7777, dbPath = null } = {}) {
    const db = manifest.open(dbPath);

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        try {
            if (url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(PAGE);
            }

            if (url.pathname === '/clicklist') {
                // Regenerated on every visit from the live coverage endpoint — the same
                // pool the admin reads — and the drop-map is written alongside so the
                // uploader always agrees with the page on what a filename means.
                const { html, dropMap } = await require('./clicklist-gen').build();
                const fsMod = require('fs');
                const pathMod = require('path');
                fsMod.writeFileSync(pathMod.join(__dirname, '..', 'drop-map.json'), JSON.stringify(dropMap, null, 1));
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(html);
            }

            if (url.pathname === '/api/state') {
                const brands = db.prepare(`
                    SELECT b.slug, b.state, b.blocked_reason,
                        (SELECT COUNT(*) FROM documents d WHERE d.brand_slug = b.slug) docs,
                        (SELECT COUNT(*) FROM documents d WHERE d.brand_slug = b.slug AND d.gear_name IS NULL) unmatched
                    FROM brands b ORDER BY docs DESC, b.slug
                `).all();
                const states = db.prepare('SELECT state, COUNT(*) c FROM documents GROUP BY state ORDER BY c DESC').all();
                const unmatched = db.prepare(`
                    SELECT DISTINCT COALESCE(NULLIF(link_text, ''), source_url) t
                    FROM documents WHERE gear_name IS NULL LIMIT 100
                `).all().map(r => r.t);
                const ready = db.prepare("SELECT COUNT(*) c FROM documents WHERE state='discovered' AND gear_name IS NOT NULL").get().c;
                return json(res, {
                    brands, states, unmatched, readyToHandOff: ready,
                    budgets: db.prepare('SELECT * FROM budgets ORDER BY key').all(),
                });
            }

            if (url.pathname === '/api/documents') {
                const q = (url.searchParams.get('q') || '').toLowerCase();
                const state = url.searchParams.get('state') || '';
                let rows = db.prepare('SELECT * FROM documents ORDER BY brand_slug, gear_name, id').all();
                if (q) rows = rows.filter(r => `${r.gear_name || ''} ${r.source_url}`.toLowerCase().includes(q));
                // A handed-off row is the receipt that stops the same URL being ingested
                // twice, so it is never deleted — the default view just hides it.
                const done = rows.filter(r => r.state === 'handed_off').length;
                if (state === 'outstanding') rows = rows.filter(r => r.state !== 'handed_off');
                else if (state) rows = rows.filter(r => r.state === state);
                return json(res, { total: rows.length, done, docs: rows.slice(0, 200) });
            }

            if (url.pathname === '/api/directory') {
                return json(res, { brands: lookup.directory().map(b => ({ name: b.name })) });
            }

            if (url.pathname === '/api/lookup' && req.method === 'POST') {
                const body = await readBody(req);
                const out = await lookup.preview(db, {
                    name: body.name,
                    supportUrls: body.supportUrl ? [body.supportUrl] : null,
                    log: () => {},
                });
                return json(res, out);
            }

            if (url.pathname === '/api/adopt' && req.method === 'POST') {
                const body = await readBody(req);
                return json(res, lookup.adopt(db, body));
            }

            if (url.pathname === '/api/hunt' && req.method === 'POST') {
                const body = await readBody(req);
                const lines = [];
                await require('./phases/hunt').run(db, {
                    top: Math.min(parseInt(body.top, 10) || 10, 45),
                    apply: true,
                    log: l => lines.push(String(l)),
                });
                await require('./phases/report').send(db, { lastRun: 'hunt (cockpit)', log: () => {} });
                return json(res, { log: lines.slice(-80) });
            }

            if (url.pathname === '/api/lookup-direct' && req.method === 'POST') {
                const body = await readBody(req);
                const r = await require('./phases/lookup-direct').run(db, {
                    brand: body.brand, limit: parseInt(body.limit, 10) || 25,
                });
                return json(res, r);
            }

            if (url.pathname === '/api/archive' && req.method === 'POST') {
                const body = await readBody(req);
                const r = await require('./phases/archive').run(db, {
                    brand: body.brand, limit: parseInt(body.limit, 10) || 15,
                });
                return json(res, r);
            }

            if (url.pathname === '/api/behringer' && req.method === 'POST') {
                const r = await require('./phases/behringer-api').run(db, { limit: 30 });
                return json(res, r);
            }

            if (url.pathname === '/api/rejudge' && req.method === 'POST') {
                const body = await readBody(req);
                const r = await require('./phases/rejudge').run(db, { apply: !!body.apply });
                return json(res, r);
            }

            if (url.pathname === '/api/discover' && req.method === 'POST') {
                const body = await readBody(req);
                const out = [];
                const result = await discover.run(db, {
                    only: body.brand || null, limit: body.brand ? 1 : 10,
                    log: line => out.push(line),
                });
                return json(res, { ...result, log: out });
            }

            if (url.pathname === '/api/handoff' && req.method === 'POST') {
                const body = await readBody(req);
                const out = [];
                const result = await handoff.run(db, {
                    limit: Math.min(body.limit || 10, 50), log: line => out.push(line),
                });
                return json(res, { ...result, log: out });
            }

            res.writeHead(404); res.end('not found');
        } catch (e) {
            json(res, { error: e.message }, 500);
        }
    });

    // Localhost only. This page has no auth because it should never be reachable.
    server.listen(port, '127.0.0.1', () => {
        console.log(`gear-crawler UI  →  http://127.0.0.1:${port}`);
        console.log('Localhost only, no authentication — do not expose this port.');
    });
    return server;
}

module.exports = { start };
