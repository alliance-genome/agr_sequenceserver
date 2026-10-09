# Plan: Make the Alliance-Wide BLAST Deployment Work

## Context

`/blast/ALLIANCE/prod/` is meant to be the cross-species BLAST — one place to
search every member organism's reference genome, as opposed to the per-MOD
deployments that each serve their own organism in depth.

It declares nine reference genomes and serves one.

The cause is not architectural. Adam Wright created the config on 2024-03-21
(`agr_blast_service_configuration` PR #14) naming nine reference genomes, one
per member species plus human and mouse. One build ran against it, on
2024-10-09, for 65 seconds. C. elegans failed on a stale MD5; the other seven
failed on `[Errno 28] No space left on device`. Zebrafish built. The run exited
0, and a year later `copy_to_production` shipped the single database that had
succeeded. The config has not been content-edited since the day it was written.

**Who this is for, and what success looks like.** A curator at a member
database who has a protein and wants to know which of the other member
organisms carry something like it — the question their own MOD deployment
cannot answer and NCBI answers with too much. The deployment succeeds when that
curator can run one `tblastn`, see which organisms hit and which did not, and
click through to the Alliance's own browser at the right coordinates. "Nine
databases load" is a milestone, not the goal.

**`tblastn` is the headline, not a footnote.** Cross-species *nucleotide*
identity between yeast and human genomic DNA is below `blastn`'s detection
outside rRNA, so a nucleotide-only cross-species tool answers almost nothing.
`tblastn` takes a protein query against nucleotide subjects, which is exactly
what this deployment has. It is already offered: `searchdata.json` lists
`['blastn','blastp','blastx','tblastx','tblastn']` and `public/js/form.js:187`
returns `['tblastn']` for a protein query against nucleotide databases. Every
example, default and acceptance test below is built around it.

This plan is **not** a restyle (`alliance-chrome-option-c` owns page chrome),
**not** the BLAT work, and **not** an expansion into `blastp`/`blastx`, which
genuinely have nothing to search here.

---

## Revision note

This document was produced by a multi-agent survey and then revised against two
adversarial reviews, both of which returned *needs-revision*. Twelve problems
were raised; the ones that changed the plan's structure are recorded at the
bottom under **What the review changed**, because several were factual errors
that would have wasted real work. The four load-bearing corrections were
re-verified by hand before adoption.

---

## Measured State

All figures measured 2026-09-30 on this host.

### Deployments

| Deployment | Databases served |
|---|---|
| `FB/FB2026_03` | 199 |
| `SGD/R64-5-1m` | 183 |
| `WB/WS298` | 63 |
| `RGD/8.3.0` | 9 |
| `ZFIN/zfintest` | 9 |
| **`ALLIANCE/prod`** | **1** |

### The nine declared entries

Config: `agr_blast_service_configuration/conf/ALLIANCE/databases.ALLIANCE.prod.json`,
byte-identical to the deployed `config-dev` and `config` copies.

| genus | species | taxon_id | MD5 vs live S3 | genome_browser | Built? |
|---|---|---|---|---|---|
| Caenorhabditis | elegans | `NCBITaxon:6239` | **stale** | yes — WormBase WS292 | no |
| Danio | rerio | `NCBITaxon:7955` | matches | no | **yes** |
| **rattus** | norvegicus | `NCBITaxon:10116` | matches | no | no |
| **mus** | musculus | **`NCBITaxon:`** (empty) | matches | no | no |
| **homo** | sapiens | **`NCBITaxon:9506`** (= *Ateles*) | matches | no | no |
| **drosophila** | melanogaster | `NCBITaxon:7227` | matches | no | no |
| **saccharomyces** | cerevisiae | `NCBITaxon:4932` | matches | no | no |
| **xenupus** | laevis | `NCBITaxon:8355` | matches | no | no |
| **xenupos** | tropicalis | `NCBITaxon:8364` | matches | no | no |

All nine URIs return HTTP 200. **Eight of nine MD5s still match** — verified by
streaming every object through `md5sum`. Only C. elegans is stale
(`4af7b125…` configured, `5c0d5cae0c4cd14a05fcf9e3092c4597` actual), and its
entry also still claims `version: WS292`.

### Capacity and failure facts

| Fact | Value |
|---|---|
| ALLIANCE builds ever run | 1 (2024-10-09), plus two aborted attempts |
| Outcome | 1 built, 1 MD5 failure, 7 × `ENOSPC` |
| Exit status of that run | **0** |
| Measured build cost (Danio, 442 MB gz) | download 19 s, unzip 8 s, `makeblastdb` 8 s — **35 s** |
| Nine FASTAs, compressed | ~4.5 GB |
| Free disk | **93 G of 250 G (63%)** after reclaiming 64 G of Docker data |
| Containers sharing `/var/sequenceserver-data/blast` | 3 (prod :4568, dev :4569, restyle :4570) |
| Links on an ALLIANCE hit today | 0 |
| ALLIANCE in `test/manual/smoke-test.sh` | absent |
| ALLIANCE in `environment_info.json` | absent |

The whole nine-genome build is roughly **an hour of machine time**, not weeks.
That number drives the sequencing below.

### Three code defects that only bite on a multi-database deployment

All three are latent today *because* ALLIANCE serves one database, and all three
become wrong answers the moment it serves nine.

1. **`parse_tsv` collapses hits sharing a sequence id.**
   `report.rb:260-270` builds `ir[qseqid][sseqid]`; `report.rb:186-188` reads
   `tsv_ir[n[1]]`. No database in the key. Human, mouse, rat and zebrafish all
   name a chromosome `1`, so two hits named `1` from two genomes collapse and
   the last TSV row wins, corrupting `sciname`, `qcovs` and `qcovhsp`.

2. **The TSV and XML sides do not share a usable id.**
   Measured: TSV `sseqid` is `1` (the defline word) while XML `Hit_id` is
   `gnl|BL_ORD_ID|0`. `report.rb:178-184` *rewrites* `n[1]` to the first defline
   word precisely so the join works — discarding `BL_ORD_ID`, the only unique
   discriminator that exists.

3. **`hit_db` is resolved by probing every database.**
   `hit.rb:56-66` loops `report.querydb.each { |db| db.include?(id) }`;
   `database.rb:65-70` implements that as a `blastdbcmd` subprocess wrapped in
   `rescue false`. First match wins. On ALLIANCE today every probe fails
   (`DB contains no accession info`) so *every* hit falls through to
   `report.querydb.first` and inherits the first database's config entry. After
   a rebuild with `-parse_seqids` it gets **worse**: `-entry '1'` succeeds
   against four genomes and first-match-wins returns an arbitrary one.

---

## Phase 1 — Get nine genomes served (days)

The critical path. Nothing here waits on a meeting.

### Step 1: Make the deploy reversible

**Problem.** `copy_to_production()` does `shutil.rmtree(dest)` then `copytree`
into `/var/sequenceserver-data/blast`, which all three containers share. Any
rebuild lands live the instant it copies, with no rollback, and a failure
mid-copy leaves the site serving nothing.

**There is no opt-out.** `--no-copy-to-sequenceserver` **does not exist** — it
is documented in `agr_blastdb_manager/CLAUDE.md:113,165,174` but was never
implemented. The real flag list is `--config_yaml --input_json --environment
--mod --skip_efs_sync --update-slack --sync-s3 --store-files --cleanup
--db_names --list --check-parse-seqids --limit-dbs --validate
--validation-path --skip-md5-check`. Copy-to-production is unconditional.

**Change.** Patch `src/utils.py:118-128` so `copy_to_production` writes to
`<…>/databases.incoming` and swaps with two `os.rename` calls, retaining
`databases.old`. This is the *only* thing standing between a build and the live
site, so it ships first and alone. Optionally also add the missing
`--copy-to-sequenceserver/--no-…` click option and delete the false
documentation.

**Effort.** Hours. **Risk.** Touches the deploy path for every MOD; test with a
single-entry config first.

**Verify.** Build a one-entry config, confirm `databases.incoming` appears and
the swap is atomic, and that `databases.old` still holds the previous set.

### Step 2: Disarm the build trigger

**Problem.** Merging any `.json` to `agr_blast_service_configuration` fires
`create_blast_db.yml` (`on: pull_request: types: [closed]`) on the self-hosted
runner with `timeout-minutes: 5` against ~4.5 GB of downloads — and with
`concurrency: {cancel-in-progress: true}`, a second merge kills the first
mid-build. With Step 1 unlanded that combination can destroy the one working
database.

**Change.** Remove the merge trigger (leave `workflow_dispatch`); raise
`timeout-minutes`; remove `cancel-in-progress` for this job; fix the `cd` so
`../data` resolves to the real tree rather than the empty
`/home/ec2-user/gitroot/data`; derive `-e` from `metadata.release` rather than
`basename | cut -d'.' -f3`.

**Effort.** Hours. **Risk.** None — real builds are already run by hand
(`src/blast_db_creation.log` is 2.1 MB and current; the repo-root one is 0 bytes).

**Verify.** Merge a no-op `.json`; no workflow run starts. `validator.yml` green.

### Step 3: Land the config repairs

**Problem.** Mouse `taxon_id` is `NCBITaxon:` (empty) —
`create_blast_db.py:146-155` interpolates that into `-taxid` and `makeblastdb`
exits 1, so **mouse cannot build at all**. Human is `NCBITaxon:9506`, which is
*Ateles*. Six genera are lowercase and both *Xenopus* entries are misspelled
differently, and `create_blast_db.py:92-99` interpolates genus/species verbatim
into the on-disk path that `database.rb:156-176` turns into tree nodes — so the
built tree would show two misspelled *Xenopus* genera. C. elegans's MD5 is stale.

**Change.** One PR: mouse → `NCBITaxon:10090`, human → `NCBITaxon:9606`, all
genera capitalised, both *Xenopus* spelled correctly, C. elegans MD5 →
`5c0d5cae0c4cd14a05fcf9e3092c4597` (and review whether its WS292-era URI should
advance). Refresh `metadata.dateProduced`.

Add a `genus` initial-capital pattern to `schemas/metadata_schema.json`. **Do
not** add `^NCBITaxon:[0-9]+$` for `taxon_id` — SGD, FB and RGD store bare
integers (`559292`, `7227`), so that pattern would reject working configs. If a
taxid pattern is wanted it must accept both forms.

**Effort.** Hours. **Risk.** Changes nothing served until a rebuild.

**Verify.** Schema validation passes for the corrected file and fails for
`NCBITaxon:` and `xenupus`; the other MOD configs still validate. `diff` the
deployed `config-dev` copy before and after the merge and confirm it is
**unchanged**, proving Step 2's disarm held.

### Step 4: Build the nine genomes

**Problem.** Eight have never been built.

**This is not a product decision.** The original draft routed four
"mismatched assemblies" through a meeting. Two of the four objections are
factually wrong: **RGD already serves GRCr8** (one of its nine databases,
alongside `mRatBN7_2`), so moving ALLIANCE to GRCr8 *converges* with RGD; and
**ZFIN serves no genome assembly at all** — its databases are Ensembl
transcripts, miRNA, CRISPR and TALEN feature sets — so there is nothing for
zebrafish to diverge from. Decide rat and zebrafish as an engineering call. Only
the two *Xenopus* entries are worth a conversation, and they need not block.

**Change.** Re-measure free space. Consider sourcing each `uri` from the
`fastaLocation` of the matching assembly in
`https://www.alliancegenome.org/jbrowse2/config.json`, which makes Step 6's
refName extraction tractable; recompute MD5s if so. Note **rat GRCr8 is already
built** under `RGD/8.3.0` and can be reused rather than re-downloaded.

Then run the manager by hand from `src/` — using the flags that exist:

```bash
cd /home/ec2-user/gitroot/agr_blastdb_manager/src
poetry run python create_blast_db.py \
  -j ../../agr_blast_service_configuration/conf/ALLIANCE/databases.ALLIANCE.prod.json \
  -e prod --validate
```

`--validate` runs the existing `DatabaseValidator`
(`create_blast_db.py:835-846, :884-960`) — the post-build correctness check the
plan would otherwise have to invent. `--skip-md5-check` is the existing escape
hatch if a checksum blocks a run.

Before building, delete the stale `Danio/rerio/ZFIN_GRCz11` from the manager's
persistent `../data/blast/ALLIANCE/prod/databases` tree if its title changes —
`copy_to_production` copies that **whole tree**, so a renamed entry would ship
alongside its own orphan.

**Effort.** Hours of machine time plus a day of verification. Not weeks.

**Risk.** `-parse_seqids` is mandatory for every MOD except ZFIN
(`create_blast_db.py:133-139`) and the 2024 run did not use it, so these large
files have never been through that path — unverified on GRCh38.p14 and
*X. laevis*. Rebuilt databases get different basenames (`Path.suffixes` eats the
assembly version), and `hit.rb:103` binds config entry to database by
FASTA-basename substring; re-verify per genome.

**Verify.** Nine `.nin` files under nine correctly spelled genus directories
with one `Xenopus` holding both species. `blastdbcmd -db <each> -entry all
-outfmt '%T'` returns exactly the configured taxid. `grep -c 'No space left'`
on the run log → 0. `searchdata.json` → 9.

### Step 5: Promote the config to production

**Problem.** The pipeline does **not** deploy `environment.json` to production.
`utils.py:151` sets `CONFIG_DEPLOY_ROOT = os.environ.get('AGR_CONFIG_ROOT',
'/var/sequenceserver-data/config-dev')` and `copy_config_to_production()` writes
there. Databases go straight to `/var/sequenceserver-data/blast`, which prod
shares. So a rebuild publishes **databases to prod instantly but config to dev
only** — prod on :4568 would serve 2026 databases against the 2024 config.
The two ALLIANCE copies are byte-identical today only because nothing has
changed them; Step 3 breaks that.

**Change.** An explicit promotion step with its own verification: diff
`config-dev/ALLIANCE` against `config/ALLIANCE`, then `cp -a`. Every
verification below must name the host it targets — :4568 is prod, :4570 is the
restyle instance — because several checks would pass on one while prod stays
broken.

**Effort.** Hours. **Risk.** Manual and unowned; worth automating later.

**Verify.** `diff -r` reports the trees identical; prod's `searchdata.json`
reports 9.

### Step 6: Give ALLIANCE a smoke test that can fail

**Problem.** `smoke-test.sh` has no ALLIANCE coverage, and
`cross_mod.spec.js:136` sets `databaseFloor: 1` — **asserting the broken state
is correct**. The manager's own `TEST_REPORT.md` likewise records
`ALLIANCE | prod | 1 | 0 | ✓ PASS`. Both agreed with a broken deployment for two
years.

**Change.** Add ALLIANCE rows to `smoke-test.sh` asserting the **post-build**
count of 9 — not "at or above the current floor", which is the broken state.
Raise `databaseFloor` to 9 and fix `exampleDatabases`. Correct `TEST_REPORT.md`.

**Effort.** Hours. **Risk.** None; test-only.

---

## Phase 2 — Make the hits mean something (days)

Only useful once nine genomes are served, and required before anyone trusts a
cross-species result.

### Step 7: Bind each hit to the database it actually came from

**Problem.** Defects 1–3 above. This must land before anyone relies on
per-genome links or labels.

**The original design does not work.** It proposed keying the TSV index by
`[qseqid, sseqid, staxid]`. Three reasons that fails:

- **BLAST has no outfmt specifier for the subject database.** `staxids` is an
  organism, not a database, so no TSV-derived key can identify one.
- **The XML side has no taxid** to join on — `Hit` carries `Hit_id`,
  `Hit_def`, `Hit_accession` only.
- **taxid is not unique per entry on any deployment.** Measured: WB/WS298 has
  63 entries over 29 taxids with 5 sharing one; SGD/R64-5-1m has 183 over 50
  with **11 sharing one**; FB has 200 over 66 with 5 sharing. Resolving a
  config entry by taxid would make a hit inherit an arbitrary one of eleven
  entries — a *new* mis-attribution defect in five working deployments. It also
  reopens exactly what the `c_elegans/PRJNA13758` special case at
  `hit.rb:96-99` exists to prevent.

  The commonest real collision is same-taxid anyway: WB's N2 and CB4856 both
  carry taxid 6239 *and* both name chromosomes `I`–`X`; RGD's nine rat
  assemblies all carry 10116 and all name chromosomes `1`–`20`.

**Change.** Join positionally instead. Both outputs come from the same archive
via `Formatter.run` (`report.rb:127`, `formatter.rb:22`), so hit **order is
identical** between the XML and TSV passes. Key on *(query index, hit rank)* —
an ordered array per query rather than a hash on a colliding id. No new outfmt
column, no taxid, no ambiguity.

For `hit_db`, stop probing: resolve from the hit's `BL_ORD_ID` OID range per
database, or from its position in the XML, which BLAST orders by database. Do
**not** memoise the existing probe — that cements the collision, since two hits
named `1` from two genomes would memoise to one database.

Keep a `staxids` column if useful for Step 8's labelling, but never as an
identity key. Note the taxid **format** is split across the fork — `NCBITaxon:N`
in WB and ALLIANCE, bare `N` in SGD/FB/RGD, and bare from BLAST — so anything
reading it must normalise.

**Effort.** Days. **Risk.** The highest-blast-radius change here: `parse_tsv`
feeds `sciname`, `qcovs` and `qcovhsp` for every report on every deployment.
Land alone, on its own branch.

**Verify.** A **single multi-database cross-species search** asserting each hit
resolves to the genome it actually came from — nine single-database searches are
structurally incapable of catching this. Diff WB and SGD report JSON before and
after: byte-identical. Add a unit spec feeding two rows with the same `sseqid`
from different databases and asserting both survive.

### Step 8: Alliance JBrowse 2 links for all nine

**Problem.** An ALLIANCE hit gets zero links — `hit.rb:108` gates every link on
a `genome_browser` key and only C. elegans has one, pointing at WormBase WS292.
Filling them in naively produces confidently wrong links: `links.rb:346` fires
the WormBase extractor whenever the accession contains `BL_ORD_ID`, and
`WORMBASE_CHROMOSOME_MAP` maps `1`→`I`…`5`→`V`, so human, mouse, rat and
zebrafish hits would be sent to chromosomes that do not exist.
`links.rb:499` calls `genome_browser_metadata["tracks"].join(",")` with no nil
guard.

**Change.** Config: the four-key block SGD already proves works —
`{"type":"jbrowse2","url":"https://www.alliancegenome.org/jbrowse2/",
"assembly":"<Genus_species>","tracks":["<Genus_species>_all_genes"]}`. Omit
`gene_track` and `data_url`: `hit.rb:117-141` shells out to
`jbrowse-nclist-cli`, a JBrowse 1 NCList reader, and Alliance JB2 has no
`trackData.jsonz`.

Code, in `links.rb`: add an Alliance branch to `extract_ref_name` — but **do not
gate it on the assembly name alone**. Seven FlyBase versions use
`"assembly": "Drosophila_melanogaster"` and both SGD deployments use
`"Saccharomyces_cerevisiae"`, verbatim. A top-of-chain branch on those names
would intercept all 200 FB entries and both SGD deployments before
`extract_flybase_chromosome` ever runs. Gate on the deployment instead — the
database path containing `/ALLIANCE/` **and** the `alliancegenome.org` URL
**and** the assembly name together — or better, move the refName rule into the
config entry and stop dispatching on substrings. Narrow the `BL_ORD_ID` clause.
Add the nil guards.

Per-assembly vocabularies are measured: bare Arabic plus X/Y/MT for human,
mouse, rat, zebrafish; Roman plus MtDNA for worm; `chrI`…`chrXVI` plus `chrmt`
for yeast; `Chr1L`/`Chr1S` for *X. laevis*; `Chr1`…`Chr10` for *X. tropicalis*;
`2L`/`2R`/`3L`/`3R`/`4`/`X`/`Y` for fly.

**Effort.** Days. **Risk.** Fly may not resolve from a RefSeq-derived name at
all — Alliance JB2's fly assembly is built from FlyBase's
`dmel-all-chromosome-r6.67` with no `refNameAliases`. **Unverified:** whether
JBrowse 2 applies `refNameAliases` to the inline `FromConfigAdapter` features
`links.rb:480-498` emits.

**Verify.** One cross-species search whose hits span several genomes, asserting
each link carries that genome's assembly and a `loc=` refName present verbatim
in its `.fai` — never a Roman numeral for an Arabic-named genome. Open rat and
zebrafish in a browser. Confirm WB, FB, SGD and RGD links byte-identical.

**Outcome, measured 2026-10-09.** Five of the nine are linked, not nine, and
the reason is the data rather than the code.

Alliance JBrowse 2 serves one assembly per species, and for four of the nine it
is a different build from the one BLAST searches. Compared sequence by sequence
against each assembly's `.fai`:

| genome | BLAST database | Alliance JB2 | names resolve | lengths agree |
|---|---|---|---|---|
| human | GRCh38.p14 | GRCh38.p14 | 705/705 | 705/705 |
| mouse | GRCm39 | GRCm39 | 61/61 | 61/61 |
| C. elegans | WBcel235 | WBcel235 | 7/7 | 7/7 |
| yeast | R64 | R64 | 17/17 | 17/17 |
| fly | Release_6_plus_ISO1_MT | dmel-all-chromosome-r6.67 | 8/8 | 8/8 |
| rat | mRatBN7.2 | GRCr8 | 23/23 | **0/23** |
| zebrafish | GRCz11 | GRCz12tu | 26/26 | **1/26** |
| X. laevis | XENLA_9.2 | v10.1 | **1/108033** | n/a |
| X. tropicalis | XENTR_9.1 | UCB_Xtro_10.0 | **2/6822** | n/a |

Rat and zebrafish are the dangerous pair: every chromosome name matches, so a
link would be built and would open, and the coordinates belong to another
assembly. Rat chromosome 1 is 260,522,016 bases in the BLAST database and
270,518,180 in JBrowse 2. Those two are left unlinked for that reason, and both
Xenopus because their scaffold names are absent from the chromosome-level
assemblies JBrowse 2 carries. Linking any of the four needs the BLAST database
rebuilt on the assembly JBrowse 2 serves, or a second assembly added there.

Three of the plan's claims above are wrong, corrected here:

* The Xenopus vocabularies are not `Chr1L`/`Chr1S` and `Chr1`...`Chr10`. The
  served assemblies are scaffold-level: `Scaffold81822` for *X. laevis*,
  `scaffold_57` for *X. tropicalis*.
* Fly resolves perfectly, 8 of 8. The worry was a RefSeq-derived name meeting
  an assembly with no `refNameAliases`, but the Alliance fly BLAST database
  already carries FlyBase arm names, which are the `.fai` names verbatim.
* `refNameAliases` never comes into it. Once `seqid_prefix` is stripped, the
  sequence id **is** the `.fai` refName for seven of the nine, so no alias
  lookup is required and the question of whether JBrowse 2 applies aliases to
  `FromConfigAdapter` features does not arise.

The code change is smaller than planned, too. Rather than an Alliance branch in
`extract_ref_name` gated on a combination of substrings, a config entry now
says `"ref_name": "accession"` and `extract_ref_name` returns early on it. That
was necessary as well as tidier: the Alliance rat directory is named
`RGD_mRatBN7_2`, so `database_path.include?("RGD")` was true and the RGD rule
answered `Chr1`; the Alliance yeast assembly is `Saccharomyces_cerevisiae`,
which the SGD rule matches verbatim; and for the 704 human and mouse scaffolds,
the only Alliance sequences with a defline, the generic fallback returned the
first word, `Homo` or `Mus`.

One more defect surfaced while testing. `routes.rb` built the path to
`environment.json` from the literal string `/sequenceserver`, the app's location
inside the container image, in two places. Anywhere else the file was not found,
the branch fell back to an empty config, and every hit silently lost its genome
browser and MOD gene links. Both now use `settings.root` through one helper.

**Verified.** 60 JBrowse links across two cross-species searches, every refName
present in its assembly's `.fai`, none wrong. Human, mouse, C. elegans, yeast
and fly each hit and linked, including the titled human and mouse scaffolds
that used to yield `Homo` and `Mus`. Rat hits appear with no link. WB, FB, SGD
and RGD links byte-identical to the previous build: 1, 1, 12 and 14 links
compared.

**All nine linked, 2026-10-09.** The four that could not be linked were
rebuilt on the assemblies Alliance JBrowse 2 serves, so the obstacle above is
gone:

| genome | now built from | sequences | names and lengths match the .fai |
|---|---|---|---|
| zebrafish | GCF_049306965.1_GRCz12tu | 26 | 26 of 26 |
| rat | GCF_036323735.1_GRCr8 | 77 | 77 of 77 |
| X. laevis | GCF_017654675.1_Xenopus_laevis_v10.1 | 55 | 55 of 55 |
| X. tropicalis | GCF_000004195.4_UCB_Xtro_10.0 | 167 | 167 of 167 |

Both Xenopus went from scaffold-level to chromosome-level, 108,033 and 6,822
sequences down to 55 and 167, named Chr1L, Chr1S and Chr1 to Chr10. So the
per-assembly vocabularies this plan listed were right after all; they describe
these assemblies, and the earlier correction above applies only to the
scaffold-level builds that were being searched at the time.

Titles and seqid_prefixes changed with the assemblies, so each database names
what it holds. The prefixes stay distinct because rat, zebrafish, human and
mouse all name chromosomes 1..n: 1,123 ids across the nine, none in more than
one database.

**Verified live**, on the test instance against the deployed tree and config:
152 hits, 152 JBrowse links, every refName present in its assembly's .fai, none
wrong and none missing, with all nine assemblies represented. Rat alone went
from no links to 18. WB links unchanged.

The four superseded databases are kept at
/var/sequenceserver-data/retired-alliance-2026-10-09, 2.0 GB, so a rollback is
a move back.

One consequence to watch. Production still runs agr-blast:fda1db1f, which
predates the ref_name support, and it reads /var/sequenceserver-data/config
rather than config-dev. Its config therefore still names the old assemblies and
matches none of the rebuilt databases, so production shows the new data with no
genome browser links, as it did before. That is the safe state: the old code
with the new config would have produced "Chr1" for rat, which GRCr8 does not
contain. Promote the config to production only together with the code.

### Step 9: Name the organism, everywhere a hit appears

**Problem.** A cross-species result page never names a species.
`query.js:433` gates the Species column on every hit having a non-empty
`sciname`, which is always `''` (no taxdb installed). `circos.js:129` labels
arcs by `hit.id` truncated to three characters and dedupes on id alone, so nine
genomes' chromosome `1` render as one arc and a second organism's chords are
drawn against the first organism's.

**Change.** Render the organism resolved from Step 7's database binding. Show
the Species column when *any* hit carries an organism. Add an organism label in
`hit.js` `headerJSX()`. Count distinct organisms in `sidebar.js`. Key
`circos.js` arcs on database + id.

**Re-examine installing NCBI `taxdb`.** The original draft rejected it because
container definitions live elsewhere, but Step 4 already requires host
operations on those same mounted volumes, and `taxdb` lights up the existing
`sciname` path directly — hours of work against a four-step chain to print an
organism name.

**Effort.** Days. **Risk.** Strictly dependent on Step 7; labelling before
attribution is trustworthy prints a confident wrong species.

**Verify.** Each row's species matches the genome directory its database lives
in; three genomes' chromosome `1` render as three distinct circos arcs.

---

## Phase 3 — Make it usable (days)

### Step 10: Open the tree, and let people search it in English

**Problem.** `databases_tree.js:166-168` early-returns for anything not WB, FB,
RGD, SGD-fungal or ZFIN, so the ALLIANCE tree renders fully collapsed. The
per-MOD model is wrong here anyway: each branch opens one privileged organism,
and nine peers have none. `databases_tree.js:319` hides `[Select all]` when a
category holds one database.

**And nobody can search it.** `handleTreeSearch` passes the string straight to
jstree's node-text search, so on a tree of Latin genus folders **"zebrafish",
"worm", "fly" and "mouse" all match nothing** — on the one deployment whose
users are least likely to think in Latin.

**Change.** Replace the MOD early-return with a data-driven rule: when a
deployment presents more than one top-level category, expand all top-level
nodes. Force `toggleShown` true in that case. Add the Expand/Collapse All
controls `docs/UI_IMPROVEMENT_IDEAS.md:87-88` already recommends. Add common
names as searchable aliases on the tree nodes.

The tree is four levels (genus → species → title → leaf), so expanding the
genus level alone still costs two clicks per genome; flattening it for
single-database-per-species deployments is worth doing here rather than
deferring.

**Do not change the options defaults fork-wide.** The original draft initialised
E-value and max-hits from the served preset for every deployment. A silent
`-max_target_seqs 100` is a behaviour change SGD's 125-nucleotide-database users
did not ask for and would not notice until results went missing, and
`max_target_seqs` is a per-search early-termination heuristic, not "the best
100". If ALLIANCE needs a ranking default, key it off the deployment's database
count; the real fix for cross-species ranking is Step 11.

**Effort.** Days. **Risk.** Check the data-driven rule does not over-expand FB's
199 databases.

**Verify.** Anchor counts for WB, FB, SGD, RGD and ZFIN unchanged. Searching
"zebrafish" selects *Danio rerio*.

### Step 11: Stop one genome eating the result list

**Revised after measurement — the premise was wrong, and the truth is worse.**

The problem is not ranking. When a search spans several databases that use the
same sequence ids, **BLAST reports each id once and drops the rest**. The
alignments are not ranked below a cut; they never reach the output, and nothing
in BLAST's output says so.

Demonstrated with two databases built here, each holding one sequence called
`1` with different content and different taxids. Searched separately, each
returns its own. Searched together, only the first appears.

Measured over this host's deployments, counting only same-type pairs that could
actually be searched together:

| deployment | databases | colliding pairs |
|---|---|---|
| `ALLIANCE/prod` | 9 | **23 of 36** |
| `WB/WS298` | 63 | 6 (the nematode genome assemblies, all naming `I`–`VI`, `X`) |
| `FB/FB2026_03` | 200 | 0 |
| `RGD/8.3.0` | 9 | 0 |

Human, mouse, rat and zebrafish all name chromosomes `1..n`. A nine-genome
`tblastn` for human ACTB returned 131 hits and **not one was mouse or rat**,
while mouse alone returns 20 at e-value 0.0. Human×mouse share 22 ids,
human×rat 23, human×zebrafish 23.

So the original prescription — render "no hits: *Mus musculus*" — would state
as fact the one thing that is false. What shipped instead is a warning that the
**result** is incomplete, naming the databases involved, plus a per-organism
count of what did answer. The real fix is at the data level: sequence ids must
be unique across genomes searched together, which means prefixing them at build
time in `agr_blastdb_manager`. That is a rebuild of all nine and is not done.

Note this also affects WormBase today, independently of ALLIANCE: selecting two
nematode genome assemblies silently loses chromosomes.

**Original problem statement, kept for the record.** BLAST ranks hits globally
across all databases, so a conserved query fills the list from whichever genome
scores best, and the page cannot distinguish "no hit in mouse" from "mouse
ranked below the cut" — the one thing a cross-species tool must be able to
say.

**Change.** In `hits.js`, group the rendered list by organism with per-organism
counts and a collapse control, and render an explicit "no hits: *Mus musculus*"
line computed from the selected databases' organisms minus those present.
Client-side grouping is chosen over a per-database cap, which would mean N
BLASTs merged in `job.rb`.

**Effort.** Days. **Risk.** Gate on more than one organism so single-organism
reports are unchanged.

### Step 12: Publish it

**Problem.** `layout.erb:65-73` has no ALLIANCE case, so the member link points
at `alliancegenome.org/members/ALLIANCE`, which does not exist. ALLIANCE is
absent from `environment_info.json`. `examples.js:76-82` offers a zebrafish
fragment against zebrafish — demonstrating nothing cross-species — keyed on the
exact title `ZFIN_GRCz11`, so any rename silently deletes it.

**Change.** Explicit ALLIANCE case in `layout.erb`. Add ALLIANCE/prod to
`environment_info.json`. Replace the example with a **conserved protein run
under `tblastn`** — a kinase domain or a histone — that returns hits in several
genomes. A `blastn` example spanning yeast to human cannot satisfy that
criterion and should not be attempted.

Resolve `metadata.public: false`, the only config carrying it — is this a broken
production service or an unlaunched prototype? The work is the same either way;
only the urgency and the announcement change.

**Note.** The page heading is **not** open. Commit `e2b55797` on
`alliance-chrome-option-c` decided the Alliance-wide page is headed the bare
word "BLAST", verified across all seven deployments. Anyone wanting
"Cross-Species BLAST" is arguing against that commit.

**Verify.** No `members/` link in the rendered page. The new `tblastn` example
returns hits in more than one organism.

### Step 13: Stop it rotting again

**Problem.** Nothing would have caught any of this. The manager exits 0 after
seven `ENOSPC` failures. `copy_config_file` republishes the build **input** as
`environment.json` whenever at least one entry succeeded — exactly how the
deployment came to declare nine genomes while serving one. Nothing checks free
space before starting. And nobody owns re-running ALLIANCE: per-MOD configs have
release-cadence refresh wired into the Makefile; ALLIANCE has had two commits,
both on 2024-03-21.

**Change.** Exit non-zero when any entry fails — this needs real plumbing, not a
one-liner: `process_json_entries` returns `successful > 0`
(`create_blast_db.py:710`), `process_files` **discards** that return value
(`:331-335`), and `create_dbs` never inspects it. Three call sites to thread.
Refuse to write `environment.json` or copy to production when
`successful < total` unless forced. Check free space against summed declared
sizes before starting. Name an owner and cadence for the ALLIANCE config.

**Do not** add per-entry FASTA cleanup — `run_makeblastdb` already unlinks both
the unzipped FASTA and the `.gz` immediately after a successful build
(`create_blast_db.py:210-226`), and `process_entry` repeats it at `:505-525`.
The end-of-run sweep is a backstop, not the primary mechanism. Peak disk is
therefore one gz plus one uncompressed genome plus one database at a time — a
much smaller number than a naive sum.

**Effort.** Days. **Risk.** Exiting non-zero will turn other MODs'
currently-green partial builds red. That is the point, but it surfaces
unbudgeted work.

---

## Phase 4 (Future): Cross-species gene and orthology follow-through

The reason this deployment exists, and the only genuinely new mechanism. But a
cross-species BLAST whose hits reach coordinates and never a gene is a
coordinate lookup — so if this phase is cut entirely, something in Phases 1–3
should still reach a gene page, even for one genome.

- **Gene lookup by coordinate.** Each `<Assembly>_all_genes` track is a
  `Gff3TabixAdapter` over an S3 `gff.gz` with a `.tbi` (verified:
  `Homo_sapiens_all_genes` → `GFF_HUMAN.sorted.gff.gz`, HTTP 200 with
  `Accept-Ranges: bytes`), so a range query replaces `jbrowse-nclist-cli`.
  Needs `tabix` in the `Dockerfile` — installed nowhere today.
- **Orthologues.** `GET /api/gene/{curie}/orthologs` returns 200 unauthenticated
  (verified: HGNC:11998 → 7 orthologues including `Xenbase:XB-GENE-17346471`).
  Surface as a lazily-fetched expandable row.
- **Unverified:** whether the refName vocabulary inside the Alliance
  `all_genes` GFFs matches each assembly's `.fai`. Not checkable read-only —
  `tabix` is installed nowhere.

---

## Deliberately not doing

- **`blastp` and `blastx` on ALLIANCE.** They have nothing to search — the
  databases are nucleotide. `tblastn` is the protein path and is in scope.
- **Per-database hit caps** (N BLASTs merged in `job.rb`). Step 11's grouping
  delivers the outcome for far less.
- **Renaming the page heading.** Settled by `e2b55797`.
- **The BLAT integration** (`docs/BLAT_INTEGRATION_PLAN.md`).

## Open questions

1. **Is this a live service or a prototype?** `metadata.public: false` and the
   missing `environment_info.json` entry point one way; two years of public
   reachability point the other. Changes urgency, not work.
2. **Do the two *Xenopus* entries move to the JBrowse assemblies, or does
   JBrowse gain the older ones?** Rat and zebrafish need no such conversation
   (see Step 4). This need not block the build.
3. **Is nine the right roster?** It omits *C. elegans* strains, *Xenopus*
   relatives, and every non-member model organism.
4. **Who owns refreshing this config** as member assemblies advance?
5. **What happens to shared ALLIANCE result URLs** if the zebrafish assembly
   changes and its directory is renamed? Every previously shared result would
   point at coordinates on a genome the deployment no longer serves.

## What the review changed

Two adversarial reviews returned *needs-revision*. The corrections that changed
the plan's structure, with the four load-bearing ones re-verified by hand:

| Original claim | Reality | Verified |
|---|---|---|
| Build with `--no-copy-to-sequenceserver` | **The flag does not exist**; the command would die on line 1. Copy-to-production is unconditional | ✓ 0 occurrences in source |
| Key the TSV index by `[qseqid, sseqid, staxid]` | Not computable — XML carries no taxid, and the two sides join on a *rewritten* id. Replaced with a positional join | ✓ measured `Hit_id`=`gnl\|BL_ORD_ID\|0` vs TSV `sseqid`=`1` |
| Resolve config entry by taxid first | taxid is not unique per entry — **SGD has 11 entries sharing one**. Would break five working deployments | ✓ WB 5, SGD 11, FB 5 |
| Gate the Alliance link branch on assembly name | FB (7 versions) and SGD (2) use those exact names; the branch would intercept 200 FB entries | ✓ confirmed in every config |
| config/config-dev split "does not affect this work" | The pipeline writes config to **config-dev only**; prod would serve new databases against the 2024 config | ✓ separate trees, `CONFIG_DEPLOY_ROOT` |
| Repointing rat/zebrafish is a product decision | **RGD already serves GRCr8**; **ZFIN serves no genome assembly**. Objection evaporates | ✓ both confirmed |
| "The page offers blastp/blastx/tblastn against nothing" | False for `tblastn`, which is the deployment's only compelling use case | ✓ offered in `searchdata.json` |
| Step 8 (build): "Effort: Weeks" | The cited log measures **35 s** for a 442 MB genome; the whole build is ~an hour | ✓ from the 2024 log |
| Add per-entry FASTA cleanup | Already implemented; a no-op, and the disk arithmetic leaning on it was wrong | ✓ `create_blast_db.py:210-226` |
| Smoke test asserts "at or above the current floor" | The current floor is 1 — the broken state. Must assert the post-build count | — |
| Options defaults changed fork-wide | Changes first-search behaviour for five working deployments; removed from scope | — |
| No user story or success criterion | Added: a curator running one `tblastn` across member organisms | — |

Also adopted: the existing `--validate` and `--skip-md5-check` flags replace
invented equivalents; rat GRCr8 is already built and can be reused; common-name
search and tree flattening moved into scope; `taxdb` reconsidered; the CI
`concurrency: cancel-in-progress` hazard added to Step 2; orphaned-directory
cleanup added to Step 4.
