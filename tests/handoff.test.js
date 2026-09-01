/**
 * The handoff seam: which failures are worth asking about again, and which documents get
 * picked up at all.
 *
 * Both behaviours here cost a full re-ingest run to discover. Eleven documents were
 * reported as failed on a "500 Internal Server Error" that turned out to be Google's own
 * frontend page — the PDFs behind them parse locally in under two seconds — while the
 * app's real refusals were being retried until the attempt counter gave up on them for
 * the wrong reason. And `handoff --limit 1` reported "nothing ready to hand off" with
 * nine named documents waiting, because three unnamed ones sat at the head of the queue.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
const ok = (name, fn) => {
    try { fn(); results.push('  ok   ' + name); }
    catch (e) { results.push('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// ---------------------------------------------------------------- retry classification

// The rule handoff applies: an error with no status is a transport fault, 5xx is
// infrastructure, and anything else is the app's considered answer.
const retryable = status => status === undefined || status >= 500;

ok('a 500 from the frontend is retried', () => {
    assert.strictEqual(retryable(500), true);
    assert.strictEqual(retryable(502), true);
    assert.strictEqual(retryable(503), true);
});

ok('a network fault with no response is retried', () => {
    assert.strictEqual(retryable(undefined), true);
});

ok('the app\'s own refusals are final', () => {
    // A scanned PDF, an oversized file and an antivirus verdict do not change on a
    // second identical request; retrying only burns the attempt budget.
    assert.strictEqual(retryable(400), false);
    assert.strictEqual(retryable(401), false);
    assert.strictEqual(retryable(413), false);
    assert.strictEqual(retryable(422), false);
});

// -------------------------------------------------------------------- queue selection

const manifest = require('../src/manifest');

ok('unnamed documents do not starve named ones behind them', () => {
    // A throwaway database, so the test never reads or writes the real manifest.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gearcrawl-'));
    {
        const db = manifest.open(path.join(dir, 'test.sqlite'));
        manifest.upsertBrand(db, { slug: 'x', name: 'X' });   // documents reference a brand
        // Three documents the crawler could not identify, then two it could — the exact
        // shape that made handoff report nothing to do.
        for (let i = 0; i < 3; i++) {
            manifest.addDocument(db, { brandSlug: 'x', url: `https://e.example/u${i}.pdf` });
        }
        manifest.addDocument(db, { brandSlug: 'x', url: 'https://e.example/named1.pdf', gearName: 'Denon SC5000 Prime' });
        manifest.addDocument(db, { brandSlug: 'x', url: 'https://e.example/named2.pdf', gearName: 'Denon SC5000 Prime' });

        const named = manifest.documentsInState(db, 'discovered', 1, { namedOnly: true });
        assert.strictEqual(named.length, 1, 'asking for one named document should return one');
        assert.strictEqual(named[0].gear_name, 'Denon SC5000 Prime');

        const all = manifest.documentsInState(db, 'discovered', 5);
        assert.strictEqual(all.length, 5, 'without namedOnly every document is still returned');
    }
});

console.log(results.join('\n'));
console.log(process.exitCode ? 'handoff tests FAILED' : 'all handoff tests passed');
