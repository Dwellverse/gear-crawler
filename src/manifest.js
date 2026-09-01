/**
 * The crawler's manifest — the only source of truth about what it has seen.
 *
 * Filesystem state, logs and the crawler's own memory are all secondary. If they
 * disagree with this database, this database wins.
 *
 * It deliberately holds *discovery* state only: which brands exist, which URLs have been
 * seen, what robots said, what has been spent. It does not hold chunks, embeddings or
 * anything about retrieval — those belong to the app, which already owns them. A manual
 * leaves here as a URL and a gear name; what happens next is not this program's business.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brands (
  slug               TEXT PRIMARY KEY,
  name               TEXT,
  state              TEXT NOT NULL DEFAULT 'pending',
  -- pending | active | exhausted | blocked:robots | blocked:tos
  -- | blocked:request | blocked:no_index
  blocked_reason     TEXT,
  blocked_at         TEXT,
  last_discovered_at TEXT,
  discovered_count   INTEGER DEFAULT 0,
  priority           INTEGER DEFAULT 2
);

CREATE TABLE IF NOT EXISTS documents (
  id               INTEGER PRIMARY KEY,
  brand_slug       TEXT NOT NULL REFERENCES brands(slug),
  source_url       TEXT NOT NULL UNIQUE,
  link_text        TEXT,
  discovered_at    TEXT NOT NULL,
  state            TEXT NOT NULL,          -- discovered | handed_off | skipped:* | dead:*
  state_updated_at TEXT NOT NULL,
  attempts         INTEGER DEFAULT 0,
  last_error       TEXT,
  gear_name        TEXT,                   -- what we will file it as
  model_slug       TEXT,
  model_confidence REAL,
  handed_off_at    TEXT,
  index_id         TEXT,                   -- what the app called it back
  pages            INTEGER,
  chunks           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_doc_state ON documents(state);
CREATE INDEX IF NOT EXISTS idx_doc_brand ON documents(brand_slug);

CREATE TABLE IF NOT EXISTS hosts (
  host               TEXT PRIMARY KEY,
  robots_fetched_at  TEXT,
  robots_body        TEXT,
  crawl_delay        REAL DEFAULT 2.0,
  backoff_until      TEXT,
  consecutive_errors INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budgets (
  key        TEXT PRIMARY KEY,
  used       REAL DEFAULT 0,
  cap        REAL NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, phase TEXT, started_at TEXT, ended_at TEXT,
  processed INTEGER DEFAULT 0, succeeded INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, notes TEXT
);
`;

// A cap whose counter nothing increments is not a cap, so every key here has exactly one
// writer, named in the comment beside it.
const DEFAULT_BUDGETS = {
    requests_total: 250000,   // net.js, every HTTP request, unconditionally
    handoffs_total: 5000,     // handoff.js, per manual passed to the app
    wall_clock_seconds: 72000, // runner, per invocation
};

const now = () => new Date().toISOString();

function open(dbPath) {
    const file = dbPath || path.join(__dirname, '..', 'manifest.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');   // survives a hard kill mid-write
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);

    const ins = db.prepare('INSERT OR IGNORE INTO budgets (key, cap, updated_at) VALUES (?, ?, ?)');
    for (const [key, cap] of Object.entries(DEFAULT_BUDGETS)) ins.run(key, cap, now());
    return db;
}

/* ----------------------------------------------------------------- brands */

function upsertBrand(db, { slug, name, priority }) {
    db.prepare(`
        INSERT INTO brands (slug, name, priority) VALUES (?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET name = excluded.name, priority = excluded.priority
    `).run(slug, name || slug, priority == null ? 2 : priority);
}

/**
 * Brands due for discovery.
 *
 * The block is enforced here, in SQL, rather than in a code path that could be skipped —
 * a blocked brand is invisible to the crawler, not merely skipped by it.
 */
function brandsToDiscover(db, { limit = 10, staleDays = 7, only = null } = {}) {
    const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`
        SELECT * FROM brands
        WHERE state NOT LIKE 'blocked:%'
          AND state != 'exhausted'
          AND (last_discovered_at IS NULL OR last_discovered_at < @cutoff)
          AND (@only IS NULL OR slug = @only)
        ORDER BY priority ASC, COALESCE(last_discovered_at, '') ASC
        LIMIT @limit
    `).all({ cutoff, only, limit });
}

