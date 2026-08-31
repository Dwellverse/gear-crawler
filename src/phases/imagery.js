/**
 * Find the maker's own photograph of a product.
 *
 * Route: the maker's published sitemap → their product page → the og:image they chose
 * to represent it. Sitemaps exist to be read, og:image exists to be the product's
 * picture, and both are fetched through the same polite client as everything else.
 *
 * Precision matters more than coverage here. A demo storefront showing the wrong
 * instrument is worse than one showing none, so a candidate page has to look like a
 * product page and mention the model, and anything that resolves to a press release or
 * a blog post is thrown away rather than used.
 */

const net = require('../net');

const SITEMAP_ROOTS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap/sitemap.xml'];

// Paths that are about a product rather than news about a product.
const GOOD_PATH = /(product|synthesizer|synthesiser|synths?|instrument|gear|shop|store|keyboard|drum|effect|pedal|monitor|microphone|interface|mixer|controller)/i;
const BAD_PATH = /(press|news|blog|article|story|event|artist|support|manual|download|faq|career|legal|privacy|terms|cart|checkout|account|search|compare|review)/i;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Distinctive tokens from a product name, ignoring the maker and filler words. */
function tokens(productName, brand) {
    let s = String(productName || '');
    if (brand && s.toLowerCase().startsWith(brand.toLowerCase())) s = s.slice(brand.length);
    return s.toLowerCase().split(/[^a-z0-9]+/)
        .filter(t => t.length >= 2 && !['the', 'and', 'gen', 'mk', 'series'].includes(t));
}

async function fetchSitemap(db, homepage, { log = () => {} } = {}) {
    for (const root of SITEMAP_ROOTS) {
        try {
            const xml = await net.fetchText(db, homepage.replace(/\/$/, '') + root);
            const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
            if (locs.length) return locs;
        } catch (e) { /* try the next spelling */ }
    }
    log('  no sitemap');
    return [];
}

/** Expand a sitemap index one level, preferring children that look like product lists. */
async function expand(db, locs, { max = 8 } = {}) {
    const children = locs.filter(l => /\.xml(\.gz)?$/i.test(l));
    if (!children.length) return locs;

    const ordered = [
        ...children.filter(c => GOOD_PATH.test(c)),
        ...children.filter(c => !GOOD_PATH.test(c) && !BAD_PATH.test(c)),
    ].slice(0, max);

    const out = [];
    for (const c of ordered) {
        try {
            const xml = await net.fetchText(db, c);
            out.push(...[...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]));
        } catch (e) { /* skip */ }
    }
    return out.length ? out : locs;
}

/** How well does this URL look like the product's own page? */
function score(url, toks) {
    let path;
    try { path = new URL(url).pathname.toLowerCase(); } catch (e) { return -1; }
    const flat = norm(path);

    // Every distinctive token must appear, or it is a different product.
    const hits = toks.filter(t => flat.includes(norm(t)));
    if (hits.length < toks.length) return -1;

    let s = 10;
    if (GOOD_PATH.test(path)) s += 4;
    if (BAD_PATH.test(path)) s -= 12;          // a press release is not a product page
    s -= Math.min(6, path.split('/').filter(Boolean).length);   // prefer shallow, canonical URLs
    s -= Math.min(4, Math.floor(path.length / 40));
    return s;
}

function metaImage(html, pageUrl) {
    const patterns = [
        /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) { try { return new URL(m[1], pageUrl).toString(); } catch (e) { return null; } }
    }
    return null;
}

/**
 * Resolve one product to { page, image } using the maker's site, or null.
 */
async function findImage(db, { productName, brand, homepage }, { log = () => {}, sitemap = null } = {}) {
    const toks = tokens(productName, brand);
    if (!toks.length) return null;

    const pages = sitemap || await expand(db, await fetchSitemap(db, homepage, { log }));
    if (!pages.length) return null;

    const ranked = pages
        .map(u => ({ url: u, s: score(u, toks) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3);

    for (const cand of ranked) {
        try {
            const html = await net.fetchText(db, cand.url);
            const img = metaImage(html, cand.url);
            if (img) return { page: cand.url, image: img, score: cand.s };
        } catch (e) { /* next candidate */ }
    }
    return null;
}

module.exports = { findImage, fetchSitemap, expand, score, tokens, metaImage };
