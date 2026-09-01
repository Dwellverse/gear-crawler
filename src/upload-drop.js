/**
 * Ingest hand-downloaded manuals from a drop folder.
 *
 * The other half of clicklist.html: four makers decline automated access, so a person
 * downloads their manuals by hand, saving each as the exact filename the list shows —
 * the gear name's slug. This walks a folder of those PDFs, maps each filename back to
 * the gear it names, and posts it to the same intake endpoint the crawler uses, which
 * does the rest: virus-scan, store, chunk, embed, index.
 *
 * Matching is exact, never fuzzy. The slug -> gear-name map is built from the same
 * .gapreport.json the click-list was built from and written next to it as drop-map.json;
 * a file whose name is not in the map is skipped with a message, because guessing an
 * identity is the failure mode this whole pipeline exists to prevent.
 *
 *   node src/upload-drop.js <folder> [--dry-run]
 *
 * Ingested files move to <folder>/done/ so a re-run only sends what is still pending.
 * Failures stay put and are reported with the server's reason.
 */

const fs = require('fs');
const path = require('path');

const API = () => process.env.GEARPLUG_API || 'https://gearplug.ai';
const KEY = () => process.env.GEARPLUG_INGEST_KEY || '';

const slugId = n => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 100);

/** slug -> { gearName, brand } for every gap of the hand-worked brands. */
function buildMap() {
    const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.gapreport.json'), 'utf8'));
    const map = {};
    for (const b of report.brands || report) {
        for (const it of b.items || []) map[slugId(it.name)] = { gearName: it.name, brand: b.brand };
    }
    fs.writeFileSync(path.join(__dirname, '..', 'drop-map.json'), JSON.stringify(map, null, 1));
    return map;
}

async function postPdf(filePath, gearName, manufacturer) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'application/pdf' }), path.basename(filePath));
    form.append('gearName', gearName);
    form.append('manufacturer', manufacturer);
    const res = await fetch(`${API()}/admin/console/api/manuals`, {
        method: 'POST',
        headers: { 'X-Ingest-Key': KEY() },
        body: form,
    });
    const raw = await res.text();
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { /* not JSON; raw is the detail */ }
    if (!res.ok || body.error) {
        throw new Error(body.error || `${res.status} ${res.statusText} — ${raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    }
    return body;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const folder = args.find(a => !a.startsWith('--'));
    if (!folder || !fs.existsSync(folder)) {
        console.error('Usage: node src/upload-drop.js <folder> [--dry-run]');
        process.exit(1);
    }
    if (!KEY() && !dryRun) {
        console.error('GEARPLUG_INGEST_KEY is not set — the app will refuse the request.');
        process.exit(1);
    }

    const map = buildMap();
    const doneDir = path.join(folder, 'done');
    const pdfs = fs.readdirSync(folder).filter(f => /\.pdf$/i.test(f));
    if (!pdfs.length) { console.log('No PDFs in ' + folder); return; }

    let sent = 0, failed = 0, skipped = 0;
    for (const f of pdfs) {
        const slug = f.replace(/\.pdf$/i, '').toLowerCase();
        const hit = map[slug];
        if (!hit) {
            skipped++;
            console.log(`  skip ${f} — no gap named "${slug}"; the filename must match the click-list hint exactly`);
            continue;
        }
        const full = path.join(folder, f);
        if (dryRun) {
            console.log(`  would send ${f} as "${hit.gearName}" (${hit.brand}, ${Math.round(fs.statSync(full).size / 1024)}KB) -> ${API()}/admin/console/api/manuals`);
            continue;
        }
        try {
            const r = await postPdf(full, hit.gearName, hit.brand);
            fs.mkdirSync(doneDir, { recursive: true });
            fs.renameSync(full, path.join(doneDir, f));
            sent++;
            console.log(`  ✓ ${hit.gearName} — ${r.pages || '?'} pages, ${r.chunks || '?'} chunks`);
        } catch (e) {
            failed++;
            console.log(`  ✗ ${hit.gearName} — ${e.message}`);
        }
    }
    console.log(`\n${dryRun ? pdfs.length - skipped + ' would send' : sent + ' ingested'}, ${failed} failed, ${skipped} skipped.`);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
