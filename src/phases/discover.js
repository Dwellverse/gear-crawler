/**
 * Phase 1 — discover.
 *
 * Walks a brand's support pages and records every manual URL it can prove exists. It
 * never constructs a URL: everything written here came out of a sitemap, a JSON payload
 * or an anchor on a page that was actually fetched.
 *
 * It also decides what each document will be *called*, using the model registry. A URL
 * whose model cannot be resolved is still recorded — with no gear name — and logged for
 * review. That is the opposite of the mistake the existing library made, where a
 * confident guess filed a MiniBrute 2 manual under "Arturia MiniBrute".
 */

const fs = require('fs');
const path = require('path');
const manifest = require('../manifest');
const registry = require('../registry');
const strategies = require('../strategies');
const net = require('../net');

const REPORTS = path.join(__dirname, '..', '..', 'reports');

function logUnmatched(entries) {
    if (!entries.length) return;
    fs.mkdirSync(REPORTS, { recursive: true });
    fs.appendFileSync(
        path.join(REPORTS, 'unmatched_models.jsonl'),
        entries.map(e => JSON.stringify({ ...e, at: manifest.now() })).join('\n') + '\n'
    );
}

/**
 * Discover one brand.
 * @returns {{found: number, added: number, unmatched: number, blocked?: string}}
 */
async function discoverBrand(db, brand, { dryRun = false, log = console.log } = {}) {
    log(`\n${brand.name || brand.slug}  [${brand.strategy}]`);
    const models = registry.loadModels(brand.slug);
    if (!models.length) log(`  no model registry — every find will be unmatched`);

    let candidates;
    try {
        candidates = await strategies.discover(db, brand, { log });
    } catch (e) {
        if (e.blocked && e.kind === 'robots') {
            if (!dryRun) manifest.blockBrand(db, brand.slug, 'blocked:robots', e.message);
            log(`  blocked by robots.txt — recorded, moving on`);
            return { found: 0, added: 0, unmatched: 0, blocked: 'robots' };
        }
        if (e.blocked) throw e;                   // budget: the runner decides
        log(`  discovery failed: ${e.message}`);
        return { found: 0, added: 0, unmatched: 0 };
    }

    if (!candidates.length) {
        if (!dryRun) manifest.blockBrand(db, brand.slug, 'blocked:no_index', 'no manual links found');
        log(`  nothing found — marked blocked:no_index for review`);
        return { found: 0, added: 0, unmatched: 0, blocked: 'no_index' };
    }

    let added = 0;
    const unmatched = [];
    for (const c of candidates) {
        // The link text is usually the product name; the filename is the fallback.
        const filename = decodeURIComponent(new URL(c.url).pathname.split('/').pop() || '');
        const match = registry.matchModel(c.linkText, models) || registry.matchModel(filename, models);
        const gearName = match ? registry.gearNameFor(brand, match.model) : null;

        if (!match) unmatched.push({ brand: brand.slug, url: c.url, linkText: c.linkText, filename });

        if (dryRun) {
            log(`  would add  ${gearName || '(unmatched)'}  <- ${c.url.slice(0, 90)}`);
            continue;
        }
        if (manifest.addDocument(db, {
            brandSlug: brand.slug, url: c.url, linkText: c.linkText, gearName,
        })) {
            added++;
            db.prepare('UPDATE documents SET model_slug = ?, model_confidence = ? WHERE source_url = ?')
                .run(match ? match.model.slug : null, match ? match.confidence : 0, c.url);
        }
    }

    if (!dryRun) {
        manifest.markBrandDiscovered(db, brand.slug, added);
        logUnmatched(unmatched);
    }
    log(`  ${candidates.length} manual link(s), ${added} new, ${unmatched.length} unmatched`);
    return { found: candidates.length, added, unmatched: unmatched.length };
}

async function run(db, { only = null, limit = 10, dryRun = false, log = console.log } = {}) {
    const configured = registry.loadBrands();
    for (const b of configured) {
        if (!dryRun) manifest.upsertBrand(db, b);
    }

    // The manifest decides who is eligible — a blocked brand is invisible here, not
    // merely skipped, so no code path can accidentally crawl it.
    const due = dryRun
        ? configured.filter(b => !only || b.slug === only).slice(0, limit)
        : manifest.brandsToDiscover(db, { only, limit })
            .map(row => configured.find(b => b.slug === row.slug))
            .filter(Boolean);

    if (!due.length) {
        log('No brands are due for discovery.');
        return { brands: 0, added: 0 };
    }

    let added = 0;
    for (const brand of due) {
        const res = await discoverBrand(db, brand, { dryRun, log });
        added += res.added;
    }
    return { brands: due.length, added };
}

module.exports = { run, discoverBrand };
