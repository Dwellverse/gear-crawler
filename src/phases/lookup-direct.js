/**
 * Direct per-product lookup — for brands whose support sites answer by product.
 *
 * The generic walk spends its page budget exploring; on a big catalogue it runs out
 * before reaching product #147's page. Roland and Korg both publish a page *per product*
 * behind a predictable front door, so this phase turns each gap's name into that door
 * and knocks: 3–6 polite requests per gap instead of a 200-page walk for the brand.
 *
 * The doors, verified by probing known products (TR-8S, minilogue, EK-50) on 2026-09-01:
 *
 *   Roland  GET /global/support/by_product/<slug>/owners_manuals/
 *           A wrong slug still answers 200, with an empty product name in the title —
 *           "Roland - Support -  - Owner's Manuals" — so a real product is detected by
 *           the title carrying a name, not by the status code. Each document on the list
 *           is a GUID sub-page, and the PDF itself sits in that page's data-path
 *           attribute (static.roland.com/assets/media/pdf/...), not in any href.
 *
 *   Korg    POST keyword=<code>&country=<cnt_id> to /tmp/support/download/dbaccess.php
 *           — the download page's own picker endpoint, one request per keyword. Rows
 *           come back as [href, date, type, productName, title, ...]; "Manuals" rows
 *           point at /us/support/download/manual/0/<pid>/<mid>/ pages, and the page
 *           holds the cdn.korg.com PDF whose disposition filename is the real name
 *           (EK50_OM_E5.pdf). cnt_id is read from the download page once per run.
 *
 * Identity is decided exactly where the hunt decides it: strategies.wanted() filters,
 * then gaps.matchGap() must name the gap a PDF fills. A PDF this module cannot name is
 * not recorded, however promising the page it came from.
 */

const manifest = require('../manifest');
const net = require('../net');
const gaps = require('./gaps');
const strategies = require('../strategies');

/** Candidate URL slugs for one gap, most specific first. At most three. */
function slugCandidates(gap) {
    const out = [];
    const seen = new Set();
    const push = s => { if (s && s.length >= 2 && !seen.has(s)) { seen.add(s); out.push(s); } };

    for (const c of gap.codes || []) {
        if (c.words) {
            // Name-only gear: "minilogue xd" -> minilogue-xd
            push(c.words.join('-'));
            continue;
        }
        // TR-8S -> tr-8s; JUNO-106 -> juno-106; JU-06A -> ju-06a
        push(c.letters + '-' + c.digits + (c.suffix || ''));
    }
    // The name minus the brand, hyphenated — catches pages named after the full
    // product ("fantom-06") rather than the bare code.
    const name = String(gap.gearName || '')
        .toLowerCase()
        .replace(/^[a-z]+ /, '')                 // drop the leading brand word
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    push(name);

    return out.slice(0, 3);
}

/** The keyword a person would type for this gap: the model code as printed. */
function searchKeyword(gap) {
    const c = (gap.codes || [])[0];
    if (!c) return null;
    if (c.words) return c.words.join(' ');
    return (c.letters + '-' + c.digits + (c.suffix || '')).toUpperCase();
}

/* ------------------------------------------------------------------ Roland */

const ROLAND_LIST = slug => `https://www.roland.com/global/support/by_product/${slug}/owners_manuals/`;

/** The product name the page believes it is about, or null for the soft-404 shell. */
function rolandProductOf(html) {
    const m = html.match(/<title>\s*Roland - Support - ([^<]*?) - Owner/i);
    const name = m && m[1].trim();
    return name || null;
}

async function rolandGap(db, gap, { log, spend }) {
    for (const slug of slugCandidates(gap)) {
        let html;
        try {
            html = await net.fetchText(db, ROLAND_LIST(slug));
        } catch (e) {
            if (e.blocked) throw e;
            continue;
        }
        spend();
        if (!rolandProductOf(html)) continue;              // shell page: wrong slug

        // Each document is a GUID sub-page; keep its link text, it names the document.
        const guids = [...html.matchAll(
            /href="([^"]*\/owners_manuals\/[0-9a-f-]{30,}\/)"[^>]*>([\s\S]{0,120}?)<\/a>/gi,
        )].map(m => ({
            url: new URL(m[1], ROLAND_LIST(slug)).toString(),
            text: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
        }));

        const found = [];
        for (const g of guids.slice(0, 4)) {                   // a gap needs one manual, not the archive
            let page;
            try {
                page = await net.fetchText(db, g.url);
            } catch (e) {
                if (e.blocked) throw e;
                continue;
            }
            spend();
            let paths = [...page.matchAll(/data-path="([^"]+\.pdf[^"]*)"/gi)].map(m => m[1]);
            // Roland marks the language as an infix: TR-8S_eng03_W is English and
            // JX-03_g02_W / _f02_ / _i02_ are the German, French and Italian editions —
            // one letter, invisible to the generic language filter. When an eng edition
            // is present keep only that; a single-letter edition is dropped regardless,
            // while unmarked names (MC-303_OM.pdf) pass because most older manuals are
            // English-only and carry no marker at all.
            const eng = paths.filter(u => /_e(?:ng)?\d+[_.]/i.test(u));   // eng03 and e01 are both English
            paths = eng.length ? eng : paths.filter(u => !/_[a-df-z]\d{2}[_.]/i.test(u));
            for (const u of paths) found.push({ url: u, linkText: g.text });
        }
        if (found.length) return { slug, found };
        // A real product page with no PDFs is an answer; trying more slugs would only
        // find a different product.
        return { slug, found: [] };
    }
    return { slug: null, found: [] };
}

