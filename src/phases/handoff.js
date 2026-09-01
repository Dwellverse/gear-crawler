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

/**
 * Post one document, retrying only what is worth retrying.
 *
 * The app's own refusals arrive as 4xx and are final: a scanned PDF with no text layer,
 * a file over the size limit, a document the virus heuristic objects to. Retrying those
 * just burns the attempt counter until the document is given up on for the wrong reason.
 *
 * A 5xx is different. These come from Google's frontend, not the app — "the server
 * encountered an error and could not complete your request, please try again in 30
 * seconds" — and the documents behind them parse locally in under two seconds. Handing
 * the same PDF over a second time succeeds. So 5xx and network faults get three tries
 * with a widening gap, and everything else is reported as it stands.
 */
async function postOnce(doc) {
    const res = await fetch(`${API()}/admin/console/api/manuals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': KEY() },
        body: JSON.stringify({ url: doc.source_url, gearName: doc.gear_name, manufacturer: doc.brand_slug }),
    });
    // Read the body as text first. A 500 whose body is not JSON — a stack trace, an HTML
    // error page from the proxy — was being reported as the bare string "500 Internal
    // Server Error", which says nothing about which of fetch, scan, chunk or embed gave
    // way. The reason the server gives is the whole value of the response.
    const raw = await res.text();
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { /* not JSON; `raw` is the detail */ }

    if (!res.ok || body.error) {
        const detail = body.error || body.message
            || raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        const err = new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
        err.status = res.status;
        throw err;
    }
    return body;
}

const RETRY_DELAYS_MS = [30000, 60000];

async function handOne(db, doc) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await postOnce(doc);
        } catch (e) {
            // A 4xx is the app's considered answer; only infrastructure faults and
            // transport errors are worth asking again. `e.status` is absent when fetch
            // itself failed, which is also worth a retry.
            const retryable = e.status === undefined || e.status >= 500;
            if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw e;
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        }
    }
}

async function run(db, { limit = 20, dryRun = false, log = console.log } = {}) {
    if (!KEY() && !dryRun) throw new Error('GEARPLUG_INGEST_KEY is not set — the app will refuse the request.');

    // A manual we could not name is not handed over: the app would have to guess, and
    // guessing an identity is the bug this whole registry exists to prevent.
    const docs = manifest.documentsInState(db, 'discovered', limit, { namedOnly: true });

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
