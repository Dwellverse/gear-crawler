/**
 * Re-judge everything the crawler has recorded but not yet handed off.
 *
 * Match rules get corrected as false positives turn up, and records written under an
 * older rule do not fix themselves. This re-runs the current matcher over every
 * discovered document and drops the ones that no longer hold — cheaper than a re-crawl,
 * and it means a rule fix reaches records that already exist rather than only future
 * ones. Handed-off documents are never touched: those are the dedup receipts.
 */

const gaps = require('./gaps');
const strategies = require('../strategies');
const versions = require('./versions');

async function run(db, { apply = false, log = console.log } = {}) {
    const rows = db.prepare(`
        SELECT id, brand_slug, gear_name, source_url, link_text
        FROM documents WHERE state = 'discovered' AND gear_name IS NOT NULL
    `).all();

    if (!rows.length) return { checked: 0, dropped: 0 };

    // One coverage call per brand, not per document.
    const byBrand = new Map();
    for (const r of rows) {
        if (!byBrand.has(r.brand_slug)) byBrand.set(r.brand_slug, []);
        byBrand.get(r.brand_slug).push(r);
    }

    let checked = 0;
    const drop = [];
    for (const [slug, docs] of byBrand) {
        // The manifest stores a slug; the catalogue is keyed by display name, which the
        // gear name carries as its prefix.
        const brandName = (docs[0].gear_name || '').split(' ')[0];
        const cov = await gaps.coverageFor(brandName);
        if (cov.error) { log(`  ${slug}: cannot check (${cov.error})`); continue; }
        const hunt = gaps.huntList(cov.gear || [], brandName);

        for (const d of docs) {
            checked++;
            // Re-apply every current rule, not just matching: the language and
            // document-type filters change too, and records written before a fix are
            // exactly the ones sitting in the queue waiting to be handed off.
            if (!strategies.wanted(d.source_url, d.link_text)) {
                drop.push({ ...d, why: 'no longer passes the document filters' });
                continue;
            }
            const hit = gaps.matchGap({ url: d.source_url, linkText: d.link_text }, hunt);
            if (!hit) {
                drop.push({ ...d, why: 'no longer matches any gap' });
            } else if (hit.gap.gearName !== d.gear_name) {
                drop.push({ ...d, why: `now matches ${hit.gap.gearName}` });
            }
        }
    }

    // Then drop revisions that a newer edition supersedes. Makers leave every version on
    // the page; ingesting four of them means four near-identical documents competing for
    // the same question, and an answer can come from a manual two revisions out of date
    // looking exactly as confident as the current one.
    const surviving = rows.filter(r => !drop.some(d => d.id === r.id));
    const byGear = new Map();
    for (const r of surviving) {
        if (!byGear.has(r.gear_name)) byGear.set(r.gear_name, []);
        byGear.get(r.gear_name).push(r);
    }
    const nameOf = r => strategies.publishedName(r.source_url);
    for (const [, docs] of byGear) {
        for (const sup of versions.supersededIds(docs, nameOf)) {
            drop.push({ ...sup.doc, why: `superseded by ${String(sup.newestName).slice(0, 42)}` });
        }
    }

    for (const d of drop) {
        log(`  drop  ${String(d.gear_name).padEnd(30)} ${decodeURIComponent(d.source_url.split('/').pop()).slice(0, 44)}  — ${d.why}`);
        if (apply) db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    }
    return { checked, dropped: drop.length, applied: apply };
}

module.exports = { run };
