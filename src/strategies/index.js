/**
 * Discovery adapters — the fragile edge of this program.
 *
 * Support portals get redesigned, so these are kept thin and each returns the same
 * shape: { url, linkText }. A brand that suddenly yields zero is a signal to go and look
 * at the site, not a bug to paper over with a broader crawl.
 *
 * Order of preference, per the spec: sitemap (cheapest and most complete), then a JSON
 * endpoint if the portal renders downloads client-side, then a bounded HTML crawl.
 */

const { parse } = require('node-html-parser');
const net = require('../net');

// Drivers, installers and marketing are not manuals. Firmware *release notes* are kept —
// they answer real questions — while firmware *binaries* are not.
// Blank sheets and patch books are not manuals — they are worksheets with almost no
// prose, and ingesting one adds noise under a real gear name. Nor are RoHS statements
// and compliance declarations, which Korg publishes on the same page as the manual.
const REJECT = /(driver|firmware[-_.]?\d|\.zip|\.exe|\.dmg|\.pkg|installer|software|catalog|brochure|price|poster|dealer|blank[-_ ]?sheet|patch[-_ ]?book|patch[-_ ]?sheet|blank[-_ ]?chart|rohs|compliance|declaration[-_ ]?of|safety[-_ ]?(?:guide|precautions|instructions))/i;
const PDF = /\.pdf(\?|$)/i;

// v1 indexes English only. Manufacturers mark the language in the filename far more
// reliably than in any header, and catching it here costs nothing — the alternative is
// downloading a Japanese manual, extracting it, and discarding it three phases later.
// Word-boundaried so "JA" cannot match inside a model name, and "-de" cannot match
// "digitakt-demo".
const NON_ENGLISH = /(?:^|[-_.]|\d)(ja|jp|jpn|de|deu|ger|fr|fra|es|esp|spa|it|ita|nl|pt|pl|ru|sv|zh|cn|ko|kr|tw)(?=[-_.]|$)/i;
// Some makers spell the language out — "octatrack_manual_japanese_OS1.25.pdf".
const NON_ENGLISH_WORD = /(?:^|[-_.])(japanese|german|french|spanish|italian|dutch|portuguese|russian|chinese|korean|swedish|polish|deutsch|espanol|francais|italiano)(?=[-_.]|$)/i;
const ENGLISH_HINT = /(?:^|[-_.])(en|eng|english)(?=[-_.]|$)/i;

/**
 * The filename a document is actually published under.
 *
 * Usually the last path segment, but a CDN may serve an opaque hash and put the real
 * name in a content-disposition parameter. Korg does exactly this: every manual is
 * `<32 hex>.pdf?...filename*=UTF-8''EK50_OM_F5.pdf`, so reading only the path made every
 * language look identical and let the French, German, Spanish, Chinese and Dutch
 * editions of one manual into the corpus alongside the English.
 */
