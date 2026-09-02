/**
 * Gap matching decides whether a PDF we found is the manual for a piece of gear we
 * cannot answer about. Getting this wrong is worse than finding nothing: a mislabelled
 * manual answers confidently about the wrong machine.
 *
 * Every false positive below was produced by a real Roland crawl before the matcher
 * required whole-token boundaries.
 */
const assert = require('assert');
const gaps = require('../src/phases/gaps');

const hunt = brand => gaps.huntList([
    { gearName: 'Roland S-10', state: 'no_file' },
    { gearName: 'Roland S-50', state: 'no_file' },
    { gearName: 'Roland MC-707', state: 'no_file' },
    { gearName: 'Roland D-20', state: 'no_file' },
    { gearName: 'Roland D-70', state: 'no_file' },
    { gearName: 'Roland AIRA TR-8S Rhythm Performer', state: 'no_file' },
    { gearName: 'Roland JUNO-106', state: 'live' },
], brand || 'Roland');

const CASES = [
    // --- the false positives that shipped, and must never come back --------------
    ['CS-10EM_je01.pdf', null, 'S-10 must not match inside CS-10EM'],
    ['JC-120H_OM.pdf', null, 'S-10 must not match inside JC-120H'],
    ['AT-50_-70_e_70343801.pdf', null, 'no code here'],
    ['MP-600_e_17047292.pdf', null, 'no code here'],
    ['DS-50A_e1.pdf', null, 'S-50 must not match inside DS-50A'],
    ['S-100_manual.pdf', null, 'S-10 must not match the longer S-100'],
    ['general_catalogue.pdf', null, 'nothing to match'],
    ['RH-D20_je1.pdf', null, 'D-20 must not match inside the RH-D20 headphones'],
    ['SC-D70_e1.pdf', null, 'D-70 must not match inside the SC-D70 module'],
    // --- the ones that must match -----------------------------------------------
    ['S-10_owners_manual.pdf', 'Roland S-10', 'the real S-10'],
    ['s10_e.pdf', 'Roland S-10', 'separators are optional'],
    ['mc707_eng01.pdf', 'Roland MC-707', 'MC-707 without the dash'],
    ['tr-8s_eng02_W.pdf', 'Roland AIRA TR-8S Rhythm Performer', 'code with a letter suffix'],
];

let failed = 0;
for (const [file, want, why] of CASES) {
    const m = gaps.matchGap({ url: 'https://example.com/' + file, linkText: '' }, hunt());
    const got = m ? m.gap.gearName : null;
    try {
        assert.strictEqual(got, want);
        console.log('  ok   ' + file.padEnd(28) + why);
    } catch (e) {
        failed++;
        console.log('  FAIL ' + file.padEnd(28) + 'expected ' + want + ', got ' + got);
    }
}

// Gear already answering is never a target.
assert.ok(!hunt().some(g => g.gearName === 'Roland JUNO-106'), 'live gear must not be hunted');
console.log('  ok   live gear is excluded from the hunt list');

// Names with no distinctive token are reported, not guessed at.
const vague = gaps.modelCodes('Moog One', 'Moog');
assert.strictEqual(vague.codes.length, 0, '"Moog One" is too generic to match on');
console.log('  ok   "Moog One" yields no key rather than matching everything');

// Variants of the same model code are different instruments. Every case here was
// recorded as a real match by a Korg hunt before the variant guard existed.
const korg = gaps.huntList([
    { gearName: 'Korg ARP 2600 FS', state: 'no_file' },
    { gearName: 'Korg Collection MS-20', state: 'no_file' },
    { gearName: 'Korg ARP Odyssey', state: 'no_file' },
], 'Korg');
const noMatch = (linkText, file) =>
    assert.strictEqual(gaps.matchGap({ url: 'https://cdn.korg.com/' + file, linkText }, korg), null);

