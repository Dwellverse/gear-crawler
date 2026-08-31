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
const REJECT = /(driver|firmware[-_.]?\d|\.zip|\.exe|\.dmg|\.pkg|installer|software|catalog|brochure|price|poster|dealer)/i;
const PDF = /\.pdf(\?|$)/i;

// v1 indexes English only. Manufacturers mark the language in the filename far more
// reliably than in any header, and catching it here costs nothing — the alternative is
// downloading a Japanese manual, extracting it, and discarding it three phases later.
// Word-boundaried so "JA" cannot match inside a model name, and "-de" cannot match
// "digitakt-demo".
const NON_ENGLISH = /(?:^|[-_.]|\d)(ja|jp|jpn|de|deu|ger|fr|fra|es|esp|spa|it|ita|nl|pt|pl|ru|sv|zh|cn|ko|kr|tw)(?=[-_.]|$)/i;
const ENGLISH_HINT = /(?:^|[-_.])(en|eng|english)(?=[-_.]|$)/i;

/** A filename that names a language other than English, and does not also say English. */
function looksNonEnglish(url) {
    const name = decodeURIComponent(String(url).split('/').pop().replace(/\.pdf.*$/i, ''));
    return NON_ENGLISH.test(name) && !ENGLISH_HINT.test(name);
}

const abs = (href, base) => { try { return new URL(href, base).toString(); } catch (e) { return null; } };
const isPdf = url => PDF.test(url);
const wanted = (url, text) => isPdf(url) && !REJECT.test(url) && !REJECT.test(text || '') && !looksNonEnglish(url);

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
async function html_crawl(db, brand, { log, priority }) {
    const cfg = brand.discovery || {};
    const follow = (cfg.follow_patterns || []).map(p => new RegExp(p, 'i'));
    const maxDepth = cfg.max_depth ?? 2;
    const maxPages = cfg.max_pages ?? 60;

    const found = new Map();
    const seen = new Set();
    let queue = brand.entrypoints.map(url => ({ url, depth: 0, score: 0 }));

    // With a page budget far smaller than the site, the order of the frontier decides
    // what we actually see. `priority` lets the caller pull pages that mention the gear
    // we are missing to the front, so a 200-page budget is spent on the 200 pages most
    // likely to carry those manuals instead of the first 200 in link order.
    const take = () => {
        if (!priority) return queue.shift();
        let best = 0;
        for (let i = 1; i < queue.length; i++) {
            if (queue[i].score > queue[best].score) best = i;
        }
        return queue.splice(best, 1)[0];
    };

    while (queue.length && seen.size < maxPages) {
        const { url, depth } = take();
        if (seen.has(url)) continue;
        seen.add(url);

        let html;
        try {
            html = await net.fetchText(db, url);
        } catch (e) {
            if (e.blocked) throw e;          // robots or budget — the caller decides
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
            if (follow.length && !follow.some(re => re.test(new URL(link.url).pathname))) continue;
            if (!seen.has(link.url)) queue.push({ url: link.url, depth: depth + 1, score: priority ? priority(link.url, link.linkText) : 0 });
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

module.exports = { discover, STRATEGIES, links, wanted, looksNonEnglish, REJECT };
