/**
 * Phase 2 — handoff.
 *
 * The seam between the two programs, and deliberately the whole of it: a URL and a gear
 * name go to the app's intake endpoint, and the app does what it already does — fetch,
 * virus-scan, store, chunk, embed, and record truthfully what happened. Nothing about
 * retrieval is decided here, which is what lets either side be rewritten without touching
 * the other.
 */

const manifest = require('../manifest');

const API = () => process.env.GEARPLUG_API || 'https://gearplug.ai';
const KEY = () => process.env.GEARPLUG_INGEST_KEY || '';

async function handOne(db, doc) {
    const res = await fetch(`${API()}/admin/console/api/manuals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': KEY() },
        body: JSON.stringify({ url: doc.source_url, gearName: doc.gear_name, manufacturer: doc.brand_slug }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
}

async function run(db, { limit = 20, dryRun = false, log = console.log } = {}) {
    if (!KEY() && !dryRun) throw new Error('GEARPLUG_INGEST_KEY is not set — the app will refuse the request.');

    // A manual we could not name is not handed over: the app would have to guess, and
    // guessing an identity is the bug this whole registry exists to prevent.
    const docs = manifest.documentsInState(db, 'discovered', limit * 3)
        .filter(d => d.gear_name)
        .slice(0, limit);

    if (!docs.length) { log('Nothing ready to hand off.'); return { sent: 0, failed: 0 }; }

    let sent = 0, failed = 0;
    for (const doc of docs) {
        if (dryRun) { log(`  would send ${doc.gear_name}  <- ${doc.source_url.slice(0, 80)}`); continue; }

        const budget = manifest.budget(db, 'handoffs_total');
        if (budget.exhausted) { log(`handoff budget spent (${budget.cap}) — stopping cleanly`); break; }

        try {
            const r = await handOne(db, doc);
            manifest.spend(db, 'handoffs_total', 1);
            manifest.setDocumentState(db, doc.id, 'handed_off', {
                handed_off_at: manifest.now(), index_id: r.indexId || null,
                pages: r.pages || null, chunks: r.chunks || null,
            });
            sent++;
            log(`  ✓ ${doc.gear_name} — ${r.pages || '?'} pages, ${r.chunks || '?'} chunks`);
        } catch (e) {
            const { dead } = manifest.recordAttempt(db, doc.id, e.message);
            failed++;
            log(`  ✗ ${doc.gear_name} — ${e.message}${dead ? ' (giving up)' : ''}`);
        }
    }
    log(`\n${sent} handed off, ${failed} failed.`);
    return { sent, failed };
}

module.exports = { run, handOne };
