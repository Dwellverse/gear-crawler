// A contact sheet of every resolved product photograph, so each one can be checked
// against the product it claims to be before any of it reaches the storefront.
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('.images.json', 'utf8'));

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const got = data.filter(d => d.image);
const missing = data.filter(d => !d.image);

const card = d => `
  <figure class="card">
    <div class="shot"><img src="${esc(d.image)}" alt="${esc(d.name)}" loading="lazy"></div>
    <figcaption>
      <strong>${esc(d.name)}</strong>
      <a href="${esc(d.page)}" target="_blank" rel="noopener noreferrer">${esc(new URL(d.page).hostname)}</a>
    </figcaption>
  </figure>`;

const html = `<title>Storefront Image Review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>
:root{--ground:#f2f3f5;--panel:#fff;--edge:#dcdfe5;--ink:#1a1d23;--ink-2:#5a6272;--ink-3:#858d9c;--accent:#b45309;--stop:#b91c1c;}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#141619;--panel:#1d2026;--edge:#31363e;--ink:#e8ebf0;--ink-2:#aeb6c2;--ink-3:#7b8492;--accent:#f0a848;--stop:#f87f7f;}}
:root[data-theme="dark"]{--ground:#141619;--panel:#1d2026;--edge:#31363e;--ink:#e8ebf0;--ink-2:#aeb6c2;--ink-3:#7b8492;--accent:#f0a848;--stop:#f87f7f;}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.55 'IBM Plex Sans',system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:30px 20px 70px}
h1{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:clamp(28px,5vw,42px);margin:0 0 6px}
h2{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:22px;margin:34px 0 12px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2)}
p.sub{color:var(--ink-2);max-width:64ch;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;margin-top:18px}
.card{margin:0;background:var(--panel);border:1px solid var(--edge);border-radius:11px;overflow:hidden}
.shot{aspect-ratio:4/3;background:#fff;display:flex;align-items:center;justify-content:center;padding:10px}
.shot img{max-width:100%;max-height:100%;object-fit:contain}
figcaption{padding:10px 12px;border-top:1px solid var(--edge);font-size:13.5px;display:flex;flex-direction:column;gap:3px}
figcaption a{color:var(--ink-3);text-decoration:none;font-size:12px}
figcaption a:hover{color:var(--accent)}
ul.miss{list-style:none;padding:0;margin:14px 0 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
ul.miss li{background:var(--panel);border:1px solid var(--edge);border-left:3px solid var(--stop);border-radius:8px;padding:9px 12px;font-size:14px}
ul.miss span{display:block;color:var(--ink-3);font-size:12.5px}
.count{font-family:'Barlow Condensed',sans-serif;font-size:15px;color:var(--ink-3);letter-spacing:.04em}
</style>
<div class="wrap">
<h1>Storefront Image Review</h1>
<p class="sub">Each photograph below was taken from the maker's own product page, via their
published sitemap and the <code>og:image</code> they chose to represent the product. Check that
every picture is the instrument named under it before these replace the emoji in the demo store.</p>

<h2>Resolved <span class="count">${got.length} of ${data.length}</span></h2>
<div class="grid">${got.map(card).join('')}</div>

<h2>Not resolved <span class="count">${missing.length}</span></h2>
<ul class="miss">${missing.map(d => `<li>${esc(d.name)}<span>${esc(d.why || 'unknown')}</span></li>`).join('')}</ul>
</div>
`;

fs.writeFileSync('.image-review.html', html);
console.log('wrote .image-review.html — ' + got.length + ' resolved, ' + missing.length + ' not');
