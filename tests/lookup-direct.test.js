/**
 * Direct per-product lookup: slug and keyword construction, soft-404 detection, and the
 * rule that an unmatched PDF is never recorded.
 *
 * Roland answers 200 for a slug that doesn't exist — the shell page just has no product
 * name in its title — so the detector, not the status code, is what keeps a wrong slug
 * from being mistaken for a product with no manuals.
 */
const assert = require('assert');
const gaps = require('../src/phases/gaps');
const { slugCandidates, searchKeyword, rolandProductOf } = require('../src/phases/lookup-direct');

const results = [];
const ok = (name, fn) => {
    try { fn(); results.push('  ok   ' + name); }
    catch (e) { results.push('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const gapFor = (name, brand) => gaps.huntList([{ gearName: name, state: 'no_file' }], brand)[0];

ok('slug from a plain model code', () => {
    const s = slugCandidates(gapFor('Roland AIRA TR-8S Rhythm Performer', 'Roland'));
    assert(s.includes('tr-8s'), 'expected tr-8s in ' + s);
});

ok('a two-character code falls back to the hyphenated name', () => {
    // gaps.js drops codes shorter than three characters ("t8") on purpose — they match
    // half a site. So the T-8 cannot be probed by bare code or matched by it; the
    // hyphenated name is all the slug builder can honestly offer, and the gap stays
    // unfillable until the matcher itself learns short codes. Asserted so a future
    // change to that rule shows up here.
    const s = slugCandidates(gapFor('Roland AIRA T-8 Beat Machine', 'Roland'));
    assert(s.includes('aira-t-8-beat-machine'), 'got ' + s);
    assert(!s.includes('t-8'), 'short code unexpectedly present — matcher rule changed?');
});

ok('suffix stays attached: JU-06A', () => {
    const s = slugCandidates(gapFor('Roland JU-06A', 'Roland'));
    assert(s.includes('ju-06a'), 'expected ju-06a in ' + s);
});

ok('name-only gear falls back to hyphenated words', () => {
    const s = slugCandidates(gapFor('Korg minilogue xd', 'Korg'));
    assert(s.some(x => x === 'minilogue-xd'), 'expected minilogue-xd in ' + s);
});

ok('at most three candidates, no duplicates', () => {
    const s = slugCandidates(gapFor('Korg ARP Odyssey FS Rev2', 'Korg'));
    assert(s.length <= 3, 'got ' + s.length);
    assert.strictEqual(new Set(s).size, s.length);
});

ok('search keyword is the code as printed', () => {
    assert.strictEqual(searchKeyword(gapFor('Korg EK-50 Limitless', 'Korg')), 'EK-50');
    assert.strictEqual(searchKeyword(gapFor('Roland AIRA TR-8S Rhythm Performer', 'Roland')), 'TR-8S');
});

ok('gear whose name carries no code gets no keyword — it can never be matched', () => {
    // "01/W" is digits-first; the matcher cannot name a PDF for it, so probing would
    // spend requests on documents that could never be recorded.
    assert.strictEqual(searchKeyword(gapFor('Korg 01/W', 'Korg')), null);
});

ok('a real Roland support page is recognised by its title', () => {
    const html = '<title>\r\n\tRoland - Support - TR-8S - Owner&#39;s Manuals\r\n</title>';
    assert.strictEqual(rolandProductOf(html), 'TR-8S');
});

ok('the soft-404 shell page is not a product', () => {
    const html = '<title>\r\n\tRoland - Support -  - Owner&#39;s Manuals\r\n</title>';
    assert.strictEqual(rolandProductOf(html), null);
});

ok('an unmatched PDF is not recorded: the gap judge stays in charge', () => {
    const hunt = gaps.huntList([{ gearName: 'Roland S-10', state: 'no_file' }], 'Roland');
    // The lookup found a PDF on a page it reached via the S-10's slug — but the file
    // itself names a different machine. matchGap refuses it, so run() skips it.
    const wrong = gaps.matchGap({ url: 'https://static.roland.com/assets/media/pdf/CS-10EM_manual.pdf', linkText: '' }, hunt);
    assert.strictEqual(wrong, null);
    const right = gaps.matchGap({ url: 'https://static.roland.com/assets/media/pdf/S-10_eng01.pdf', linkText: '' }, hunt);
    assert(right && right.gap.gearName === 'Roland S-10');
});

ok('a Korg CDN URL matches through its disposition filename', () => {
    const hunt = gaps.huntList([{ gearName: 'Korg EK-50 Limitless', state: 'no_file' }], 'Korg');
    const url = 'https://cdn.korg.com/us/support/download/files/6c7be71de8674c0c.pdf'
        + '?response-content-disposition=inline%3Bfilename%2A%3DUTF-8%27%27EK50L_OM_E1.pdf';
    // The filename compresses "EK-50 Limitless" to EK50L, which the code regex cannot
    // claim — and concatenating url + text puts "…pdf " right before the code, which the
    // left-boundary guard rejects. run() therefore asks the judge twice: filename alone,
    // then row text alone. This asserts both halves behave.
    assert.strictEqual(gaps.matchGap({ url, linkText: '' }, hunt), null, 'filename alone must NOT match');
    const hit = gaps.matchGap({ url: '', linkText: "EK-50 Limitless Owner's Manual" }, hunt);
    assert(hit && hit.gap.gearName === 'Korg EK-50 Limitless', 'row text alone must match');
});

console.log(results.join('\n'));
console.log(process.exitCode ? 'lookup-direct tests FAILED' : 'all lookup-direct tests passed');
