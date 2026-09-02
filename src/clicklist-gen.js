/**
 * Regenerate clicklist.html from the LIVE coverage endpoint — the same data pool the
 * admin panel reads — so the human worklist can never drift from what the library
 * actually lacks. The first edition was built from a gap-report snapshot; three days of
 * filling, purging and deduplicating later, a quarter of its rows were already done.
 *
 * Run: node src/clicklist-gen.js     (needs GEARPLUG_API / GEARPLUG_INGEST_KEY in .env)
 */

const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const BRANDS = {
    // These four decline automated access; a person clicking their public search pages
    // is exactly the access they offer.
    Yamaha: g => `https://usa.yamaha.com/support/manuals/index.html?k=${encodeURIComponent(g)}`,
    Fender: g => `https://support.fender.com/hc/en-us/search?query=${encodeURIComponent(g + ' manual')}`,
    Boss:   g => `https://www.boss.info/global/products/${g.toLowerCase().replace(/^boss\s+/, '').replace(/[^a-z0-9]+/g, '-')}/`,
    Tascam: g => `https://duckduckgo.com/?q=${encodeURIComponent('site:tascam.com ' + g + ' manual')}`,
};
const fallback = (brand, g) => {
    const site = { Yamaha: 'usa.yamaha.com', Fender: 'fender.com', Boss: 'boss.info', Tascam: 'tascam.com' }[brand];
    return `https://duckduckgo.com/?q=${encodeURIComponent(`site:${site} ${g} manual`)}`;
};
const slug = g => g.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
    const dropMap = {};
    const sections = [];
    let total = 0;
    for (const brand of Object.keys(BRANDS)) {
        const res = await fetch(`${process.env.GEARPLUG_API}/admin/console/api/gear-coverage?brand=${encodeURIComponent(brand)}`, {
            headers: { 'X-Ingest-Key': process.env.GEARPLUG_INGEST_KEY },
        });
        const d = await res.json();
        const items = (d.gear || []).filter(g => g.state === 'no_file' || g.state === 'broken' || g.state === 'failed');
        total += items.length;
        const rows = items.map(g => {
            const file = slug(g.gearName) + '.pdf';
            dropMap[file] = { gearName: g.gearName, manufacturer: brand };
            return `<tr data-gear="${esc(g.gearName)}">
  <td><input type="checkbox" class="done"></td>
  <td><strong>${esc(g.gearName)}</strong></td>
  <td><a href="${esc(BRANDS[brand](g.gearName))}" target="_blank" rel="noopener">open ${esc(brand)} page</a>
      &nbsp;·&nbsp;<a href="${esc(fallback(brand, g.gearName))}" target="_blank" rel="noopener">search</a></td>
  <td><code>${esc(file)}</code></td>
</tr>`;
        }).join('\n');
        sections.push(`<h2>${esc(brand)} <span class="count">${items.length}</span></h2>
<table>
<tr><th></th><th>Gear</th><th>Where to look</th><th>Save the PDF as…</th></tr>
${rows}
</table>`);
    }

    fs.writeFileSync(path.join(__dirname, '..', 'drop-map.json'), JSON.stringify(dropMap, null, 1));

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>GearPlug click-list — the human hour</title>
<style>
  body { font: 15px/1.5 system-ui; margin: 0 auto; max-width: 900px; padding: 24px 20px 80px; background:#0e0e14; color:#d4d4dc; }
  h1 { font-size: 22px; } h2 { margin-top: 34px; font-size: 17px; }
  .count { background:#7c3aed; color:#fff; border-radius: 20px; font-size: 12px; padding: 2px 10px; vertical-align: 2px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color:#8b8b98; padding: 6px 8px; }
  td { padding: 7px 8px; border-top: 1px solid #23232e; }
  a { color:#a78bfa; } code { background:#1a1a24; padding: 2px 7px; border-radius: 6px; font-size: 12.5px; color:#7dd3a8; }
  tr.is-done { opacity: .38; } tr.is-done code { text-decoration: line-through; }
  #bar { position: sticky; top: 0; background:#0e0e14ee; padding: 10px 0; border-bottom: 1px solid #23232e; }
  #prog { font-weight: 700; color:#a78bfa; }
</style></head><body>
<div id="bar">GearPlug click-list · generated live from the library ${new Date().toISOString().slice(0, 10)} · <span id="prog"></span></div>
<h1>The human hour</h1>
<p>These manufacturers decline automated access, so their manuals need your hands: open a row's link,
download the <em>owner's manual</em> PDF, save it into one folder using the exact filename shown.
Checkboxes remember progress. When you're done (or bored):</p>
<p><code>node src/upload-drop.js &lt;your-folder&gt;</code> — ingests everything it can name, moves finished files to <code>done/</code>.</p>
${sections.join('\n')}
<script>
  const KEY = 'gp_clicklist_v2';
  const state = JSON.parse(localStorage.getItem(KEY) || '{}');
  const rows = [...document.querySelectorAll('tr[data-gear]')];
  const prog = () => {
    const done = rows.filter(r => r.classList.contains('is-done')).length;
    document.getElementById('prog').textContent = done + ' / ' + rows.length + ' done';
  };
  rows.forEach(r => {
    const g = r.dataset.gear, box = r.querySelector('.done');
    if (state[g]) { box.checked = true; r.classList.add('is-done'); }
    box.addEventListener('change', () => {
      state[g] = box.checked; r.classList.toggle('is-done', box.checked);
      localStorage.setItem(KEY, JSON.stringify(state)); prog();
    });
  });
  prog();
</script>
</body></html>`;
    fs.writeFileSync(path.join(__dirname, '..', 'clicklist.html'), html);
    console.log('clicklist.html regenerated: ' + total + ' rows, live from the coverage endpoint');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
