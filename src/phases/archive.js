/**
 * The Internet Archive strategy — for manufacturers that no longer exist.
 *
 * Ensoniq folded into E-mu in 1998, ARP closed in 1981, EMS survives as one man
 * repairing Synthis. There is no support page to walk: the html_crawl strategy is
 * structurally useless for these brands, yet the catalogue lists their gear and the
 * gaps are real. Their manuals live on archive.org, which hosts them legitimately and
 * welcomes automated access through a public JSON API.
 *
 * The identity rules are the same as everywhere else in this crawler, plus one that is
 * archive-specific: the Archive is a global corpus, not the brand's own site, so the
 * BRAND token must also appear on the item — "Mirage manual" alone may be about a car.
 * On elektron.se that check would be redundant; here it is the difference between
 * filing an Ensoniq manual and filing anything that shares a model word.
 */

const manifest = require('../manifest');
const net = require('../net');
const gaps = require('./gaps');

const SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA = 'https://archive.org/metadata/';
const DOWNLOAD = 'https://archive.org/download/';

/** Words that make a PDF a manual rather than a brochure, catalogue or magazine scan. */
const MANUAL_WORDS = /\b(manual|owner|owners|user|users|guide|instruction|instructions|reference|handbook)\b/i;
const SERVICE = /\bservice\b/i;

/**
 * A numeric-only model code — "2600", "Synthi 100". modelCodes() ignores these because
 * on a manufacturer's own site a bare number is too weak to claim identity. Here it is
 * usable, under two conditions applied by the caller: the number is at least three
 * digits, and the brand token is on the document. "ARP 2600" is unfillable without
 * this — its only identifying mark is the number.
 */
function numericCodes(gearName, brandName) {
    let s = String(gearName || '');
    const b = String(brandName || '');
    if (b && s.toLowerCase().startsWith(b.toLowerCase() + ' ')) s = s.slice(b.length + 1);
    const out = [];
    for (const m of s.matchAll(/(?<![a-z0-9])(\d{3,4})(?![a-z0-9])/gi)) {
        out.push({ key: m[1], letters: '', digits: m[1], suffix: '' });
    }
    return out;
}

/**
 * Identity check for an archive document.
 *
 * gaps.matchGap guards against a code being claimed out of a longer code — "RH-D20" is
 * not the D-20 — by refusing a match whose two preceding characters are alphanumeric
 * plus a separator. Archive identifiers are brand-prefixed ("ensoniq-esq-1-manual"),
 * so the brand word itself trips that guard: every occurrence of the model is preceded
 * by "ensoniq-" and nothing ever matches. On a manufacturer's site filenames start
 * with the model and the problem never arises.
 *
 * So the brand tokens are removed before matching — replaced with '/' rather than a
 * separator, so the guard sees a clean boundary, not brand-as-code-fragment. The model
 * boundary rules themselves stay exactly as gaps.js wrote them.
 */
