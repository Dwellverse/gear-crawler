// Retry only the products that never resolved, with the walk seeded at product indexes.
const fs = require('fs');
const manifest = require('./src/manifest');
const imagery = require('./src/phases/imagery');
const prev = JSON.parse(fs.readFileSync('.images.json', 'utf8'));
const HOMEPAGE = require('./.homepages.json');

(async () => {
  const db = manifest.open();
  const out = [];
  for (const p of prev) {
    if (p.image) { out.push(p); continue; }
    const homepage = HOMEPAGE[p.brand];
    if (!homepage) { out.push(p); console.log('  --    ' + p.name + '  (no homepage)'); continue; }
    try {
      const hit = await imagery.findImage(db, { productName: p.name, brand: p.brand, homepage }, { sitemap: null });
      if (hit) { out.push({ ...p, ...hit, why: undefined }); console.log('  ok    ' + p.name.padEnd(34) + hit.image.slice(0, 56)); }
      else { out.push(p); console.log('  --    ' + p.name); }
    } catch (e) { out.push(p); console.log('  err   ' + p.name + '  ' + e.message.slice(0, 34)); }
  }
  fs.writeFileSync('.images.json', JSON.stringify(out, null, 1));
  console.log('\n' + out.filter(o => o.image).length + ' of ' + out.length + ' now have an image');
})().catch(e => console.error('ERR', e.message));
