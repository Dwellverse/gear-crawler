/**
 * The brand and model registry.
 *
 * This is static configuration, hand-verified and committed. Mutable brand state — which
 * brands are blocked, when each was last crawled — lives in the manifest, and the
 * manifest always wins. A YAML file cannot un-block a brand.
 *
 * The model table is the highest-leverage thing in this repo. Identity is where the
 * existing library is wrong: a MiniBrute 2 manual filed as "Arturia MiniBrute", a TX81Z
 * filed under the bare word "yamaha", a Boss DD-8 page answering from a 2hp Delay. Every
 * one of those was a guess. This is how the crawler stops guessing.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const REGISTRY_DIR = path.join(__dirname, '..', 'registry');

function loadBrands() {
    const dir = path.join(REGISTRY_DIR, 'brands');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => /\.ya?ml$/i.test(f))
        .map(f => {
            const brand = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (!brand.slug) throw new Error(`${f}: every brand file needs a slug`);
            if (!brand.strategy) throw new Error(`${brand.slug}: no discovery strategy`);
            if (!Array.isArray(brand.entrypoints) || !brand.entrypoints.length) {
                throw new Error(`${brand.slug}: no entrypoints`);
            }
            // A brand nobody has read the terms for is not ready to be crawled.
            if (brand.tos_reviewed !== true) throw new Error(`${brand.slug}: tos_reviewed is not true`);
            return brand;
        })
        .sort((a, b) => (a.priority || 2) - (b.priority || 2));
}

function loadModels(brandSlug) {
    const file = path.join(REGISTRY_DIR, 'models', `${brandSlug}.yaml`);
    if (!fs.existsSync(file)) return [];
    return (YAML.parse(fs.readFileSync(file, 'utf8')).models || []).map(m => ({
        ...m,
        aliases: (m.aliases || []).map(normalise),
        normSlug: normalise(m.slug),
        normName: normalise(m.name || m.slug),
    }));
}

/** Lowercase, strip trademark marks, unify separators, collapse space. */
function normalise(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[™®©]/g, '')
        .replace(/[_/]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Which model does this text name?
 *
 * Matching is restricted to one brand's models by construction — "Model D" is ambiguous
 * across brands (Moog made one, so did Behringer), and a global match would confidently
 * file one as the other. Returns null rather than a low-confidence guess: an unmatched
 * manual is a registry gap to fill, while a mis-matched one is a wrong answer in a demo.
 */
function matchModel(text, models) {
    const t = normalise(text);
    if (!t || !models.length) return null;

    const padded = ` ${t} `;
    let best = null;

    for (const m of models) {
        for (const alias of [m.normSlug, m.normName, ...m.aliases]) {
            if (!alias) continue;
            if (t === alias) return { model: m, confidence: 1, alias };
            // Whole-word containment only: "sub 37" must not match inside "sub 370",
            // and a two-character alias must never match inside another word.
            if (padded.includes(` ${alias} `)) {
                const score = 0.9 + Math.min(alias.length, 20) / 400;   // longer alias, stronger claim
                if (!best || score > best.confidence) best = { model: m, confidence: score, alias };
            }
        }
    }
    return best;
}

/**
 * The name a manual will be filed under in the app.
 * Always brand-prefixed, so the app's own resolver has the manufacturer to work with.
 */
function gearNameFor(brand, model) {
    if (!model) return null;
    const name = model.name || model.slug;
    const brandName = brand.name || brand.slug;
    return name.toLowerCase().startsWith(brandName.toLowerCase()) ? name : `${brandName} ${name}`;
}

module.exports = { loadBrands, loadModels, matchModel, normalise, gearNameFor, REGISTRY_DIR };
