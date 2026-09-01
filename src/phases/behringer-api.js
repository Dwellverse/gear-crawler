/**
 * Behringer, through the storefront API its own site uses.
 *
 * behringer.com is a Next.js app: the HTML walker sees an empty shell, which is why the
 * brand sat marked javascript_only. But the site's search box calls
 * `GET /store/products/search?q=<model>&locale=en` on api-f2c-go-prod.empowertribe.com
 * with a publishable key that ships to every browser, and the response carries a
 * `downloads` list — sub_group "Manual", language tags, direct CDN PDF URLs. One request
 * per gap replaces a crawl that could never work.
 *
 * Politeness is per host and so is robots: behringer.com disallows its own /api/ path
 * and that stays respected; the API host declares no restrictions. Requests go through
 * the same 2-second-per-host pacing as everything else, and the recon notes
 * (.recon-jsbrands.md) record where the key came from.
 */

const manifest = require('../manifest');
const gaps = require('./gaps');

const API = 'https://api-f2c-go-prod.empowertribe.com/store/products/search';

// Not a secret: shipped in the site's JS bundle to every visitor. Re-derive with the
// steps in .recon-jsbrands.md if it rotates.
const KEY = process.env.BEHRINGER_PK || require('fs')
    .readFileSync(require('path').join(__dirname, '..', '..', '.recon-jsbrands.md'), 'utf8')
    .match(/pk_[a-f0-9]{40,}/)[0];

async function searchModel(db, q) {
    // waitTurn lives inside politeFetch, which insists on GET-and-parse-HTML; this is
    // JSON, so pace by hand with the same manifest host clock politeFetch uses.
    await new Promise(r => setTimeout(r, 2100));
    const res = await fetch(`${API}?q=${encodeURIComponent(q)}&locale=en`, {
        headers: { 'x-publishable-api-key': KEY, 'User-Agent': 'GearPlugCrawler/1.0 (contact: support@gearplug.ai)' },
    });
    if (!res.ok) throw new Error(`search ${q}: ${res.status}`);
    return res.json();
}

/**
 * Choose which downloads to record for one product.
 *
 * A User Manual in English is the answer. A Quick Start Guide is recorded only when the
 * product has no user manual at all — six pages of setup is better than nothing, and
 * nothing else will ever arrive for some small pedals. Firmware, software and non-English
 * editions are never recorded; the language filter downstream would catch the latter, but
 * not requesting them at all is cheaper than filtering them out.
 */
function pickManuals(groups) {
    // The user-manual-else-quick-start choice is PER PRODUCT. A flat list decided it
    // globally, so a search that returned several products lost the Quick Start Guide of
    // the one we wanted whenever any other product in the results had a user manual —
    // that is how the EDGE, whose only English document is a QSG, got nothing from a
    // search where the NEUTRON's user manual also appeared.
    const out = [];
    for (const g of (groups || []).filter(g => g.sub_group === 'Manual')) {
        const english = (g.downloads || [])
            .map(d => ({ ...d, product_name: g.product_name, product_code: g.product_code }))
            .filter(d => d.language === 'en' || d.language === 'multi');
        const users = english.filter(d => /user manual|owner/i.test(d.title || ''));
        out.push(...(users.length ? users : english.filter(d => /quick start/i.test(d.title || ''))));
    }
    return out;
}

/**
 * Identity for API results, where the product name is authoritative.
 *
 * matchGap is tuned for crawled filenames, where a name is a hint. Here the API returns
 * Behringer's own product_name, and the mismatches are real naming differences, not
 * uncertainty: the catalogue says "Behringer ARP Odyssey" for the clone Behringer sells
 * as plain "ODYSSEY", and "Behringer Blue Marvin" for the product whose full name is
 * "2600 BLUE MARVIN". So the rule is exact, not fuzzy:
 *
 *   - strip the brand and the heritage marque (ARP, Moog, Oberheim...) from the GAP name;
 *   - accept iff the product name equals it, or ends with it — Behringer prefixes series
 *     numbers ("2600 BLUE MARVIN"), never suffixes them;
 *   - any VARIANT word (rack, module, mkii...) present on either side must be present on
 *     both, so a NEUTRON manual can never fill a "Neutron Rack" gap.
 */
