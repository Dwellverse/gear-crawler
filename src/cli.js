#!/usr/bin/env node
/**
 * gearcrawl — find manufacturer-published manuals and hand them to GearPlug.
 *
 * This program does one half of the job: it learns which manuals exist and what to call
 * them. Turning a PDF into answerable chunks is the app's job, and the app already does
 * it — so a manual leaves here as a URL and a gear name, through the intake endpoint,
 * and is live in the widget the moment it lands. There is no second corpus and no
 * switchover.
 *
 *   gearcrawl doctor                 what is configured, what is reachable
 *   gearcrawl discover --brand moog  find manuals for one brand (or --all)
 *   gearcrawl status                 counts, budgets, per-brand coverage
 *   gearcrawl serve                  local web UI on http://127.0.0.1:7777
 *   gearcrawl handoff --limit 20     send discovered manuals to the app
 *
 * Every command takes --dry-run, which makes no network request to a manufacturer.
 */

// Small .env reader — one file, one purpose, no dependency needed.
(function loadEnv() {
    const fs = require('fs'), path = require('path');
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
})();

const manifest = require('./manifest');
const registry = require('./registry');
const discover = require('./phases/discover');

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
}
const has = name => process.argv.includes(`--${name}`);
const n = v => Number(v || 0).toLocaleString();

async function cmdDoctor(db) {
    console.log('Registry');
    let brands = [];
    try {
        brands = registry.loadBrands();
        console.log(`  ${brands.length} brand file(s) valid`);
    } catch (e) {
        console.log(`  INVALID: ${e.message}`);
        return;
    }
    for (const b of brands) {
        const models = registry.loadModels(b.slug);
        const row = db.prepare('SELECT state, discovered_count FROM brands WHERE slug = ?').get(b.slug);
        console.log(`    ${b.slug.padEnd(14)} ${b.strategy.padEnd(11)} ${String(models.length).padStart(3)} models  ${row ? row.state : 'not yet seen'}`);
    }

    console.log('\nBudgets');
    for (const row of db.prepare('SELECT * FROM budgets ORDER BY key').all()) {
        console.log(`  ${row.key.padEnd(20)} ${n(row.used)} / ${n(row.cap)}`);
    }

    console.log('\nHandoff target');
    const base = process.env.GEARPLUG_API || '(unset — set GEARPLUG_API)';
    const key = process.env.GEARPLUG_INGEST_KEY ? 'set' : '(unset — set GEARPLUG_INGEST_KEY)';
    console.log(`  ${base}\n  ingest key: ${key}`);
}

async function cmdDiscover(db) {
    const dryRun = has('dry-run');
    if (dryRun) console.log('(dry run — no manufacturer site will be contacted)\n');
    const res = await discover.run(db, {
        only: arg('brand', null),
        limit: parseInt(arg('limit', '10'), 10),
        dryRun,
    });
    console.log(`\n${res.brands} brand(s) walked, ${res.added} new manual(s) recorded.`);
}

function cmdStatus(db) {
    const states = db.prepare('SELECT state, COUNT(*) c FROM documents GROUP BY state ORDER BY c DESC').all();
    const total = states.reduce((t, s) => t + s.c, 0);
    console.log(`Documents (${n(total)})`);
    if (!total) console.log('  none yet — run: gearcrawl discover --all');
    states.forEach(s => console.log(`  ${s.state.padEnd(18)} ${String(s.c).padStart(6)}`));

    const brands = db.prepare(`
        SELECT b.slug, b.state, b.discovered_count,
               (SELECT COUNT(*) FROM documents d WHERE d.brand_slug = b.slug) docs,
               (SELECT COUNT(*) FROM documents d WHERE d.brand_slug = b.slug AND d.gear_name IS NULL) unmatched
        FROM brands b ORDER BY docs DESC
    `).all();
    if (brands.length) {
        console.log('\nBrands');
        brands.forEach(b => console.log(
            `  ${b.slug.padEnd(14)} ${b.state.padEnd(16)} ${String(b.docs).padStart(5)} manuals  ${String(b.unmatched).padStart(4)} unmatched`
        ));
    }

    console.log('\nBudgets');
    db.prepare('SELECT * FROM budgets ORDER BY key').all()
        .forEach(r => console.log(`  ${r.key.padEnd(20)} ${n(r.used)} / ${n(r.cap)}`));
}

async function main() {
    const cmd = process.argv[2];
    const db = manifest.open(arg('db', null));

    switch (cmd) {
        case 'doctor':   await cmdDoctor(db); break;
        case 'discover': await cmdDiscover(db); break;
        case 'status':   cmdStatus(db); break;
        case 'serve':
            db.close();
            require('./serve').start({ port: parseInt(arg('port', '7777'), 10), dbPath: arg('db', null) });
            return;   // the server keeps the process alive
        case 'hunt':     await require('./phases/hunt').run(db, {
                             top: parseInt(arg('top', '10'), 10),
                             maxPages: parseInt(arg('max-pages', '200'), 10),
                             maxDepth: parseInt(arg('max-depth', '3'), 10),
                             apply: has('apply'),
                         }); break;
        case 'handoff':  await require('./phases/handoff').run(db, {
                             limit: parseInt(arg('limit', '20'), 10), dryRun: has('dry-run'),
                         }); break;
        default:
            console.log(require('fs').readFileSync(__filename, 'utf8')
                .split('\n').slice(1, 20).map(l => l.replace(/^ \* ?/, '').replace(/^\/\*\*?/, '')).join('\n'));
    }
    db.close();
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
