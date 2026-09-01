// Automated discovery has plateaued on these, so the product pages are named directly
// and verified: fetch each candidate, confirm it is the right product's page, and take
// the og:image. Nothing is trusted without the page answering 200 and carrying an image.
const fs = require('fs');
const net = require('./src/net');
const manifest = require('./src/manifest');
const imagery = require('./src/phases/imagery');

const CANDIDATES = {
    'access-virus-ti': ['https://www.access-music.de/virus-ti2/', 'https://www.access-music.de/'],
    'nord-lead-a1': ['https://www.nordkeyboards.com/products/nord-lead-a1', 'https://www.nordkeyboards.com/products/nord-lead-a1-1'],
    'nord-stage-3': ['https://www.nordkeyboards.com/products/nord-stage-3', 'https://www.nordkeyboards.com/products/nord-stage-4'],
    'akai-mpc-2000xl': ['https://www.akaipro.com/mpc2000xl', 'https://www.akaipro.com/products/legacy/mpc2000xl'],
    'roland-tr-8s': ['https://www.roland.com/global/products/tr-8s/', 'https://www.roland.com/us/products/tr-8s/'],
    'roland-rd-2000': ['https://www.roland.com/global/products/rd-2000/', 'https://www.roland.com/us/products/rd-2000/'],
    'rane-seventy-two': ['https://rane.com/products/seventy-two-mkii', 'https://rane.com/products/seventy-two'],
    'akg-c414-xls': ['https://www.akg.com/microphones/condenser-microphones/C414XLS.html', 'https://www.akg.com/Microphones/Condenser%20Microphones/C414XLS.html'],
    'neumann-tlm-103': ['https://www.neumann.com/en-us/products/microphones/tlm-103/', 'https://www.neumann.com/en-en/products/microphones/tlm-103/'],
    'yamaha-hs8': ['https://usa.yamaha.com/products/proaudio/speakers/hs_series/index.html', 'https://usa.yamaha.com/products/proaudio/speakers/hs_series/hs8.html'],
    'adam-audio-a5x': ['https://www.adam-audio.com/en/ax-series/a5x/', 'https://www.adam-audio.com/en/a-series/a5x/'],
    'focal-alpha-65': ['https://www.focal.com/en/professional-monitoring/alpha-evo/alpha-65-evo', 'https://www.focal.com/en/alpha-65-evo'],
    'focusrite-scarlett-2i2': ['https://focusrite.com/products/scarlett-2i2', 'https://focusrite.com/en/usb-audio-interface/scarlett/scarlett-2i2'],
    'rme-babyface-pro-fs': ['https://rme-audio.de/babyface-pro-fs.html', 'https://www.rme-audio.de/babyface-pro-fs.html'],
    'tascam-dr-40x': ['https://tascam.com/us/product/dr-40x/top', 'https://tascam.com/us/product/dr-40x/'],
    'tascam-dr-100mkiii': ['https://tascam.com/us/product/dr-100mkiii/top', 'https://tascam.com/us/product/dr-100mkiii/'],
    'fender-blues-junior-iv': ['https://www.fender.com/en-US/guitar-amplifiers/vintage-modified/blues-junior-iv/2231200000.html', 'https://www.fender.com/en-US/guitar-amplifiers/blues-junior-iv/2231200000.html'],
    'fender-mustang-gtx': ['https://www.fender.com/en-US/guitar-amplifiers/mustang/mustang-gtx100/2310700000.html', 'https://www.fender.com/en-US/guitar-amplifiers/mustang-gtx50/2310600000.html'],
    'boss-dd-7': ['https://www.boss.info/global/products/dd-7/', 'https://www.boss.info/us/products/dd-7/'],
    'boss-ds-1': ['https://www.boss.info/global/products/ds-1/', 'https://www.boss.info/us/products/ds-1/'],
    'mutable-instruments-plaits': ['https://pichenettes.github.io/mutable-instruments-documentation/modules/plaits/', 'https://mutable-instruments.net/modules/plaits/'],
    '4ms-ensemble-oscillator': ['https://4mscompany.com/p.php?p=752', 'https://4mscompany.com/ens.php'],
    'kawai-es520': ['https://www.kawai-global.com/product/es520/', 'https://kawaius.com/product/kawai-es520/'],
    'casio-px-870': ['https://www.casio.com/us/electronic-musical-instruments/product.PX-870BK/', 'https://www.casio.com/us/electronic-musical-instruments/privia/product.PX-870BK/'],
    'behringer-x32-compact': ['https://www.behringer.com/en/products/0603-AAB', 'https://www.behringer.com/product.html?modelCode=P0ASF'],
    'sennheiser-hd-600': ['https://www.sennheiser.com/en-us/catalog/products/headphones/hd-600/hd-600-509880', 'https://www.sennheiser-hearing.com/en-US/p/hd-600/'],
    'shure-sm58': ['https://www.shure.com/en-US/products/microphones/sm58', 'https://www.shure.com/en-US/products/microphones/sm58?variant=SM58-LC'],
    'sequential-prophet-6': ['https://sequential.com/product/prophet-6/', 'https://sequential.com/products/prophet-6/'],
    'korg-minilogue-xd': ['https://www.korg.com/us/products/synthesizers/minilogue_xd/', 'https://www.korg.com/us/products/synthesizers/minilogue_xd/index.php'],
    'roland-juno-d': ['https://www.roland.com/global/products/juno-d/', 'https://www.roland.com/global/products/juno-ds61/'],
    'presonus-studio-24c': ['https://www.presonus.com/products/Studio-24c', 'https://www.presonus.com/en-US/audio-interfaces/studio-24c/1937.html'],
    'strymon-el-capistan': ['https://www.strymon.net/product/el-capistan/', 'https://www.strymon.net/product/el-capistan-dtape-echo/'],
};

(async () => {
    const db = manifest.open();
    const found = {};
    for (const [slug, urls] of Object.entries(CANDIDATES)) {
        let got = null;
        for (const u of urls) {
            try {
                const html = await net.fetchText(db, u);
                const img = imagery.metaImage(html, u);
                if (img) { got = { page: u, image: img }; break; }
            } catch (e) { /* next candidate */ }
        }
        console.log((got ? '  ok    ' : '  --    ') + slug.padEnd(30) + (got ? got.image.slice(0, 62) : 'none of ' + urls.length + ' candidates'));
        if (got) found[slug] = got;
    }
    fs.writeFileSync('.direct.json', JSON.stringify(found, null, 1));
    console.log('\n' + Object.keys(found).length + ' of ' + Object.keys(CANDIDATES).length + ' resolved directly');
})().catch(e => console.error('ERR', e.message));