noMatch('ARP 2600 M Blank Sheet', 'ARP2600-M_BlankSheet.pdf');      // the M, not the FS
noMatch('ARP 2600 Original Manual', 'ARP2600_Original_OM.pdf');     // the original, not the FS
noMatch("MS-20 Kit Original Owner's Manual", 'MS20_E.pdf');         // the Kit, not the Collection
noMatch('MS-20 Kit Patch Book', 'MS20_PatchBook.pdf');              // the Kit, not the Collection
console.log('  ok   model variants (FS / M / Kit / Collection) are kept apart');

// A name is only this machine's name if nothing more specific follows it. Every case
// here was recorded as a real match by an Arturia hunt: the BeatStep claimed the
// BeatStep Pro's manual, and the AstroLab claimed the AstroLab 37's.
const arturia = gaps.huntList([
    { gearName: 'Arturia BeatStep', state: 'no_file' },
    { gearName: 'Arturia AstroLab', state: 'no_file' },
    { gearName: 'Arturia KeyStep', state: 'no_file' },
    { gearName: 'Arturia MatrixBrute', state: 'no_file' },
], 'Arturia');
const arturiaCases = [
    ['BeatStep_Manual_1_0_1_EN.pdf', 'Arturia BeatStep'],
    ['beatstep-pro_Manual_2_0_EN.pdf', null],          // the Pro is a different machine
    ['BeatStepPro-CheatSheet.pdf', null],
    ['astrolab_Manual_1_5_1_EN.pdf', 'Arturia AstroLab'],
    ['astrolab-37_Manual_1_0_0_EN.pdf', null],         // the 37 is a different machine
    ['KeyStep_Manual_1_1_2_EN.pdf', 'Arturia KeyStep'],
    ['keystep-pro_Manual_2_5_2_EN.pdf', null],
    ['matrixbrute_Manual_2_0_3_EN.pdf', 'Arturia MatrixBrute'],
];
for (const [file, want] of arturiaCases) {
    const m = gaps.matchGap({ url: 'https://dl.arturia.net/' + file, linkText: '' }, arturia);
    assert.strictEqual(m ? m.gap.gearName : null, want, file);
}
console.log('  ok   a more specific model on the document does not claim a broader gap');

// The qualifier guard must not rely on : an underscore is a word character, so
// "pro" never fires on "beatstep-pro_Manual.pdf" — the exact filename it must reject.
assert.strictEqual(gaps.matchGap({ url: 'https://x/beatstep-pro_Manual.pdf' }, arturia), null);
console.log('  ok   a qualifier followed by an underscore is still caught');

// Word-based names keep their separators.
const mini = gaps.huntList([{ gearName: 'Korg minilogue xd', state: 'no_file' }], 'Korg');
assert.ok(gaps.matchGap({ url: 'https://x/minilogue_xd_OM_E.pdf' }, mini), 'minilogue xd should match');
assert.ok(!gaps.matchGap({ url: 'https://x/minilogue_bass_OM.pdf' }, mini), 'minilogue bass is a different machine');
console.log('  ok   word-based names match across separators but not across models');

if (failed) { console.error(failed + ' case(s) failed'); process.exit(1); }

// A page may declare its own base for relative links. Ignoring it produced fourteen
// Mackie documents whose URLs looked right and 404'd at handoff.
const strategies = require('../src/strategies');
{
    const withBase = '<html><head><base href="https://mackie.com/"></head><body>'
        + '<a href="img/file_resources/THUMP_GO_OM.pdf">Manual</a></body></html>';
    const got = strategies.links(withBase, 'https://mackie.com/en/products/loudspeakers/thump-go')[0].url;
    assert.strictEqual(got, 'https://mackie.com/img/file_resources/THUMP_GO_OM.pdf');

    const noBase = '<html><body><a href="docs/manual.pdf">M</a></body></html>';
    const got2 = strategies.links(noBase, 'https://example.com/a/b/page.html')[0].url;
    assert.strictEqual(got2, 'https://example.com/a/b/docs/manual.pdf');
    console.log('  ok   relative links resolve against <base href> when a page declares one');
}

