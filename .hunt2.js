const manifest = require('./src/manifest');
const hunt = require('./src/phases/hunt');
(async () => {
  const db = manifest.open();
  for (const brand of ['Arturia', 'Korg']) {
    console.log('\n=== ' + brand + ' ===');
    const r = await hunt.huntBrand(db, { name: brand }, { maxPages: 220, maxDepth: 3, log: l => { if (/walked|robots/.test(l)) console.log('  ' + l.trim()); } });
    if (r.error) { console.log('  error:', r.error); continue; }
    if (r.skipped) { console.log('  skipped:', r.skipped); continue; }
    console.log('  gaps: ' + r.gaps + ' | PDFs seen: ' + r.found + ' | gaps filled: ' + r.filled);
    const n = hunt.record(db, r);
    console.log('  recorded ' + n + ' new document(s)');
    r.fills.slice(0, 14).forEach(f => console.log('    ' + f.gearName.padEnd(30) + decodeURIComponent(f.url.split('/').pop()).slice(0, 42)));
  }
})().catch(e => console.error('ERR', e.message));