/* -------------------------------------------------------------------- Korg */

const KORG_SEARCH = 'https://www.korg.com/tmp/support/download/dbaccess.php';
let korgCountry = null;

async function korgCountryId(db) {
    if (korgCountry) return korgCountry;
    const t = await net.fetchText(db, 'https://www.korg.com/us/support/download/');
    const m = t.match(/id="cnt_id"[^>]*value="([^"]+)"/) || t.match(/cnt_id[^>]{0,80}?value="([^"]+)"/);
    korgCountry = (m && m[1]) || '840';                    // 840 is the US row observed
    return korgCountry;
}

async function korgGap(db, gap, { log, spend }) {
    const keyword = searchKeyword(gap);
    if (!keyword) return { found: [] };

    const country = await korgCountryId(db);
    const res = await net.politeFetch(db, KORG_SEARCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'keyword=' + encodeURIComponent(keyword) + '&country=' + country,
    });
    spend();
    if (!res.ok) return { found: [] };

    let rows = [];
    try { rows = (JSON.parse(await res.text())[1]) || []; } catch (e) { /* not JSON: nothing found */ }

    // [href, date, type, productName, title, ...] — manuals only, junk out early.
    const candidates = rows
        .filter(r => r[2] === 'Manuals' && !strategies.REJECT.test((r[3] || '') + ' ' + (r[4] || '')))
        .map(r => ({
            page: new URL(r[0], 'https://www.korg.com/').toString(),
            text: ((r[3] || '') + ' ' + (r[4] || '')).trim(),
        }));

    const found = [];
    for (const c of candidates.slice(0, 4)) {
        let page;
        try {
            page = await net.fetchText(db, c.page);
        } catch (e) {
            if (e.blocked) throw e;
            continue;
        }
        spend();
        const m = page.match(/href="(https:\/\/cdn\.korg\.com\/[^"]+\.pdf[^"]*)"/i);
        if (m) found.push({ url: m[1], linkText: c.text });
    }
    return { found };
}

/* --------------------------------------------------------------------- run */

const BRANDS = {
    roland: { slug: 'roland', name: 'Roland', lookup: rolandGap },
    korg: { slug: 'korg', name: 'Korg', lookup: korgGap },
};

/**
 * Look up one brand's gaps directly. Returns what it found; `dryRun` records nothing.
 */
async function run(db, { brand, limit = 25, dryRun = false, log = console.log } = {}) {
    const b = BRANDS[String(brand || '').toLowerCase()];
    if (!b) return { error: `No direct lookup for "${brand}". Have: ${Object.keys(BRANDS).join(', ')}.` };

    const cov = await gaps.coverageFor(b.name);
    if (cov.error) return { error: cov.error };
    const hunt = gaps.huntList(cov.gear || [], b.name);
    if (!hunt.length) return { brand: b.name, gaps: 0, probed: 0, recorded: 0 };

    // The per-gap budget above keeps any one gap cheap; this keeps the run bounded.
    let requests = 0;
    const spend = () => { requests++; };

    let probed = 0, pdfsSeen = 0, recorded = 0;
    const fills = [], skipped = [];

    if (!dryRun) manifest.upsertBrand(db, { slug: b.slug, name: b.name, priority: 1 });

    for (const gap of hunt.slice(0, limit)) {
        probed++;
        let result;
        try {
            result = await b.lookup(db, gap, { log, spend });
        } catch (e) {
            if (e.blocked) { log(`  blocked: ${e.message}`); break; }
            log(`  ${gap.gearName}: ${e.message.slice(0, 80)}`);
            continue;
        }

        for (const f of result.found) {
            pdfsSeen++;
            if (!strategies.wanted(f.url, f.linkText)) continue;
            // The same judge the hunt uses — the whole hunt list, so a PDF that names a
            // *different* gap still lands on the right one. Filename first, then the
            // page's own label, asked separately: concatenated they defeat the matcher's
            // left-boundary guard, because "…_E1.pdf EK-50 Limitless" puts a word
            // character and a space right before the code — the exact shape the RH-D20
            // guard exists to reject. Korg's CDN names (EK50L_OM_E1.pdf) also compress
            // the name past recognition, so the row text is the identity there and the
            // filename is the tiebreak.
            const hit = gaps.matchGap({ url: f.url, linkText: '' }, hunt)
                || gaps.matchGap({ url: '', linkText: f.linkText }, hunt);
            if (!hit) { skipped.push(f.url.split('/').pop().slice(0, 60)); continue; }
            if (dryRun) {
                fills.push({ gearName: hit.gap.gearName, url: f.url });
                log(`  would record ${hit.gap.gearName}  <- ${f.url.slice(0, 90)}`);
            } else if (manifest.addDocument(db, {
                brandSlug: b.slug, url: f.url, linkText: f.linkText, gearName: hit.gap.gearName,
            })) {
                recorded++;
                fills.push({ gearName: hit.gap.gearName, url: f.url });
                log(`  + ${hit.gap.gearName}  <- ${f.url.split('/').pop().slice(0, 70)}`);
            }
        }
    }

    log(`\n${b.name}: ${probed} gap(s) probed, ${requests} requests, ${pdfsSeen} PDFs seen, `
        + `${recorded} recorded${dryRun ? ' (dry run)' : ''}, ${skipped.length} unmatched skipped`);
    if (skipped.length) log('  skipped e.g.: ' + skipped.slice(0, 5).join(', '));
    return { brand: b.name, gaps: hunt.length, probed, requests, pdfsSeen, recorded, fills, skipped };
}

module.exports = { run, slugCandidates, searchKeyword, rolandProductOf, BRANDS };
