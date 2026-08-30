/**
 * The only way this program talks to the internet.
 *
 * Every request goes through here, which is what makes the guarantees enforceable rather
 * than aspirational: robots.txt is checked before the first request to a host and cached,
 * the per-host delay is applied by holding the call rather than by asking politely, and
 * the request budget is incremented unconditionally — a phase cannot forget to count.
 *
 * The rules it keeps (from the acquisition spec, §2):
 *   - identify honestly; never spoof a browser
 *   - one request per host at a time, 2s apart by default, or Crawl-delay if longer
 *   - honour Retry-After; exponential backoff on 429/503 to a 30-minute ceiling
 *   - a 403 is an answer, not an obstacle
 */

const robotsParser = require('robots-parser');
const manifest = require('./manifest');

const CONTACT = process.env.CRAWLER_CONTACT || 'https://gearplug.ai/contact';
const EMAIL = process.env.CRAWLER_EMAIL || 'hello@gearplug.ai';
const USER_AGENT = `GearManualBot/1.0 (+${CONTACT}; research indexing; contact ${EMAIL})`;

const DEFAULT_DELAY_MS = 2000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

// One in-flight request per host, enforced by chaining onto the host's own promise.
const hostChains = new Map();
const lastRequestAt = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Blocked extends Error {
    constructor(reason, kind) { super(reason); this.kind = kind; this.blocked = true; }
}

function hostOf(url) { return new URL(url).host; }

async function rawFetch(url, { method = 'GET', timeoutMs = 60000, headers = {} } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method,
            redirect: 'follow',
            signal: ac.signal,
            headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*', ...headers },
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * robots.txt for a host, cached in the manifest for 24 hours.
 *
 * A host that does not answer, or answers with an error, is treated as *allowing* —
 * that is what the standard says, and inventing a block would quietly lose a brand.
 */
async function robotsFor(db, url) {
    const host = hostOf(url);
    const row = manifest.getHost(db, host);
    const fresh = row && row.robots_fetched_at &&
        (Date.now() - Date.parse(row.robots_fetched_at)) < ROBOTS_TTL_MS;

    let body = fresh ? row.robots_body : null;
    if (!fresh) {
        const robotsUrl = `${new URL(url).protocol}//${host}/robots.txt`;
        try {
            const res = await rawFetch(robotsUrl, { timeoutMs: 15000 });
            body = res.ok ? await res.text() : '';
        } catch (e) {
            body = '';
        }
        manifest.spend(db, 'requests_total', 1);
        manifest.saveHost(db, host, { robots_fetched_at: manifest.now(), robots_body: body });
    }

    const robots = robotsParser(`${new URL(url).protocol}//${host}/robots.txt`, body || '');
    const declared = robots.getCrawlDelay(USER_AGENT);
    const delayMs = Math.max(DEFAULT_DELAY_MS, (declared || 0) * 1000);
    if (!fresh) manifest.saveHost(db, host, { crawl_delay: delayMs / 1000 });
    return { robots, delayMs };
}

/** Wait out this host's crawl delay and any active backoff, one caller at a time. */
async function waitTurn(db, host, delayMs) {
    const row = manifest.getHost(db, host);
    if (row && row.backoff_until) {
        const until = Date.parse(row.backoff_until);
        if (until > Date.now()) await sleep(Math.min(until - Date.now(), MAX_BACKOFF_MS));
    }
    const last = lastRequestAt.get(host) || 0;
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
}

function noteError(db, host, res) {
    const row = manifest.getHost(db, host) || {};
    const errors = (row.consecutive_errors || 0) + 1;
    // 429 and 503 mean "slow down"; everything else just counts toward the brand's
    // five-strikes rule in the runner.
    let backoffUntil = null;
    if (res && (res.status === 429 || res.status === 503)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const ms = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
            : Math.min(2 ** errors * 1000, MAX_BACKOFF_MS);
        backoffUntil = new Date(Date.now() + ms).toISOString();
    }
    manifest.saveHost(db, host, { consecutive_errors: errors, backoff_until: backoffUntil });
    return errors;
}

/**
 * Fetch a URL, keeping every promise this crawler makes.
 * @throws {Blocked} when robots.txt disallows it — the caller records and moves on.
 */
async function politeFetch(db, url, opts = {}) {
    const host = hostOf(url);
    const chain = hostChains.get(host) || Promise.resolve();

    const run = chain.then(async () => {
        const { robots, delayMs } = await robotsFor(db, url);
        if (robots.isDisallowed(url, USER_AGENT)) {
            throw new Blocked(`robots.txt disallows ${url}`, 'robots');
        }

        const budget = manifest.budget(db, 'requests_total');
        if (budget.exhausted) throw new Blocked(`request budget spent (${budget.cap})`, 'budget');

        await waitTurn(db, host, delayMs);
        manifest.spend(db, 'requests_total', 1);   // counted before the call, so a crash still costs it

        let res;
        try {
            res = await rawFetch(url, opts);
        } catch (e) {
            noteError(db, host, null);
            throw e;
        }

        if (!res.ok) {
            noteError(db, host, res);
        } else {
            manifest.saveHost(db, host, { consecutive_errors: 0, backoff_until: null });
        }
        return res;
    });

    // Keep the chain alive even when a link fails, or one 404 stalls the whole host.
    hostChains.set(host, run.then(() => {}, () => {}));
    return run;
}

async function fetchText(db, url, opts) {
    const res = await politeFetch(db, url, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
}

module.exports = { politeFetch, fetchText, robotsFor, USER_AGENT, Blocked, hostOf };
