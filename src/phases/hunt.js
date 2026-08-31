/**
 * The hunt — work the gap list, brand by brand, worst first.
 *
 * The app's catalogue says which gear it lists but cannot answer about: 1,287 items
 * across 382 brands. This phase takes that ranking, walks each brand's site with the
 * page budget aimed at the models we are actually missing, and records only the
 * documents that fill a gap.
 *
 * It records nothing it cannot identify. An unnamed PDF added "just in case" becomes a
 * manual filed under the wrong machine two phases later, which is worse than the gap it
 * was meant to close.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const manifest = require('../manifest');
const registry = require('../registry');
const strategies = require('../strategies');
const gaps = require('./gaps');

const DIRECTORY = path.join(__dirname, '..', '..', 'registry', 'directory.yaml');
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function directory() {
    if (!fs.existsSync(DIRECTORY)) return [];
    return YAML.parse(fs.readFileSync(DIRECTORY, 'utf8')).brands || [];
}

/** Pull a brand's gaps to the front of the crawl frontier. */
function priorityFor(hunt) {
    const res = hunt.flatMap(g => g.codes.map(c => gaps.codeRegex(c)));
    return (url, linkText) => {
        const hay = (url + ' ' + (linkText || '')).toLowerCase();
        for (const re of res) if (re.test(hay)) return 2;
        // Manual and download pages beat everything else that is not a named gap.
        return /manual|download|support|document/i.test(hay) ? 1 : 0;
    };
}

/**
 * Hunt one brand. Returns what it found without deciding whether to keep it, so the
 * caller can run this read-only.
 */
async function huntBrand(db, entry, { maxPages = 200, maxDepth = 3, log = () => {} } = {}) {
    const brandName = entry.name;
    const known = directory().find(b => norm(b.name) === norm(brandName));

    if (known && known.unusable) {
        return { brandName, skipped: known.unusable, gaps: entry.missing };
    }
    const entrypoints = (known && known.support || []).filter(Boolean);
    if (!entrypoints.length) return { brandName, skipped: 'no_entrypoint', gaps: entry.missing };

    const cov = await gaps.coverageFor(brandName);
    if (cov.error) return { brandName, error: cov.error };
    const hunt = gaps.huntList(cov.gear || [], brandName);
    if (!hunt.length) return { brandName, gaps: 0, found: 0, fills: [] };

    const brand = {
        slug: norm(brandName), name: brandName,
        homepage: (known && known.homepage) || entrypoints[0],
        strategy: 'html_crawl',
        entrypoints,
        discovery: {
            follow_patterns: ['support', 'download', 'manual', 'product', 'document'],
            max_depth: maxDepth, max_pages: maxPages,
        },
    };

    let found = [];
    try {
        found = await strategies.discover(db, brand, { log, priority: priorityFor(hunt) });
    } catch (e) {
        return { brandName, error: e.blocked ? `blocked: ${e.message}` : e.message, gaps: hunt.length };
    }

    const fills = [];
    const seen = new Set();
    for (const f of found) {
        const hit = gaps.matchGap({ url: f.url, linkText: f.linkText }, hunt);
        if (!hit || seen.has(f.url)) continue;
        seen.add(f.url);
        fills.push({ url: f.url, gearName: hit.gap.gearName, code: hit.code, linkText: f.linkText || '' });
    }
    return {
        brandName, slug: brand.slug, entrypoints,
        gaps: hunt.length, found: found.length,
        fills,
        filled: new Set(fills.map(f => f.gearName)).size,
    };
}

/** Write a brand's gap-filling documents into the manifest, ready for handoff. */
function record(db, result) {
    if (!result.fills || !result.fills.length) return 0;
    manifest.upsertBrand(db, { slug: result.slug, name: result.brandName, priority: 1 });
    let added = 0;
    for (const f of result.fills) {
        if (manifest.addDocument(db, {
            brandSlug: result.slug, url: f.url, linkText: f.linkText, gearName: f.gearName,
        })) added++;
    }
    manifest.markBrandDiscovered(db, result.slug, added);
    return added;
}

/**
 * Work the ranked gap list. `apply` writes what it finds; without it this is a survey.
 */
async function run(db, { top = 10, maxPages = 200, maxDepth = 3, apply = false, log = console.log } = {}) {
    const all = await gaps.brandGaps();
    if (all.error) return { error: all.error };

    const dir = directory();
    const inDirectory = b => dir.some(d => norm(d.name) === norm(b.brand));
    const targets = all.brands.filter(b => b.missing > 0 && inDirectory(b)).slice(0, top);

    const out = [];
    let totalAdded = 0;
    for (const t of targets) {
        log(`
${t.brand} — ${t.missing} with no manual, ${t.live} answering`);
        const r = await huntBrand(db, { name: t.brand, missing: t.missing }, { maxPages, maxDepth, log: l => log('   ' + l) });
        if (r.skipped) log(`   skipped: ${r.skipped}`);
        else if (r.error) log(`   error: ${r.error}`);
        else {
            log(`   ${r.found} PDFs seen, ${r.filled} gap(s) filled`);
            if (apply) { const n = record(db, r); totalAdded += n; log(`   recorded ${n} new document(s)`); }
        }
        out.push(r);
    }
    return { targets: targets.length, results: out, added: totalAdded };
}

module.exports = { run, huntBrand, record, priorityFor, directory };
