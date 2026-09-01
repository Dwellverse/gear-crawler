/**
 * The Archive strategy's identity and selection rules, on fixtures — no network.
 *
 * The Archive is a global corpus, not a manufacturer's own site, so the stakes are
 * higher than for a site crawl: a loose match doesn't just file a manual under the
 * wrong machine, it can file a different manufacturer's document — or a car's — under
 * a synthesizer. These tests pin the rules that prevent that.
 */
const assert = require('assert');
const archive = require('../src/phases/archive');
const gaps = require('../src/phases/gaps');

const results = [];
const ok = (name, fn) => {
    try { fn(); results.push('  ok   ' + name); }
    catch (e) { results.push('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// ------------------------------------------------------------------ identity guards

const huntFor = names => gaps.huntList(names.map(n => ({ gearName: n, state: 'no_file' })), 'Ensoniq');

ok('an ESQ-1 manual does not fill the SQ-1 gap, nor the reverse', () => {
    const hunt = huntFor(['Ensoniq SQ-1', 'Ensoniq ESQ-1']);
    const esq = archive.identify({ url: 'https://archive.org/download/x/ensoniq-esq-1-manual.pdf', linkText: 'Ensoniq ESQ-1 manual' }, hunt, 'Ensoniq');
    assert.ok(esq && esq.gap.gearName === 'Ensoniq ESQ-1', 'ESQ-1 doc must resolve to ESQ-1');
    const sq = archive.identify({ url: 'https://archive.org/download/x/ensoniq-sq-1-manual.pdf', linkText: 'Ensoniq SQ-1 manual' }, hunt, 'Ensoniq');
    assert.ok(sq && sq.gap.gearName === 'Ensoniq SQ-1', 'SQ-1 doc must resolve to SQ-1');
});

ok('a numeric-only model works through numericCodes with the boundary rules intact', () => {
    const hunt = gaps.huntList([{ gearName: 'ARP 2600', state: 'no_file' }], 'ARP');
    assert.strictEqual(hunt[0].codes.length, 0, 'gaps.js alone cannot code a bare number');
    hunt[0].codes = archive.numericCodes('ARP 2600', 'ARP');
    assert.strictEqual(hunt[0].codes.length, 1);

    const hit = archive.identify({ url: 'https://archive.org/download/arp-2600-owners-manual/arp_2600_owners_manual.pdf', linkText: 'ARP 2600 Owners Manual' }, hunt, 'ARP');
    assert.ok(hit, 'the 2600 manual must match');
    // 12600 contains 2600 but is not the 2600.
    const miss = archive.identify({ url: 'https://archive.org/download/x/roland-12600-manual.pdf', linkText: 'Roland 12600 manual' }, hunt, 'ARP');
    assert.strictEqual(miss, null, 'an embedded 2600 must not match');
});

ok('the brand token is required — a Mirage that is not an Ensoniq is refused', () => {
    assert.strictEqual(archive.brandOnDoc('Nissan Mirage owners manual', 'Ensoniq'), false);
    assert.strictEqual(archive.brandOnDoc('Ensoniq Mirage musicians manual', 'Ensoniq'), true);
    // Token boundary: "ems" inside another word does not count.
    assert.strictEqual(archive.brandOnDoc('siemens synthi manual', 'EMS'), false);
    assert.strictEqual(archive.brandOnDoc('EMS Synthi AKS user manual', 'EMS'), true);
});

// ------------------------------------------------------------- document selection

ok('a user manual beats a service manual', () => {
    const best = archive.pickBest([
        { url: 'a', text: 'Ensoniq Mirage service manual', size: 9e6 },
        { url: 'b', text: 'Ensoniq Mirage musicians manual', size: 2e6 },
    ]);
    assert.strictEqual(best.url, 'b');
    assert.strictEqual(best.serviceOnly, false);
});

ok('a service manual is used only when nothing else exists, and says so', () => {
    const best = archive.pickBest([{ url: 'a', text: 'ARP Axxe service manual', size: 3e6 }]);
    assert.strictEqual(best.url, 'a');
    assert.strictEqual(best.serviceOnly, true);
});

ok('within the same rank, the larger file wins — the manual, not the warranty card', () => {
    const best = archive.pickBest([
        { url: 'small', text: 'Ensoniq SQ-80 owners registration', size: 120000 },
        { url: 'big', text: 'Ensoniq SQ-80 owners manual', size: 14e6 },
    ]);
    assert.strictEqual(best.url, 'big');
});

ok('owner outranks user outranks bare manual', () => {
    const best = archive.pickBest([
        { url: 'm', text: 'EMS Synthi manual', size: 9e6 },
        { url: 'o', text: 'EMS Synthi owners manual', size: 1e6 },
        { url: 'u', text: 'EMS Synthi user guide', size: 5e6 },
    ]);
    assert.strictEqual(best.url, 'o');
});

console.log(results.join('\n'));
console.log(process.exitCode ? 'archive tests FAILED' : 'all archive tests passed');
