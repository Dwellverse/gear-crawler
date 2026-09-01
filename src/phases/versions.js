/**
 * Keeping one edition of a manual rather than all of them.
 *
 * Makers leave every revision on the download page. Intellijel publishes Metropolix
 * v1.3, v1.4, v1.5 and v1.6 side by side; Novation had seventeen editions of one Circuit
 * Rhythm guide. Ingesting them all is worse than ingesting none: four near-identical
 * documents compete for the same question, and the answer can come from a manual two
 * revisions out of date while looking exactly as confident as the current one.
 *
 * So documents are grouped by the thing they are a revision *of* — the filename with its
 * version and date removed — and only the newest in each group is kept.
 */

const VERSION = /v?(\d+)\.(\d+)(?:\.(\d+))?/i;                 // v1.6, 1.52A
const DATE_DOTTED = /(20\d{2})[._-](\d{2})[._-](\d{2})/;       // 2025.09.24
const DATE_COMPACT = /(?:^|[^\d])(\d{2})(\d{2})(\d{2})(?:[^\d]|$)/; // _260826 (yymmdd)
const OS_VERSION = /OS(\d+)\.(\d+)([A-Z]?)/i;                  // OS1.40C

/** A comparable stamp for how recent a document is. Higher is newer. */
function stamp(name) {
    const d = name.match(DATE_DOTTED);
    if (d) return Number(d[1] + d[2] + d[3]);                  // 20250924

    const c = name.match(DATE_COMPACT);
    if (c) {
        const yy = Number(c[1]);
        // Two-digit years: everything here is 2000s, and a manual is not from 2090.
        return Number((yy > 80 ? 1900 + yy : 2000 + yy) + c[2] + c[3]);
    }

    const os = name.match(OS_VERSION);
    if (os) return 1_000_000 + Number(os[1]) * 10000 + Number(os[2]) * 100 + (os[3] ? os[3].toUpperCase().charCodeAt(0) - 64 : 0);

    const v = name.match(VERSION);
    if (v) return 500_000 + Number(v[1]) * 10000 + Number(v[2]) * 100 + Number(v[3] || 0);

    return 0;   // no version information at all
}

/** What this document is a revision of: the name with version and date stripped. */
function family(name) {
    return String(name)
        .replace(/\.pdf.*$/i, '')
        .replace(DATE_DOTTED, '')
        .replace(OS_VERSION, '')
        .replace(/v?\d+\.\d+(\.\d+)?/gi, '')
        .replace(/(?:^|[^\d])\d{6}(?:[^\d]|$)/g, '')
        .replace(/[^a-z0-9]+/gi, '')
        .toLowerCase();
}

/**
 * Given documents for one gear item, return the ids to drop: every revision that is
 * superseded by a newer one of the same family. A document with no version information
 * is never dropped — we cannot tell what it supersedes, and a real manual is worth more
 * than a tidy queue.
 */
function supersededIds(docs, nameOf) {
    const groups = new Map();
    for (const d of docs) {
        const name = nameOf(d);
        const key = family(name);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ doc: d, stamp: stamp(name), name });
    }

    const drop = [];
    for (const [, members] of groups) {
        if (members.length < 2) continue;
        const versioned = members.filter(m => m.stamp > 0);
        if (versioned.length < 2) continue;              // nothing to compare
        const newest = Math.max(...versioned.map(m => m.stamp));
        const winner = versioned.find(m => m.stamp === newest);
        for (const m of versioned) if (m.stamp < newest) drop.push({ ...m, newest, newestName: winner.name });
    }
    return drop;
}

module.exports = { stamp, family, supersededIds };