function identify(doc, hunt, brandName) {
    const words = String(brandName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let hay;
    try { hay = decodeURIComponent(doc.url || ''); } catch (e) { hay = String(doc.url || ''); }
    hay = (hay + ' ' + (doc.linkText || '')).toLowerCase();
    for (const w of words) hay = hay.replace(new RegExp('(?<![a-z0-9])' + w + '(?![a-z0-9])', 'g'), '/');
    return gaps.matchGap({ url: '', linkText: hay }, hunt);
}

/** Does the brand appear on the document as a whole token? */
function brandOnDoc(hay, brandName) {
    const tokens = new Set(String(hay).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return String(brandName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        .every(w => tokens.has(w));
}

/**
 * The best manual among a gap's candidates.
 *
 * A service manual is schematics and calibration steps — the wrong document for a user
 * asking how to save a patch — so it is chosen only when nothing else exists, and the
 * choice is labelled so the report can say so. Among user-facing documents, the more
 * explicitly it names its purpose the better, and a bigger file beats a smaller one of
 * the same rank: the two-page "owner's registration card" scan loses to the manual.
 */
function pickBest(candidates) {
    if (!candidates.length) return null;
    const rank = c => (/\bowner/i.test(c.text) ? 3 : /\buser/i.test(c.text) ? 2 : 1);
    const users = candidates.filter(c => !SERVICE.test(c.text));
    const pool = users.length ? users : candidates;
    pool.sort((a, b) => (rank(b) - rank(a)) || ((b.size || 0) - (a.size || 0)));
    return { ...pool[0], serviceOnly: !users.length };
}

async function searchArchive(db, query) {
    const url = SEARCH
        + '?q=' + encodeURIComponent(query)
        + '&fl[]=identifier&fl[]=title&fl[]=mediatype&output=json&rows=30';
    const body = await net.fetchText(db, url);
    const json = JSON.parse(body);
    return ((json.response && json.response.docs) || []).filter(d => d.mediatype === 'texts');
}

async function itemPdfs(db, identifier) {
    const body = await net.fetchText(db, METADATA + encodeURIComponent(identifier));
    const json = JSON.parse(body);
    const files = (json.files || []).filter(f =>
        /\.pdf$/i.test(f.name || '')
        // The Archive derives a "_text.pdf" from its own OCR pass; when the original is
        // itself a PDF that derivative is a worse copy of a file we already take.
        && !/_text\.pdf$/i.test(f.name));
    const title = (json.metadata && json.metadata.title) || identifier;
    return { title, files };
}

/**
 * Hunt one dead brand through the Archive.
 *
 * For each gap: search, read the top items' file lists, and keep the one best PDF whose
 * identity survives the same matching the site crawl uses. Nothing is recorded on a
 * loose overlap — a wrong identity is worse than a gap.
 */
async function run(db, { brand, limit = 15, dryRun = false, log = console.log } = {}) {
    if (!brand) throw new Error('archive needs --brand');

    const cov = await gaps.coverageFor(brand);
    if (cov.error) return { brand, error: cov.error };
    const hunt = gaps.huntList(cov.gear || [], brand);
    if (!hunt.length) { log(`${brand}: no gaps`); return { brand, gaps: 0, recorded: 0 }; }

    // Gear whose only mark is a number — ARP 2600 — gets its numeric code here, where
    // the mandatory brand-token check makes it safe to use.
    for (const g of hunt) {
        if (!g.codes.length) g.codes = numericCodes(g.gearName, brand);
    }

    const brandSlug = gaps.norm(brand);
    manifest.upsertBrand(db, { slug: brandSlug, name: brand });

    const stats = {
        brand, gaps: hunt.length, searched: 0, items: 0, candidates: 0,
        recorded: 0, serviceOnly: 0,
        skips: { not_manual: 0, no_brand_token: 0, no_identity: 0, no_pdf: 0 },
    };
    const fills = [];
    const byGap = new Map();   // gearName -> candidates

    for (const g of hunt.slice(0, limit)) {
        const model = g.gearName.toLowerCase().startsWith(brand.toLowerCase() + ' ')
            ? g.gearName.slice(brand.length + 1) : g.gearName;
        let docs = [];
        try {
            docs = await searchArchive(db, `title:(${brand} ${model} manual) AND mediatype:texts`);
            // Archive titles are whatever the uploader typed: "Ensoniq Mirage Advanced
            // Sampler's Guide" never contains the word "manual" and the strict query
            // misses it. When the strict form finds nothing, ask again without it — the
            // per-file MANUAL_WORDS gate below still decides what counts as a manual.
            if (!docs.length) {
                docs = await searchArchive(db, `title:(${brand} ${model}) AND mediatype:texts`);
            }
        } catch (e) {
            log(`  search failed for ${g.gearName}: ${e.message}`);
            continue;
        }
        stats.searched++;

        for (const d of docs.slice(0, 4)) {
            let item;
            try { item = await itemPdfs(db, d.identifier); }
            catch (e) { continue; }
            stats.items++;
            if (!item.files.length) { stats.skips.no_pdf++; continue; }

            for (const f of item.files) {
                const text = item.title + ' ' + f.name;
                const url = DOWNLOAD + encodeURIComponent(d.identifier) + '/' + encodeURIComponent(f.name);

                if (!MANUAL_WORDS.test(text)) { stats.skips.not_manual++; continue; }
                if (!brandOnDoc(text + ' ' + d.identifier, brand)) { stats.skips.no_brand_token++; continue; }

                const m = identify({ url, linkText: text }, hunt, brand);
                if (!m) { stats.skips.no_identity++; continue; }

                stats.candidates++;
                const key = m.gap.gearName;
                if (!byGap.has(key)) byGap.set(key, []);
                byGap.get(key).push({ url, text, size: Number(f.size) || 0, gearName: key });
            }
        }
    }

    for (const [gearName, candidates] of byGap) {
        const best = pickBest(candidates);
        if (!best) continue;
        if (best.serviceOnly) stats.serviceOnly++;
        if (dryRun) {
            log(`  would record ${gearName}${best.serviceOnly ? ' (service manual — nothing better exists)' : ''}`
                + `  <- ${best.url.slice(0, 90)}`);
        } else {
            const added = manifest.addDocument(db, {
                brandSlug, url: best.url, linkText: best.text.slice(0, 200), gearName,
            });
            if (added) {
                stats.recorded++;
                fills.push(gearName);
                log(`  + ${gearName}${best.serviceOnly ? ' (service manual — nothing better exists)' : ''}`);
            }
        }
    }

    log(`${brand}: ${stats.gaps} gaps, ${stats.searched} searched, ${stats.candidates} candidates, `
        + `${dryRun ? byGap.size + ' would record' : stats.recorded + ' recorded'}`
        + (stats.serviceOnly ? ` (${stats.serviceOnly} service-only)` : ''));
    return { ...stats, fills };
}

module.exports = { run, identify, pickBest, brandOnDoc, numericCodes, MANUAL_WORDS, SERVICE };