function blockBrand(db, slug, state, reason) {
    db.prepare('UPDATE brands SET state = ?, blocked_reason = ?, blocked_at = ? WHERE slug = ?')
        .run(state, reason, now(), slug);
}

function markBrandDiscovered(db, slug, found) {
    const row = db.prepare('SELECT discovered_count FROM brands WHERE slug = ?').get(slug);
    // Two consecutive discoveries that turn up nothing new means the site is fully walked
    // (or the adapter has stopped working — reports/ shows which).
    const state = found === 0 && (row && row.discovered_count > 0) ? 'exhausted' : 'active';
    db.prepare(`
        UPDATE brands SET last_discovered_at = ?, discovered_count = discovered_count + ?, state = ?
        WHERE slug = ?
    `).run(now(), found, state, slug);
}

/* -------------------------------------------------------------- documents */

/** Idempotent: re-running discovery over the same site costs nothing. */
function addDocument(db, { brandSlug, url, linkText, gearName }) {
    const res = db.prepare(`
        INSERT OR IGNORE INTO documents
            (brand_slug, source_url, link_text, gear_name, discovered_at, state, state_updated_at)
        VALUES (?, ?, ?, ?, ?, 'discovered', ?)
    `).run(brandSlug, url, linkText || null, gearName || null, now(), now());
    return res.changes === 1;
}

/**
 * Documents in a state, oldest first.
 *
 * `namedOnly` selects in SQL rather than leaving the caller to filter afterwards. Handoff
 * used to ask for `limit * 3` rows and drop the unnamed ones, so a run of documents the
 * crawler could not identify sitting at the head of the queue starved everything behind
 * them: three unnamed documents were enough to make `handoff --limit 1` report "nothing
 * ready to hand off" while nine named ones waited.
 */
function documentsInState(db, state, limit = 50, { namedOnly = false } = {}) {
    const where = namedOnly ? "state = ? AND gear_name IS NOT NULL AND gear_name != ''" : 'state = ?';
    return db.prepare(`SELECT * FROM documents WHERE ${where} ORDER BY id LIMIT ?`).all(state, limit);
}

function setDocumentState(db, id, state, fields = {}) {
    const cols = Object.keys(fields);
    const sets = ['state = @state', 'state_updated_at = @ts', ...cols.map(c => `${c} = @${c}`)].join(', ');
    db.prepare(`UPDATE documents SET ${sets} WHERE id = @id`).run({ id, state, ts: now(), ...fields });
}

function recordAttempt(db, id, error, maxAttempts = 4) {
    const row = db.prepare('SELECT attempts, state FROM documents WHERE id = ?').get(id);
    const attempts = (row.attempts || 0) + 1;
    const dead = attempts >= maxAttempts;
    db.prepare('UPDATE documents SET attempts = ?, last_error = ?, state = ?, state_updated_at = ? WHERE id = ?')
        .run(attempts, String(error).slice(0, 500), dead ? 'dead:handoff' : row.state, now(), id);
    return { attempts, dead };
}

/* ---------------------------------------------------------------- budgets */

function budget(db, key) {
    const row = db.prepare('SELECT used, cap FROM budgets WHERE key = ?').get(key);
    if (!row) throw new Error(`No budget named "${key}" — add it to DEFAULT_BUDGETS.`);
    return { ...row, remaining: row.cap - row.used, exhausted: row.used >= row.cap };
}

function spend(db, key, amount = 1) {
    db.prepare('UPDATE budgets SET used = used + ?, updated_at = ? WHERE key = ?').run(amount, now(), key);
    return budget(db, key);
}

/* ------------------------------------------------------------------ hosts */

const getHost = (db, host) => db.prepare('SELECT * FROM hosts WHERE host = ?').get(host);

function saveHost(db, host, fields) {
    const existing = getHost(db, host);
    if (!existing) {
        db.prepare('INSERT INTO hosts (host) VALUES (?)').run(host);
    }
    const cols = Object.keys(fields);
    if (!cols.length) return;
    db.prepare(`UPDATE hosts SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE host = @host`)
        .run({ host, ...fields });
}

module.exports = {
    open, now,
    upsertBrand, brandsToDiscover, blockBrand, markBrandDiscovered,
    addDocument, documentsInState, setDocumentState, recordAttempt,
    budget, spend,
    getHost, saveHost,
};
