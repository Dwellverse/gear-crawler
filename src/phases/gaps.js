/**
 * The demand side of the crawler.
 *
 * The app's catalogue is the source of truth for what gear exists and what it can
 * answer about. A brand's gaps are the entries it lists but cannot answer — 134 for
 * Roland against 93 live. This module turns those into targets a crawl can aim at,
 * so the question stops being "what is on their support page?" and becomes "which
 * of the things we already list can we now fill?".
 *
 * Matching is deliberately conservative. A wrong identity is worse than a gap: a
 * mislabelled manual answers confidently about the wrong machine, while a gap just
 * says we do not know.
 */

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Model codes inside a gear name — "Roland AIRA TR-8S Rhythm Performer" yields TR-8S.
 * These carry nearly all of the identifying power in gear naming, and they are what
 * manufacturers put in filenames.
 */
function modelCodes(gearName, brandName) {
    let s = String(gearName || '');
    const b = String(brandName || '');
    if (b && s.toLowerCase().startsWith(b.toLowerCase() + ' ')) s = s.slice(b.length + 1);

    const codes = [];
    const seen = new Set();
    // TR-8S, JU-06, MC-707, SH-101 — kept as parts, because matching has to respect
    // the boundary between them. "S-10" as the plain string "s10" is a substring of
    // "CS-10EM" and of "JC-120H"; as a bounded token it is neither.
    for (const m of s.matchAll(/([A-Za-z]{1,4})[-_ ]?(\d{1,4})([A-Za-z]{0,3})/g)) {
        const key = (m[1] + m[2] + m[3]).toLowerCase();
        if (key.length < 3 || seen.has(key)) continue;
        seen.add(key);
        codes.push({ key, letters: m[1].toLowerCase(), digits: m[2], suffix: (m[3] || '').toLowerCase() });
    }

    const rest = norm(s);
    // Gear with no model code at all — "minilogue xd", "Grandmother". Only distinctive
    // names qualify: a short one would match half the site.
    if (!codes.length && rest.length >= 7) {
        // Keep the words apart so the separator in "minilogue_xd_OM_E.pdf" is allowed
        // for. Normalising them together would only ever match "miniloguexd".
        const words = s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        if (words.length) codes.push({ key: rest, words });
    }
    return { codes, rest };
}

/**
 * A code matches only as a whole token. The character before and after must not be a
 * letter or digit, so "s-10" hits "S-10_manual.pdf" and misses "CS-10EM" and "S-100".
 */
function codeRegex(c) {
    const sep = '[-_. ]?';
    const body = c.words
        ? c.words.join(sep)
        : c.letters + sep + c.digits + (c.suffix ? sep + c.suffix : '');
    // The character before must not be alphanumeric, and must not be alphanumeric
    // followed by a separator: "RH-D20" and "SC-D70" are their own model codes, not a
    // boundary followed by D-20 and D-70. Both of those shipped as false positives.
    return new RegExp('(?<![a-z0-9])(?<![a-z0-9][-_. ])' + body + '(?![a-z0-9])', 'i');
}

/** Ask the app what this brand lists and what it can answer. */
async function coverageFor(brandName, { api, key } = {}) {
    api = api || process.env.GEARPLUG_API;
    key = key || process.env.GEARPLUG_INGEST_KEY;
    if (!api || !key) return { error: 'GEARPLUG_API or GEARPLUG_INGEST_KEY is not set.' };
    const res = await fetch(`${api}/admin/console/api/gear-coverage?brand=${encodeURIComponent(brandName)}`,
        { headers: { 'X-Ingest-Key': key } });
    if (!res.ok) return { error: `The app answered ${res.status}.` };
    return { gear: (await res.json()).gear || [] };
}

/** Every brand, ranked by how much gear it lists that it cannot answer. */
async function brandGaps({ api, key } = {}) {
    api = api || process.env.GEARPLUG_API;
    key = key || process.env.GEARPLUG_INGEST_KEY;
    if (!api || !key) return { error: 'GEARPLUG_API or GEARPLUG_INGEST_KEY is not set.' };
    const res = await fetch(`${api}/admin/console/api/gear-coverage`, { headers: { 'X-Ingest-Key': key } });
    if (!res.ok) return { error: `The app answered ${res.status}.` };
    const body = await res.json();
    return {
        brands: (body.brands || []).slice().sort((a, b) => b.missing - a.missing),
        totals: body.totals || {},
    };
}

/**
 * Build the hunt list: gear this brand lists but cannot answer, each with the codes
 * a filename would have to contain to be a plausible match.
 */
function huntList(gear, brandName) {
    return (gear || [])
        .filter(g => g.state !== 'live')
        .map(g => ({ ...g, ...modelCodes(g.gearName, brandName) }));
}

/**
 * Does this document fill one of the gaps? Returns the gap it fills, or null.
 * A code match is required — a loose name overlap is not enough to claim identity.
 */
function matchGap(doc, hunt) {
    let hay = '';
    try { hay = decodeURIComponent(doc.url || ''); } catch (e) { hay = String(doc.url || ''); }
    hay = (hay + ' ' + (doc.linkText || '')).toLowerCase();

    let best = null;
    for (const g of hunt) {
        for (const c of g.codes) {
            if (!codeRegex(c).test(hay)) continue;
            // Prefer the most specific code: MC-707 beats MC-7 on the same filename.
            if (!best || c.key.length > best.code.length) best = { gap: g, code: c.key };
        }
    }
    return best;
}

module.exports = { coverageFor, brandGaps, huntList, matchGap, modelCodes, codeRegex, norm };
