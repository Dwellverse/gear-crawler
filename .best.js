// For products whose page we can name, take the best image on it rather than only the
// og:image — measuring each candidate instead of trusting the maker's social banner.
const fs = require('fs');
const sharp = require('../gearplug_webapp/functions/node_modules/sharp');
const net = require('./src/net');
const manifest = require('./src/manifest');
const imagery = require('./src/phases/imagery');

const PAGES = {
    'sequential-prophet-6': 'https://sequential.com/product/prophet-6/',
    'roland-juno-d': 'https://www.roland.com/global/products/juno-d/',
    'roland-rd-2000': 'https://www.roland.com/global/products/rd-2000/',
    'boss-dd-7': 'https://www.boss.info/global/products/dd-7/',
    'boss-ds-1': 'https://www.boss.info/global/products/ds-1/',
    'presonus-studio-24c': 'https://www.presonus.com/products/Studio-24c',
    'shure-sm58': 'https://www.shure.com/en-US/products/microphones/sm58',
    'arturia-keystep-pro': 'https://www.arturia.com/products/hybrid-synths/keystep-pro/overview',
    'arturia-beatstep-pro': 'https://www.arturia.com/products/hybrid-synths/beatstep-pro/overview',
    'behringer-x32-compact': 'https://www.behringer.com/en/products/0603-AAB',
};

const UA = 'GearPlug/1.0 (demo storefront imagery; dwellverse.io@gmail.com)';

async function measure(url) {
    try {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
        if (!r.ok) return null;
        if (!/^image\//.test(r.headers.get('content-type') || '')) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        const m = await sharp(buf).metadata();
        if (!m.width || !m.height) return null;
        const ratio = m.width / m.height;
        // Same bar the storefront applies: big enough, and not a page banner.
        if (m.width < 340 || ratio > 2.4 || ratio < 0.5) return null;
        return { url, width: m.width, height: m.height, area: m.width * m.height };
    } catch (e) { return null; }
}

(async () => {
    const db = manifest.open();
    const found = {};
    for (const [slug, page] of Object.entries(PAGES)) {
        let html;
        try { html = await net.fetchText(db, page); }
        catch (e) { console.log('  --    ' + slug.padEnd(28) + 'page: ' + String(e.message).slice(0, 34)); continue; }

        const cands = imagery.imageCandidates(html, page).slice(0, 25);
        const sized = [];
        for (const c of cands) {
            const m = await measure(c);
            if (m) sized.push(m);
            if (sized.length >= 8) break;
        }
        sized.sort((a, b) => b.area - a.area);
        const best = sized[0];
        console.log((best ? '  ok    ' : '  --    ') + slug.padEnd(28)
            + (best ? best.width + 'x' + best.height + '  ' + best.url.slice(0, 56)
                    : cands.length + ' candidates, none usable'));
        if (best) found[slug] = { page, image: best.url };
    }
    fs.writeFileSync('.best.json', JSON.stringify(found, null, 1));
    console.log('\n' + Object.keys(found).length + ' of ' + Object.keys(PAGES).length + ' resolved');
})().catch(e => console.error('ERR', e.message));
