// Resolve a maker photograph for every product in the demo storefront.
const fs = require('fs');
const manifest = require('./src/manifest');
const imagery = require('./src/phases/imagery');

const HOMEPAGE = {
    'Arturia': 'https://www.arturia.com', 'Elektron': 'https://www.elektron.se',
    'Moog': 'https://www.moogmusic.com', 'Roland': 'https://www.roland.com',
    'Allen & Heath': 'https://www.allen-heath.com', 'Boss': 'https://www.boss.info',
    'Korg': 'https://www.korg.com', 'Nord': 'https://www.nordkeyboards.com',
    'Akai': 'https://www.akaipro.com', 'Akai Professional': 'https://www.akaipro.com',
    'Teenage Engineering': 'https://teenage.engineering', 'Shure': 'https://www.shure.com',
    'Audio-Technica': 'https://www.audio-technica.com', 'Tascam': 'https://tascam.com',
    'Fender': 'https://www.fender.com', 'Sequential': 'https://sequential.com',
    'ASM': 'https://www.ashunsoundmachines.com', 'Access': 'https://www.access-music.de',
    'Novation': 'https://novationmusic.com', 'Rane': 'https://rane.com',
    'AKG': 'https://www.akg.com', 'Neumann': 'https://www.neumann.com',
    'Yamaha': 'https://usa.yamaha.com', 'ADAM': 'https://www.adam-audio.com',
    'Genelec': 'https://www.genelec.com', 'Focal': 'https://www.focal.com',
    'Focusrite': 'https://focusrite.com', 'RME': 'https://rme-audio.de',
    'PreSonus': 'https://www.presonus.com', 'Eventide': 'https://www.eventideaudio.com',
    'Chase Bliss': 'https://www.chasebliss.com', 'Mutable Instruments': 'https://mutable-instruments.net',
    'Erica Synths': 'https://www.ericasynths.lv', '4ms': 'https://4mscompany.com',
    'Ableton': 'https://www.ableton.com', 'Kawai': 'https://www.kawai-global.com',
    'Casio': 'https://www.casio.com', 'Strymon': 'https://www.strymon.net',
    'Electro-Harmonix': 'https://www.ehx.com', 'Behringer': 'https://www.behringer.com',
    'Sennheiser': 'https://www.sennheiser.com',
};

/** Longest brand name that prefixes this product name. */
function brandOf(name) {
    let best = null;
    for (const b of Object.keys(HOMEPAGE)) {
        if (name.toLowerCase().startsWith(b.toLowerCase()) && (!best || b.length > best.length)) best = b;
    }
    return best;
}

(async () => {
    const db = manifest.open();
    const products = JSON.parse(fs.readFileSync('.products.json', 'utf8'));
    const sitemaps = new Map();
    const out = [];

    for (const p of products) {
        const brand = brandOf(p.name);
        if (!brand) { out.push({ ...p, why: 'no homepage known' }); console.log('  --    ' + p.name); continue; }
        const homepage = HOMEPAGE[brand];

        if (!sitemaps.has(homepage)) {
            const locs = await imagery.fetchSitemap(db, homepage);
            sitemaps.set(homepage, locs.length ? await imagery.expand(db, locs) : []);
            console.log('[' + brand + '] sitemap: ' + sitemaps.get(homepage).length + ' urls');
        }
        // No sitemap is not the end: findImage falls back to walking the maker's site.
        const pages = sitemaps.get(homepage);

        try {
            const hit = await imagery.findImage(db, { productName: p.name, brand, homepage },
                { sitemap: pages.length ? pages : null });
            if (hit) { out.push({ ...p, brand, ...hit }); console.log('  ok    ' + p.name.padEnd(34) + hit.image.slice(0, 60)); }
            else { out.push({ ...p, brand, why: 'no product page matched' }); console.log('  --    ' + p.name + '  (no match)'); }
        } catch (e) {
            out.push({ ...p, brand, why: e.message.slice(0, 60) });
            console.log('  err   ' + p.name + '  ' + e.message.slice(0, 40));
        }
    }

    fs.writeFileSync('.images.json', JSON.stringify(out, null, 1));
    const got = out.filter(o => o.image).length;
    console.log('\n' + got + ' of ' + products.length + ' resolved to a maker photograph');
})().catch(e => console.error('ERR', e.message));