function publishedName(url) {
    const s = String(url);
    // The parameter arrives percent-encoded in the href — "filename%2A%3DUTF-8%27%27" —
    // so the whole URL is decoded before looking for it. Matching the decoded spelling
    // alone found nothing and every Korg document kept its hash as its name.
    let decoded = s;
    try { decoded = decodeURIComponent(s); } catch (e) { /* malformed escape: use raw */ }

    const m = decoded.match(/filename\*?=(?:[^']*'')?([^&;]+)/i);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    try { return decodeURIComponent(s.split('?')[0].split('/').pop() || ''); } catch (e) { return s; }
}

/**
 * Some makers mark the language with single letters rather than a two-letter code:
 * Korg ships EK50_OM_E5 (English), _F5 (French), _G5 (German), _S5, _C6, _D3, and
 * EK50_OM_EFGSCJ5 for a manual containing all of them.
 *
 * A trailing group is only read as languages when *every* letter in it is a language
 * initial, which is what keeps "OM" (owner's manual), "QSG" (quick start guide), "VNL"
 * (voice name list) and "CSA" (a product name) out of it. English anywhere in the group
 * keeps the document.
 */
const LANGUAGE_INITIALS = new Set(['E', 'F', 'G', 'S', 'I', 'J', 'C', 'K', 'D', 'P', 'R']);

function nonEnglishBySingleLetters(name) {
    const m = name.match(/[-_]([A-Za-z]{1,8})\d*$/);
    if (!m) return false;
    const letters = m[1].toUpperCase().split('');
    if (!letters.every(c => LANGUAGE_INITIALS.has(c))) return false;   // not a language group
    return !letters.includes('E');
}

/** A filename that names a language other than English, and does not also say English. */
function looksNonEnglish(url) {
    const name = publishedName(url).replace(/\.pdf.*$/i, '');
    if ((NON_ENGLISH.test(name) || NON_ENGLISH_WORD.test(name)) && !ENGLISH_HINT.test(name)) return true;
    return nonEnglishBySingleLetters(name);
}

const abs = (href, base) => { try { return new URL(href, base).toString(); } catch (e) { return null; } };
const isPdf = url => PDF.test(url);
const wanted = (url, text) => isPdf(url)
    && !REJECT.test(url) && !REJECT.test(publishedName(url)) && !REJECT.test(text || '')
    && !looksNonEnglish(url);

/** Every <a> on a page, absolute and de-duplicated. */
function links(html, baseUrl) {
    const root = parse(html);
    const out = new Map();
    for (const a of root.querySelectorAll('a[href]')) {
        const url = abs(a.getAttribute('href'), baseUrl);
        if (url) out.set(url, (a.text || '').replace(/\s+/g, ' ').trim());
    }
    return [...out].map(([url, linkText]) => ({ url, linkText }));
}

/**
 * sitemap — follows sitemap indexes one level down.
 * Cheapest way to learn a whole site, and the politest: it is published for this.
 */
async function sitemap(db, brand, { log }) {
    const found = new Map();
    const queue = [...(brand.discovery?.sitemaps || brand.entrypoints)];
    const seen = new Set();

    while (queue.length && seen.size < 25) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);

        let xml;
        try {
            xml = await net.fetchText(db, url);
        } catch (e) {
            log(`  sitemap ${url}: ${e.message}`);
            continue;
        }

        const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
        for (const loc of locs) {
            if (/\.xml(\.gz)?$/i.test(loc)) {
                if (seen.size < 25) queue.push(loc);
            } else if (wanted(loc, '')) {
                found.set(loc, { url: loc, linkText: '' });
            }
        }
    }
    return [...found.values()];
}

/**
 * json_api — many support portals render their download list client-side.
 * The endpoint is given in the brand file; this walks pages of it and pulls out anything
 * that looks like a PDF plus the nearest thing to a title.
 */
async function json_api(db, brand, { log }) {
    const cfg = brand.discovery || {};
    const found = new Map();
    const pages = cfg.max_pages || 20;

    for (let page = 1; page <= pages; page++) {
        const url = String(cfg.endpoint).replace('{page}', String(page));
        let body;
        try {
            body = JSON.parse(await net.fetchText(db, url, { headers: { Accept: 'application/json' } }));
        } catch (e) {
            log(`  json ${url}: ${e.message}`);
            break;
        }

        const before = found.size;
        // Walk the whole payload rather than guessing its shape: portals differ, and a
        // PDF URL is recognisable wherever it sits.
        const walk = (node, title) => {
            if (node == null) return;
            if (typeof node === 'string') {
                const u = abs(node, url);
                if (u && wanted(u, title)) found.set(u, { url: u, linkText: title || '' });
                return;
            }
            if (Array.isArray(node)) return node.forEach(n => walk(n, title));
            if (typeof node === 'object') {
                const name = node.title || node.name || node.label || node.fileName || title;
                for (const v of Object.values(node)) walk(v, name);
            }
        };
        walk(body, '');
        if (found.size === before) break;   // a page that adds nothing means the end
    }
    return [...found.values()];
}

/**
 * html_crawl — bounded breadth-first walk from the support entrypoints.
 * Same host only, depth-limited, page-limited. The last resort, and the noisiest.
 */
async function html_crawl(db, brand, { log }) {
    const cfg = brand.discovery || {};
    const follow = (cfg.follow_patterns || []).map(p => new RegExp(p, 'i'));
    const maxDepth = cfg.max_depth ?? 2;
    const maxPages = cfg.max_pages ?? 60;

    const found = new Map();
    const seen = new Set();
    // Two tiers, both breadth-first. `follow_patterns` says which paths look like
    // documentation; those are walked first, and same-host links that match nothing are
    // only walked once that runs dry.
    //
    // Neither extreme works on its own, and each failure was measured. As a hard filter
    // it starved Moog, whose product URLs are just the model name — 6 pages of a 120
    // budget. Removed entirely it let Korg wander off the download section into news and
    // artist pages: 220 pages for 1 PDF, where 35 focused pages had found 7. Preferring
    // them and falling back keeps Korg's focus and Moog's reach.
    const queue = brand.entrypoints.map(url => ({ url, depth: 0 }));
    const spare = [];
    const take = () => (queue.length ? queue.shift() : spare.shift());

    // Within each tier the order is plain link order. Two attempts at scoring the
    // frontier — pulling pages that name missing gear to the front, then adding a
    // manual/download bonus — both did far worse: measured on Roland at 40 pages, link
    // order found 381 PDFs and filled 2 gaps, while either ordering found 0.
    while ((queue.length || spare.length) && seen.size < maxPages) {
        const { url, depth } = take();
        if (seen.has(url)) continue;
        seen.add(url);

        let html;
        try {
            html = await net.fetchText(db, url);
        } catch (e) {
            // A spent budget stops everything; one disallowed page does not. Rethrowing
            // both meant a single robots rule mid-walk aborted the whole brand — Arturia
            // died on /support/register-your-product with 23 gaps unexamined. Skipping
            // the page respects robots just as completely as abandoning the crawl.
            if (e.blocked && e.kind === 'budget') throw e;
            if (e.blocked) { log(`  skipped (robots): ${url}`); continue; }
            log(`  page ${url}: ${e.message}`);
            continue;
        }

        const host = net.hostOf(url);
        for (const link of links(html, url)) {
            if (wanted(link.url, link.linkText)) {
                found.set(link.url, link);
                continue;
            }
            if (depth >= maxDepth) continue;
            if (net.hostOf(link.url) !== host) continue;                 // never leave the brand's site
            if (seen.has(link.url)) continue;
            const preferred = !follow.length || follow.some(re => re.test(new URL(link.url).pathname));
            (preferred ? queue : spare).push({ url: link.url, depth: depth + 1 });
        }
    }
    log(`  walked ${seen.size} page(s)`);
    return [...found.values()];
}

const STRATEGIES = { sitemap, json_api, html_crawl };

async function discover(db, brand, opts) {
    const fn = STRATEGIES[brand.strategy];
    if (!fn) throw new Error(`${brand.slug}: unknown strategy "${brand.strategy}"`);
    return fn(db, brand, opts);
}

module.exports = { discover, STRATEGIES, links, wanted, looksNonEnglish, publishedName, REJECT };