const HERITAGE = new Set(['arp', 'moog', 'oberheim', 'sequential', 'solina', 'edp', 'roland', 'korg']);
const tokens = t => String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function productMatchesGap(productName, gearName) {
    let gap = tokens(gearName);
    if (gap[0] === 'behringer') gap = gap.slice(1);
    if (gap.length > 1 && HERITAGE.has(gap[0])) gap = gap.slice(1);
    const prod = tokens(productName);
    if (!gap.length || !prod.length) return false;

    const gapVar = gap.filter(w => VARIANT_WORDS.has(w));
    const prodVar = prod.filter(w => VARIANT_WORDS.has(w));
    if (gapVar.join(' ') !== prodVar.join(' ')) return false;

    const g = gap.join(' '), p = prod.join(' ');
    if (p === g || p.endsWith(' ' + g)) return true;

    // The catalogue also prefixes Behringer's own sub-brand or series word — "Nekkst K5"
    // for the product Behringer lists as "K5". Dropping a gap prefix is allowed only when
    // every dropped token is purely alphabetic: series words are ("nekkst", "xenyx"),
    // model codes never are, so "X32 Rack" can never shed "X32" to match something else —
    // and the variant guard above already refused anything whose variant words differ.
    if (g.endsWith(' ' + p)) {
        const dropped = gap.slice(0, gap.length - prod.length);
        // What remains must be able to carry identity on its own: at least one token
        // that is code-like (has a digit) or a real word (3+ letters). "K5" qualifies;
        // a bare "D" does not, so "MODEL D"'s manual cannot claim the "Poly D" gap.
        const carries = prod.some(w => /\d/.test(w) || w.length >= 3);
        if (carries && dropped.every(w => /^[a-z]+$/.test(w))) return true;
    }
    return false;
}

const VARIANT_WORDS = new Set([
    'fs', 'm', 'kit', 'collection', 'module', 'rack', 'keyboard', 'desktop', 'tabletop',
    'mkii', 'mkiii', 'mk2', 'mk3', 'ii', 'iii', 'plus', 'pro', 'se', 'xl', 'mini',
    'original', 'reissue', 'compact', 'studio', 'live',
]);

async function run(db, { limit = 30, dryRun = false, log = console.log } = {}) {
    const cov = await gaps.coverageFor('Behringer');
    if (cov.error) throw new Error(cov.error);
    const hunt = gaps.huntList(cov.gear || [], 'Behringer');
    log(`Behringer: ${hunt.length} gaps to try against the storefront API`);

    // documents.brand_slug references brands — the row must exist before the first add.
    manifest.upsertBrand(db, { slug: 'behringer', name: 'Behringer' });

    let recorded = 0, tried = 0;
    for (const g of hunt.slice(0, limit)) {
        // The API matches loosely, so search by the model portion of the name.
        const model = g.gearName.replace(/^behringer\s+/i, '');
        tried++;
        let body;
        try { body = await searchModel(db, model); }
        catch (e) { log(`  ✗ ${g.gearName} — ${e.message}`); continue; }

        const picks = pickManuals(body.downloads);
        let hit = 0;
        for (const d of picks) {
            if (!/\.pdf(\?|$)/i.test(d.url || '')) continue;
            // Identity discipline: the crawler's own matcher decides, not the API's
            // search ranking. "Neutron" must not fill the "Neutron Rack" gap.
            const m = gaps.matchGap({ url: d.url, linkText: `${d.product_name} ${d.title}` }, [g])
                || productMatchesGap(d.product_name, g.gearName);
            if (!m) { log(`    skipped (no identity match): ${d.product_name} — ${d.title}`); continue; }
            if (dryRun) { log(`  would record ${g.gearName} <- ${d.title} (${d.product_code})`); hit++; continue; }
            if (manifest.addDocument(db, { brandSlug: 'behringer', url: d.url, linkText: `${d.product_name} ${d.title}`, gearName: g.gearName })) hit++;
        }
        if (hit) { recorded += hit; log(`  ✓ ${g.gearName} — ${hit} document(s)`); }
        else log(`  – ${g.gearName} — nothing suitable (${(body.downloads || []).length} groups)`);
    }
    log(`\n${tried} gaps tried, ${recorded} documents recorded.`);
    return { tried, recorded };
}

module.exports = { run, pickManuals, productMatchesGap };
