# gear-crawler

Finds manufacturer-published music gear manuals and hands them to GearPlug.

It does one half of the job: learn which manuals exist, and what to call them. Turning a
PDF into answerable chunks is the app's job, and the app already does it — so a manual
leaves here as a URL and a gear name, through the intake endpoint, and is live in the
widget the moment it lands. **There is no second corpus and no switchover.**

```
crawler → PDF url + gear name → POST /admin/console/api/manuals → [scan → chunk → embed] → live
```

## Running it

```bash
cp .env.example .env      # fill in GEARPLUG_INGEST_KEY (must match INGEST_KEY in the app)
npm install
node src/cli.js doctor            # what is configured
node src/cli.js discover --brand elektron
node src/cli.js status
node src/cli.js handoff --limit 20
```

`--dry-run` works on every command and never contacts a manufacturer.

## How it behaves

- **It never invents a URL.** Everything it records came from a sitemap, a JSON payload
  or an anchor on a page it actually fetched.
- **It never guesses a model.** An unresolved name is recorded with no gear name and
  logged to `reports/unmatched_models.jsonl` for review. A wrong identity is worse than a
  gap: the live library has a MiniBrute 2 manual filed as "MiniBrute" and a TX81Z filed
  under the bare word "yamaha", and both produce confidently wrong answers.
- **It is polite by construction.** robots.txt is checked before the first request to a
  host and cached for a day; one request at a time per host, 2s apart or whatever
  `Crawl-delay` asks for; `Retry-After` honoured; exponential backoff on 429/503. A 403 is
  an answer, not an obstacle.
- **A blocked brand stays blocked.** The block is enforced in the SQL that selects work,
  so a blocked brand is invisible to the crawler rather than merely skipped by it.
- **Budgets have named writers.** `requests_total` is incremented inside `net.js` on every
  request, so no phase can forget to count. A cap whose counter nothing increments is not
  a cap.
- **English only, filtered at discovery** — a Japanese manual is recognised from its
  filename and never downloaded.

## The registry is the important part

`registry/brands/*.yaml` and `registry/models/*.yaml` are hand-verified and committed.
Generations are separate models, never aliases of each other — listing "analog four" as
an alias of the MKII filed the MKI manual, the MKII manual and the Analog Keys manual all
as one product on the first run.

## Layout

```
src/manifest.js          SQLite state — the only source of truth
src/net.js               the only way this program talks to the internet
src/registry.js          brand and model registry, and model matching
src/strategies/          sitemap | json_api | html_crawl discovery adapters
src/phases/discover.js   find manuals, name them
src/phases/handoff.js    give them to the app
```
