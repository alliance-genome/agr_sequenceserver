# Browser regression suite (Playwright)

End-to-end tests for the AGR fork of SequenceServer, driven through a real
browser against the deployed **dev** site.

This is a **separate runner from jest**. `npm test` still runs jest against
`public/js/**` and is completely unaffected by anything in this directory
(jest's `roots` is `public/js`, so it never even sees these files).

---

## Running it

From the repository root:

```bash
npm run test:e2e                                  # the whole browser suite
npm run test:e2e -- test/e2e/examples.spec.js     # one file
npm run test:e2e -- -g "Try an example"           # by test name
npm run test:e2e -- --reporter=html && npx playwright show-report
```

Environment overrides (all optional — the defaults are correct):

| Variable          | Default                               | Purpose                          |
| ----------------- | ------------------------------------- | -------------------------------- |
| `E2E_BASE_URL`    | `https://blast-dev.alliancegenome.org` | Target deployment                |
| `E2E_CHROME_PATH` | `/usr/bin/google-chrome`              | Browser binary                   |
| `E2E_WORKERS`     | `2`                                   | Parallel workers                 |

Config lives in `playwright.config.js` at the repo root. Specs are
`test/e2e/*.spec.js`; shared code is in `test/e2e/helpers/` and is deliberately
**not** matched by `testMatch` (`**/*.spec.js`), so helpers are never collected
as tests.

### Requirements

* Node 18 (the box runs v18.15.0) and `@playwright/test` 1.54.
* **System Chrome**, driven via `launchOptions.executablePath`. There is no
  bundled Chromium here — install with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
  Running `npx playwright install` is unnecessary and may fail.
* Headless only. This is an EC2 instance with no display. The config already
  passes `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage
  --disable-gpu`.

---

## THE ONE CONSTRAINT THAT MATTERS: never point this at localhost

**Always run against `https://blast-dev.alliancegenome.org`. Never against
`http://localhost:4569`.**

The dev container runs with `HTTPS=on`, so `views/layout.erb` emits **absolute
`https://` asset URLs**. Served over plain HTTP on localhost, the page therefore
asks the browser for `https://localhost:4569/blast/css/app.min.css` — and port
4569 speaks HTTP only, so every stylesheet and every script fails to load:

```
http://localhost:4569          -> href="https://localhost:4569/blast/css/app.min.css"   (unreachable)
https://blast-dev.alliance...  -> href="https://blast-dev.alliancegenome.org/...css"    (200 OK)
```

The consequence is the nasty part. The server still returns **HTTP 200 with
valid HTML**, so a naïve status-code test passes. But the browser loads zero CSS
and zero JS, React never boots, and *every* UI assertion fails for a reason that
has nothing to do with the code under test. You would spend the afternoon
debugging the application instead of the URL.

`blast-dev.alliancegenome.org` is a public proxy in front of that same dev
container and has a valid certificate (Let's Encrypt, renewed 2026-09-23).

Two guardrails enforce this:

1. `smoke.spec.js` asserts that stylesheets actually parsed (>100 CSS rules) and
   that no `/blast/css/` or `/blast/js/` request returned >= 400. **If this spec
   fails, stop — do not debug any other spec.** The harness itself is broken.
2. Every spec enters through `gotoSearch()`, which returns only once `#sequence`
   *and* a rendered jstree anchor exist — i.e. once React has genuinely booted,
   not merely once HTML arrived.

Corollary: **never hardcode a host in a spec.** Use a path relative to
`baseURL` (`'/blast/SGD/R64-5-1m/'`).

---

## Current status

Last full run against dev: **64 tests — 63 passed, 1 failed, 2.1 minutes.**

`npm run test:e2e` currently **exits non-zero, and that is correct**: the one
failure is a real product bug, not a broken test. Do not "fix" it by loosening
the assertion.

### Known failure: SGD fungal offers examples for databases it does not have

```
cross_mod.spec.js › SGD (fungal): every offered example names a database this deployment has
  SGD (fungal) offers 2 example(s) but the database(s) ORF_coding, Protein_sequences
  do not exist in this deployment
```

`examplesForCurrentMod()` in `public/js/examples.js` keys the table on the MOD
segment alone:

```js
const segment = window.location.pathname.split('/')[2];   // "SGD" — version ignored
return EXAMPLES[segment.toUpperCase()] || [];
```

So `/blast/SGD/R64-5-1f/` is served the R64-5-1m examples, which target
`ORF_coding` and `Protein_sequences` — databases that exist only in R64-5-1m.
Measured on dev:

| Path                   | Query box filled | Databases selected | Submit  |
| ---------------------- | ---------------- | ------------------ | ------- |
| `/blast/SGD/R64-5-1m/` | 915 chars        | 1                  | enabled |
| `/blast/SGD/R64-5-1f/` | 915 chars        | **0**              | **disabled** |

The user clicks the example, gets a sequence, and is left with a greyed-out
submit button and no explanation. Fixing it means either keying examples on
`MOD + version` or giving the fungal deployment its own entry.

### Known bug, annotated rather than failing

`presets.spec.js` › *"BUG: single-preset methods show no preset selected"* is
marked `test.fail()`, so it counts as passing while the bug exists and will go
**red the moment the bug is fixed** — that is the signal to delete the
annotation.

In `public/js/options.js`, `presetListJSX()` renders
`checked={textValue === this.state.textValue}` where `textValue` is
`config.attributes.join(' ')`, but `componentDidUpdate()` *prepends* `-task`
to `state.textValue` when the preset carries no `-task` flag. The two strings
can then never match, so for blastp, blastx, tblastn and tblastx the Settings
block shows a radio group with nothing selected. Only blastn escapes, because
its preset spells out `-task blastn` in `sequenceserver.conf`. The search itself
is unaffected — `blast_params` is correct; it is only the UI that lies.

---

## What it covers

| Spec                    | Covers                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.js`         | The harness itself: CSS parsed, bundles executed, React booted, both jstrees rendered. Read this first when the suite goes red.     |
| `examples.spec.js`      | "Try an example" — click fills the query box **and** selects the example's database by title; method resolves; examples are per-MOD and replace one another. |
| `presets.spec.js`       | Option presets: blastn defaults to `-task blastn`, **not** `blastn-short`; human-readable descriptions; Settings renders even for single-preset methods; presets drive the submitted params. |
| `database_tree.spec.js` | jstree: the usage hint renders once per category, lazy groups really expand, the visible widget and the hidden `databases[]` inputs stay in sync, one-sequence-type-at-a-time is enforced, and the 24px arrow hit area did not misalign the sprite icons. |
| `routing.spec.js`       | Permanent URLs and aliases (`/blast/SGD/` → current release, `/yeast/` → R64-5-1m, `/fungal/` → R64-5-1f) and `?name=` deep links, including gene symbols and case-insensitivity. |
| `results_links.spec.js` | Real BLAST results: NCBI `/nuccore/` vs `/protein/` routing, SGD JBrowse linkouts with Roman-numeral chromosomes, and the sequence-viewer modal. |
| `cross_mod.spec.js`     | Every deployment (WB, FB, SGD ×2, RGD, ZFIN, ALLIANCE) boots, shows its own branding and logo, renders correctly typed databases, and throws nothing; WormBase hits carry no bogus NCBI link. |

### Conventions

1. **Enter via `gotoSearch(page, path)`**, never a bare `page.goto`.
2. **Selectors come from `helpers/selectors.js`** (exported as `S`). Add to that
   file rather than inventing a selector inline, so one markup change breaks one
   file. Every value in it was read off the live page.
3. **CommonJS**, not ESM. These files are not transpiled by babel and live
   outside jest's roots, so the two runners cannot collide.
4. **Match databases by TITLE**, never by id — ids are per-deployment md5
   hashes (`6076bfca9e...`). Use `selectDatabaseByTitle(page, 'Nuclear_chromosomes')`.
5. **Assert something that can fail.** No bare HTTP-200 or "element exists"
   checks. Assert exact shipped strings and values — the preset string
   `-task blastn -evalue 1e-5 -max_target_seqs 100`, the hint sentence,
   `loc=chrVI:…`, `/nuccore/` vs `/protein/`. Prove a new test discriminates by
   breaking it once and watching it fail.
6. **Workers stay at 2 and `fullyParallel` is off.** Dev is a single shared
   container running real BLAST jobs. Do not raise this.

---

## Gotchas the hard way

These each cost someone a run. Read before writing a spec.

* **The DOM holds TWO parallel copies of the database list.** The real form
  controls live in a hidden list:
  `ul.databases.hidden > li > label.database > input.checkbox-database`.
  jstree renders a *separate* visible mirror widget. So:
  * a checked checkbox has no `.jstree-anchor` near it — its **title is the text
    of the enclosing `label.database`**;
  * to *change* a selection you must click the **jstree anchor**; calling
    `.click()` on the hidden input does not drive jstree's model and desyncs the
    widget from the form;
  * the checkboxes are **never visible** (`ul` has class `hidden`), so
    `expect(checkbox).toBeVisible()` always fails — assert on `:checked` and on
    counts instead.
* **There is no `#databases_tree`.** There are two: `#nucleotide_database_tree`
  and `#protein_database_tree`. And **nucleotide-only MODs are real** — RGD,
  ZFIN and ALLIANCE render only one tree, so a loop over both crashes there.
  Iterate `.jstree_div` instead.
* **The hint sentence appears once PER TREE** — twice on SGD/WB/FB, once on
  RGD/ZFIN/ALLIANCE. A strict `toHaveCount(1)` fails on SGD.
* **The submit button's text is lowercase**; the capitals are CSS
  `text-transform`. `toContainText('BLAST')` fails — `#methods` innerText is
  `blastnOther methodstblastx`. Match `/blastn/i`, or assert the `value`
  attribute.
* **`div#options-presets` exists but is EMPTY until a database is selected.**
  Assert on its content only after selecting one.
* **`.hit` also matches `<polygon class="hit">`** in the graphical-overview SVG,
  which renders *before* the hit list. Every result selector in
  `selectors.js` is anchored on `div.hit` for this reason.
* **Hits render in 25ms batches**, so `waitForSelector('.hit')` returns on the
  *first* hit and a count taken straight after is racy and low. `runBlast()`
  calls `waitForHitsToSettle()`, which polls until the count holds steady.
* **jstree renders lazily** — deep leaves do not exist in the DOM until their
  ancestors are open, and expanding one level can reveal more closed nodes.
  `expandTree()` iterates to a fixed point (up to 6 passes), not once.
* **jstree reuses node ids across both trees** (a `Brugia` `<li>` exists in
  each), so a bare `#id` locator is ambiguous. Always scope to one tree.
* **Linkouts depend on the database you pick.** NCBI/JBrowse links appear on
  `Nuclear_chromosomes` hits but **not** on `ORF_coding` hits — SGD-native
  deflines carry no RefSeq accession. The "Try an example" button selects
  `ORF_coding`, so a linkout spec must explicitly switch databases.
* **The JBrowse `loc` is the padded VIEW window**, not the HSP bounds:
  `loc=chrVI%3A52608..55558` while the actual match lives inside the
  URL-encoded `addFeatures` JSON. Assert on `/loc=chrVI(%3A|:)/`, and
  `decodeURIComponent` before regex-matching anything else.
* **`dialog.sequence-viewer` is in the DOM from page load** with no `[open]`.
  Asserting it exists proves nothing. Assert `dialog.sequence-viewer[open]` or
  on visible `.sequence-viewer-content` text. It is a `<dialog>`, so a probe
  that only scans `div` misses it entirely.
* **`helpers/selectors.js` carries functions** (`hitById`,
  `databaseCheckboxOfType`). Playwright refuses to serialise a function into
  `page.evaluate`, so pass the individual strings you need, never `S` wholesale.
* **Google Analytics fires on every page load.** Account for it if you ever
  assert on third-party requests or run with network blocking.

---

## Deliberately NOT covered

* **HTTP status codes, redirects at the protocol level, and endpoint
  availability.** `test/manual/smoke-test.sh` already does that in 35 curl
  checks. This suite covers only what a browser can see: rendering, clicking,
  React state, and generated hrefs. `routing.spec.js` tests aliases by asserting
  on the *dataset that loaded*, not on a 302.
* **Unit-level React behaviour.** That is jest's job (`public/js/tests/`).
* **Actual BLAST correctness.** We assert that a search returns hits with the
  right shape and the right links — not that BLAST's alignments are
  biologically right. That belongs to BLAST+ and the Ruby specs.
* **The prod deployment and port 4568.** Never touched.
* **JBrowse itself.** We assert the generated URL is correct (host, chromosome
  name, coordinate shape). We do not load jbrowse.yeastgenome.org.
* **File downloads.** The FASTA/alignment/SVG/PNG export buttons are only
  checked for presence and class, not driven through a download.
* **Mobile/narrow viewports.** The suite runs at a fixed 1440×900. The sidebar
  lives inside a `.hidden.md:block` wrapper and is invisible at narrow widths.

## Maintenance notes

* `database_tree.spec.js` pins **exact** database counts per MOD (SGD fungal
  208 nucleotide / 104 protein; WB 32 / 31) because the point is that the
  visible tree and the hidden form list agree. `cross_mod.spec.js` deliberately
  uses loose **floors** instead. A routine data release will therefore break the
  former and not the latter — update the counts, do not loosen the equality
  between leaves and checkboxes.
* Example labels and their target databases are fixtures in `examples.spec.js`
  and `cross_mod.spec.js`. They come from `public/js/examples.js`.
* The two `test.describe.configure({ retries: 2 })` blocks in
  `results_links.spec.js` exist because dev is one shared container and a BLAST
  submit can queue behind another. They do not paper over assertions — a broken
  feature fails all three attempts.
</content>
