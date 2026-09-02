/**
 * Tell the admin panel what the crawler has been doing.
 *
 * The manifest lives in sqlite on Terra2 and the cockpit binds to localhost, so the
 * cloud can never query the live queue. Instead, every run ends by posting a snapshot —
 * state histogram, budgets, last-run description, yield — to the app, which stores it
 * for the admin's read-only crawler card. Stale is visible by design: the card shows
 * the snapshot's age, and an old snapshot honestly means the crawler has not run.
 */

const manifest = require('../manifest');

const API = () => process.env.GEARPLUG_API || 'https://gearplug.ai';
const KEY = () => process.env.GEARPLUG_INGEST_KEY || '';

function snapshot(db, { lastRun = '', yield: y = {} } = {}) {
    const states = {};
    db.prepare('SELECT state, COUNT(*) n FROM documents GROUP BY state').all()
        .forEach(r => { states[r.state] = r.n; });

    const budgets = {};
    try {
        db.prepare('SELECT key, cap, used FROM budgets').all()
            .forEach(r => { budgets[r.key] = { cap: r.cap, spent: r.used || 0 }; });
    } catch (e) { /* older schema — budgets stay empty */ }

    return { states, budgets, lastRun, yield: y };
}

async function send(db, { lastRun = '', yield: y = {}, log = console.log } = {}) {
    if (!KEY()) { log('report: GEARPLUG_INGEST_KEY not set — skipping'); return { skipped: true }; }
    const body = snapshot(db, { lastRun, yield: y });
    try {
        const res = await fetch(`${API()}/admin/console/api/crawler-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': KEY() },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        log(`report: snapshot posted (${Object.entries(body.states).map(([k, v]) => `${k}=${v}`).join(', ')})`);
        return { ok: true };
    } catch (e) {
        // A failed report never fails the run it is reporting on.
        log(`report: could not post snapshot (${e.message})`);
        return { error: e.message };
    }
}

module.exports = { snapshot, send };
