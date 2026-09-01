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

/** <loc> is XML, so its contents are entity-encoded. An un-decoded &amp; makes the URL wrong. */
const unentity = s => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');

const locsIn = xml => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => unentity(m[1]));

/** A sitemap that points at more sitemaps. The .xml can be followed by a query string. */
function isSitemapUrl(u) {
    try { return /\.xml(\.gz)?$/i.test(new URL(u).pathname); } catch (e) { return /\.xml(\.gz)?($|\?)/i.test(u); }
}

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
            const locs = locsIn(await net.fetchText(db, homepage.replace(/\/$/, '') + root));
            if (locs.length) return locs;
        } catch (e) { /* try the next spelling */ }
    }
    log('  no sitemap');
    return [];
}

/** Expand a sitemap index one level, preferring children that look like product lists. */
async function expand(db, locs, { max = 25, enough = 6000 } = {}) {
    const children = locs.filter(isSitemapUrl);
    if (!children.length) return locs;

    const ordered = [
        ...children.filter(c => GOOD_PATH.test(c)),
        ...children.filter(c => !GOOD_PATH.test(c) && !BAD_PATH.test(c)),
    ].slice(0, max);

    const out = [];
    for (const c of ordered) {
        try {
            out.push(...locsIn(await net.fetchText(db, c)));
            if (out.length >= enough) break;   // a huge index does not need reading whole
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

/**
 * Every image the page offers, best first.
 *
 * og:image is the maker's own choice and so is tried first, but it is a *social share*
 * image: often a page banner, and sometimes a 185px thumbnail. When it disappoints, the
 * product shot is usually still on the page, so the <img> tags are collected too and the
 * caller can measure them and take the largest.
 */
function imageCandidates(html, pageUrl) {
    const out = [];
    const push = (u) => {
        if (!u) return;
        try {
            const abs = new URL(u, pageUrl).toString();
            if (/\.(svg|gif)(\?|$)/i.test(abs)) return;                 // logos and spinners
            if (/logo|icon|sprite|placeholder|avatar|badge|flag/i.test(abs)) return;
            if (!out.includes(abs)) out.push(abs);
        } catch (e) { /* skip */ }
    };

    const og = metaImage(html, pageUrl);
    if (og) push(og);

    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
        const tag = m[0];
        // srcset lists the biggest last as a rule; take them all and let size decide.
        const ss = tag.match(/srcset=["']([^"']+)["']/i);
        if (ss) for (const part of ss[1].split(',')) push(part.trim().split(/\s+/)[0]);
        const src = tag.match(/\bsrc=["']([^"']+)["']/i) || tag.match(/data-src=["']([^"']+)["']/i);
        if (src) push(src[1]);
    }
    return out;
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
 * A short breadth-first walk of the maker's site looking for the product's page.
 * Bounded hard: this runs once per unresolved product, so it has to stay cheap.
 */
const PRODUCT_INDEX = [
    '/products', '/en/products', '/en-US/products', '/us/products', '/product',
    '/catalog', '/shop', '/synthesizers', '/instruments', '/all-products', '/gear',
];

async function walkForProduct(db, homepage, toks, { log = () => {}, maxPages = 40 } = {}) {
    const { parse } = require('node-html-parser');
    const seen = new Set();
    const hits = [];
    let host;
    try { host = new URL(homepage).host; } catch (e) { return []; }

    // Start where the products are, not at the front door. Walking from the homepage
    // spent its whole budget on marketing pages and reached no product listing at all,
    // which is why thirty products came back "no match" with the site right there.
    const base = homepage.replace(/\/$/, '');
    const queue = [...PRODUCT_INDEX.map(p => base + p), homepage];

    while (queue.length && seen.size < maxPages) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);

        let html;
        try { html = await net.fetchText(db, url); } catch (e) { continue; }

        const links = [];
        for (const a of parse(html).querySelectorAll('a[href]')) {
            try {
                const u = new URL(a.getAttribute('href'), url);
                if (u.host !== host) continue;
                u.hash = '';
                links.push(u.toString());
            } catch (e) { /* skip */ }
        }
        for (const u of links) {
            if (score(u, toks) > 0) hits.push(u);
            // Only follow listing pages; there is no budget for wandering.
            else if (!seen.has(u) && GOOD_PATH.test(u) && !BAD_PATH.test(u) && queue.length < maxPages) queue.push(u);
        }
        if (hits.length) break;   // found the product; stop walking
    }
    return hits;
}

/**
 * Resolve one product to { page, image } using the maker's site, or null.
 */
async function findImage(db, { productName, brand, homepage }, { log = () => {}, sitemap = null } = {}) {
    const toks = tokens(productName, brand);
    if (!toks.length) return null;

    let pages = sitemap || await expand(db, await fetchSitemap(db, homepage, { log }));

    // Plenty of makers publish no sitemap, or publish one that lists page layouts rather
    // than products — Genelec's has 432 entries and not one names a product. Falling back
    // to a short walk of their own site finds the product page the same way a person
    // would, and costs a handful of requests only for the brands that need it.
    if (!pages.some(u => score(u, toks) > 0)) {
        pages = await walkForProduct(db, homepage, toks, { log });
    }
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

module.exports = { findImage, fetchSitemap, expand, score, tokens, metaImage, imageCandidates, walkForProduct };
