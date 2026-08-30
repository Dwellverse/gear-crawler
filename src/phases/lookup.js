/**
 * Brand lookup — type a company, see what we hold and what we do not, then fill the gap.
 *
 * Three questions in one call:
 *   1. what does the library already answer for this brand?   (asks the app)
 *   2. what does the manufacturer publish?                    (walks their support pages)
 *   3. which of those do we not have?                         (the difference)
 *
 * Nothing is written and nothing is fetched from a manufacturer until you say so: the
 * preview walks the site read-only, and adding the gap is a separate call. The terms
 * check stays with a person — the UI asks you to confirm you have read them before a
 * brand is saved, because a program cannot read a licence and mean it.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const manifest = require('../manifest');
const registry = require('../registry');
const strategies = require('../strategies');
const net = require('../net');

const DIRECTORY = path.join(__dirname, '..', '..', 'registry', 'directory.yaml');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function directory() {
    if (!fs.existsSync(DIRECTORY)) return [];
    return (YAML.parse(fs.readFileSync(DIRECTORY, 'utf8')).brands || []);
}

/** Find a company in the phone book, forgivingly ("allen heath" → "Allen & Heath"). */
function findInDirectory(name) {
    const q = norm(name);
    if (!q) return null;
    const all = directory();
    return all.find(b => norm(b.name) === q)
        || all.find(b => norm(b.name).startsWith(q) || q.startsWith(norm(b.name)))
        || all.find(b => norm(b.name).includes(q))
        || null;
}

/** What the library already answers for this brand, asked of the app. */
async function coverage(brandName) {
    const api = process.env.GEARPLUG_API;
    const key = process.env.GEARPLUG_INGEST_KEY;
    if (!api || !key) return { error: 'GEARPLUG_API or GEARPLUG_INGEST_KEY is not set.' };

    const res = await fetch(`${api}/admin/console/api/gear-coverage?brand=${encodeURIComponent(brandName)}`, {
        headers: { 'X-Ingest-Key': key },
    });
    if (!res.ok) return { error: `The app answered ${res.status}.` };
    const body = await res.json();
    return { gear: body.gear || [] };
}

/**
 * Walk the brand's support pages and report what is published, marked against what we
 * already hold. Read-only: it fetches the manufacturer's pages but writes nothing.
 */
async function preview(db, { name, homepage, supportUrls, log = () => {} }) {
    const known = findInDirectory(name);
    const brandName = (known && known.name) || name;
    const entrypoints = (supportUrls && supportUrls.length ? supportUrls : (known ? known.support : []))
        .filter(Boolean);

    if (!entrypoints.length) {
        return {
            brandName,
            error: `No support page known for "${brandName}". Paste one — usually the page listing manuals or downloads.`,
            directoryHit: !!known,
        };
    }

    // What we already answer for this brand
    const have = await coverage(brandName);
    const liveNames = new Set((have.gear || []).filter(g => g.state === 'live').map(g => norm(g.gearName)));
    const knownNames = new Set((have.gear || []).map(g => norm(g.gearName)));

    // What they publish. A throwaway brand shape — nothing is saved yet.
    const brand = {
        slug: norm(brandName), name: brandName,
        homepage: homepage || (known && known.homepage) || entrypoints[0],
        strategy: 'html_crawl',
        entrypoints,
        discovery: { follow_patterns: ['support', 'download', 'manual', 'product'], max_depth: 2, max_pages: 35 },
    };

    let found = [];
    try {
        found = await strategies.discover(db, brand, { log });
    } catch (e) {
        return { brandName, entrypoints, error: e.blocked ? `Blocked: ${e.message}` : e.message, have: have.gear || [] };
    }

    const models = registry.loadModels(brand.slug);
    const rows = found.map(f => {
        const filename = decodeURIComponent(new URL(f.url).pathname.split('/').pop() || '');
        const match = registry.matchModel(f.linkText, models) || registry.matchModel(filename, models);
        const guess = match ? registry.gearNameFor(brand, match.model) : null;
        // Without a model registry for this brand, fall back to the link text so the
        // preview is still useful — it is shown as a guess, and you can correct it.
        const label = guess || (f.linkText || filename).replace(/\.pdf$/i, '').trim();
        const key = norm(label);
        return {
            url: f.url,
            label,
            resolved: !!guess,
            already: liveNames.has(key) ? 'live' : knownNames.has(key) ? 'listed' : 'new',
        };
    });

    return {
        brandName,
        entrypoints,
        directoryHit: !!known,
        have: {
            live: (have.gear || []).filter(g => g.state === 'live').length,
            listed: (have.gear || []).length,
            error: have.error || null,
        },
        found: rows.length,
        missing: rows.filter(r => r.already === 'new').length,
        rows,
    };
}

/**
 * Save the brand and record the manuals we do not have.
 * `tosReviewed` must be true — that is a person saying they read the site's terms.
 */
function adopt(db, { brandName, homepage, entrypoints, rows, tosReviewed }) {
    if (!tosReviewed) throw new Error('Confirm you have read this manufacturer\'s terms before adding it.');
    const slug = norm(brandName);

    manifest.upsertBrand(db, { slug, name: brandName, priority: 1 });
    // Written so future runs use the same entry points, and so the terms review is on
    // the record rather than in someone's memory.
    const file = path.join(registry.REGISTRY_DIR, 'brands', `${slug}.yaml`);
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, YAML.stringify({
            slug, name: brandName, homepage: homepage || entrypoints[0],
            strategy: 'html_crawl',
            entrypoints,
            discovery: { follow_patterns: ['support', 'download', 'manual', 'product'], max_depth: 2, max_pages: 35 },
            tos_reviewed: true,
            tos_notes: `Confirmed in the crawler UI on ${new Date().toISOString().slice(0, 10)}.`,
            priority: 1,
        }));
    }

    let added = 0;
    for (const r of rows) {
        if (r.already !== 'new') continue;
        if (manifest.addDocument(db, {
            brandSlug: slug, url: r.url, linkText: r.label,
            gearName: r.resolved ? r.label : null,
        })) added++;
    }
    manifest.markBrandDiscovered(db, slug, added);
    return { slug, added, unresolved: rows.filter(r => r.already === 'new' && !r.resolved).length };
}

module.exports = { preview, adopt, directory, findInDirectory };