// Only the newest edition of a manual is kept; unversioned documents are never dropped.
const versions = require('../src/phases/versions');
{
    const docs = [
        { f: 'metropolix_manual_v1.6_2025.09.24.pdf' },
        { f: 'metropolix_manual_v1.3_2021.07.04.pdf' },
        { f: 'THUMP_GO_OM.pdf' },
        { f: 'THUMP GO_QSG.pdf' },
    ];
    const dropped = versions.supersededIds(docs, d => d.f).map(d => d.name);
    assert.deepStrictEqual(dropped, ['metropolix_manual_v1.3_2021.07.04.pdf']);
    console.log('  ok   superseded revisions are dropped and unversioned documents are kept');
}


// Language is judged by the LAST language token in a filename. Novation's Circuit Rhythm
// broke the earlier version twice: a space before the code ("User Guide DE_1.pdf",
// "v1.0 - NL.pdf") slipped past a [-_.] separator class, and the word "english" anywhere
// in the name kept the file — so "..._english_da.pdf", the Danish edition, read as
// English. Twenty-six translations reached the live corpus before this was caught.
{
    const check = (file, keep) => assert.strictEqual(
        strategies.wanted('https://x/' + encodeURIComponent(file), ''), keep, file);

    check('Circuit Rhythm User Guide v1.0 English - EN.pdf', true);
    check('Circuit Rhythm User Guide DE_1.pdf', false);          // space before the code
    check('Circuit Rhythm User Guide v1.0 - NL.pdf', false);     // space and dash
    check('circuit_rhythm_user_guide_v1.0_english_da.pdf', false); // last token wins
    check('Digitakt-User-Manual_ENG_OS1.52A_250708.pdf', true);
    check('EK50_OM_E5.pdf', true);
    check('EK50_OM_F5.pdf', false);
    check('THUMP_GO_OM.pdf', true);                              // no language token at all
    console.log('  ok   language is read from the last token, and a space is a separator');
}

console.log('all gap-matching tests passed');

/* ------------------------------------------------------- family manuals */
{
    const fam = require('../src/phases/gaps');
    const huntF = brand => fam.huntList([
        { gearName: 'Roland Fantom-G8', state: 'no_file' },
        { gearName: 'ARP 2600 FS', state: 'no_file' },
    ], brand || 'Roland');

    const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); process.exitCode = 1; } };
    const assert = require('assert');

    t('the family manual fills the sibling gap', () => {
        const m = fam.matchGap({ url: 'https://static.roland.com/assets/media/pdf/Fantom-G_OM.pdf', linkText: 'Fantom-G Owner\'s Manual' }, huntF());
        assert(m && m.gap.gearName === 'Roland Fantom-G8', 'Fantom-G_OM should fill the G8 gap');
        assert(String(m.code).startsWith('family:'), 'and be labelled as a family match');
    });

    t('a sibling-specific document cannot ride the family rule', () => {
        const m = fam.matchGap({ url: 'https://static.roland.com/assets/media/pdf/Fantom-G6_Manual.pdf', linkText: 'Fantom-G6 Manual' }, huntF());
        assert(!m || m.gap.gearName !== 'Roland Fantom-G8', 'a G6-specific manual must not fill the G8 gap');
    });

    t('sharing a family NAME grants nothing without a curated entry', () => {
        // The ARP 2600 original manual must not fill the 2600 FS gap: three siblings,
        // three separate manuals, and no families.yaml entry says otherwise.
        const m = fam.matchGap({ url: 'https://example.com/ARP_2600_Owners_Manual.pdf', linkText: 'ARP 2600 manual' }, huntF('ARP'));
        assert(!m || m.gap.gearName !== 'ARP 2600 FS', 'no curated entry, no family match');
    });

    t('the gap\'s own code still wins over the family rule', () => {
        const m = fam.matchGap({ url: 'https://static.roland.com/assets/media/pdf/Fantom-G8_Supplement.pdf', linkText: 'Fantom-G8 supplement' }, huntF());
        assert(m && m.gap.gearName === 'Roland Fantom-G8' && !String(m.code).startsWith('family:'), 'specific code match preferred');
    });
}
