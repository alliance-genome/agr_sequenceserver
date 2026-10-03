# The Alliance BLAST system, end to end

Alliance BLAST is three repositories and one directory on a disk. The
repositories are easy to find and read. The directory is the part that is never
written down anywhere, and it is where almost all of the surprising behaviour
comes from, so it gets the longest section below.

| Repository | What it owns |
|---|---|
| `agr_blast_service_configuration` | JSON that *declares* each database: where its FASTA comes from, its taxonomy, its genome-browser block. One file per MOD per release. |
| `agr_blastdb_manager` | A Python pipeline that reads one of those files, downloads each FASTA, runs `makeblastdb`, writes a gene-name index beside each database, and copies the result onto the shared volume. |
| `agr_sequenceserver` (this repo) | A Sinatra + React fork of wurmlab/SequenceServer that serves whatever it finds on that volume, and nothing else. |

The handoff is deliberately thin and almost entirely implicit. The
configuration repo does not know the manager exists; the manager is pointed at a
config file by hand on the command line; and the server has no idea either of
them exists. It discovers databases by running `blastdbcmd -recursive -list`
over a directory on every request. There is no registry, no migration, no
service discovery, and no API between the three. Each piece's contract with the
next is a filesystem layout.

That is not a complaint. It is why a release can be published by copying files,
and why nothing needs to be deployed when the data changes. It is also why a
renamed FASTA file silently breaks genome-browser links, and why
`/blast/ALLIANCE/prod/` has served one of its nine declared genomes since 2024
without anything reporting an error. Both of those are explained below.

## The shared volume is the real interface

On the host this document was written from, all three running containers mount
the same database directory, and one of two config directories:

```
/var/sequenceserver-data/blast   -> /db                                   (all three containers)
/var/sequenceserver-data/config  -> /sequenceserver/public/environments    (agr-blast-prod)
/var/sequenceserver-data/config-dev -> /sequenceserver/public/environments  (agr-blast-dev, agr-blast-restyle)
```

Under `/db` the layout is `MOD / release / databases / …`, and below
`databases/` the directory structure is whatever the manager chose — usually
`genus/species/sanitised_blast_title/`, but SGD's main set uses its
`seqcol_type` field instead, giving
`S288C_Reference_Strain_ORFs_DNA_only/ORF_coding/`
(`agr_blastdb_manager/src/create_blast_db.py:85-102`).

Several things follow from this, and they are the facts worth internalising
before changing anything.

**The server owns no data.** It has no database, no cache of what exists, and
no startup inventory. `database_dir_for` (`lib/sequenceserver/routes.rb:561`)
turns the two URL segments into `/db/:mod/:version/databases`, and every route
that touches a database re-scans that directory before using it. A release
appears the moment its directory does, and disappears the moment it is removed.
The only state the server keeps is finished jobs, and those live inside the
container at `/root/.sequenceserver` with a 12-hour `:job_lifetime`
(`public/configs/sequenceserver.conf`), not on the volume — so a result URL is
only valid on the container that ran the search, and replacing a container
discards its history.

**Three containers serve the same bytes.** Asking each of the three for the
same release returns the same 200 FlyBase databases:

```
port 4568 (agr-blast-prod,    agr-blast:fda1db1f)  -> 200 databases
port 4569 (agr-blast-dev,     agr-blast:b435058e)  -> 200 databases
port 4570 (agr-blast-restyle, agr-blast:restyle)   -> 200 databases
```

They differ only in code. There is no per-container data, which means there is
also no way to stage a data change: a build is live on dev, prod and the test
instance simultaneously.

**A rebuild needs no deploy, and cannot be rolled back.** The manager's
`copy_to_production` `shutil.rmtree`s the destination before `copytree`
(`agr_blastdb_manager/src/utils.py:118-128`), writing straight into
`/var/sequenceserver-data/blast`. Nothing is versioned, nothing is swapped
atomically, and a failure halfway through leaves that release serving nothing.
Publishing also runs when *at least one* entry in a run succeeded, not when all
of them did — which is the mechanism behind the ALLIANCE failure described at
the end.

**Config travels the same way, as a verbatim copy.** The `environment.json`
the server reads for a release is the configuration repo's JSON file, unchanged:

```
$ md5sum /var/sequenceserver-data/config-dev/FB/FB2026_03/environment.json \
         agr_blast_service_configuration/conf/FB/databases.FB.FB2026_03.json
1be0fe3d77517c7f7123749fae5e1849  …/environment.json
1be0fe3d77517c7f7123749fae5e1849  …/databases.FB.FB2026_03.json
```

Byte-identical. `copy_config_file` renames the file and copies nothing else
(`agr_blastdb_manager/src/utils.py:38-54`). So when the server reads
`environment.json` to decide whether a hit gets a JBrowse link, it is reading
the configuration repo's file as committed. Databases, however, go to
production while config goes to `config-dev` by default
(`CONFIG_DEPLOY_ROOT`, `agr_blastdb_manager/src/utils.py:151`); promoting
config is a separate manual `cp -a`. At the time of writing the two
directories happen to be identical, but nothing enforces that.

**The index files are part of the interface, and they are large.** Beside each
BLAST database the manager writes `<db>.names.json`, a flat JSON map from a
lower-cased identifier (accession, locus tag, gene symbol) to the accession to
retrieve. Across the volume:

```
*.names.json          2387 files   1.36 GB
*.names.display.json  2383 files   1.33 GB
```

Per MOD, `.names.json` is 1,560 files and 928 MB for FlyBase, 495 files and
169 MB for SGD, 306 files and 162 MB for WormBase, 16 files and 134 MB for
ZFIN, nine files and 0.3 MB for RGD. These exist because the alternative is
reading every defline of every database on every lookup: on SGD's fungal set
that is around 100 coding databases and ~1.3M entries, so a miss has to read
all of them (`lib/sequenceserver/routes.rb:606-612`). The gene-search box
therefore greps the *raw text* of each index for the quoted key before parsing
any of them, which on this host took a search from 1.2s to 0.19s
(`lib/sequenceserver/routes.rb:715-735`).

The second file, `.names.display.json`, records the spelling the source
database actually uses (`{"dll": "Dll", "cg2759": "CG2759"}`) so the result
list does not show lower-cased keys. Both halves of that are now on `main`: the
server reads it, and the writer landed in `agr_blastdb_manager` as `92fdc2a`,
"Record the spelling each gene name is actually written with" (#72) —
`write_display_names` at `src/utils.py:705`, called from `build_name_index` at
`src/utils.py:792`, which `run_makeblastdb` invokes at
`src/create_blast_db.py:364` while the FASTA is still on disk. So a build from
the manager's `main` today does write them. The 2,383 files currently on disk
predate that merge: they came from a backfill run, which can write the spelling
file on its own and leave `.names.json` alone
(`bin/backfill_name_indexes.py --display-only`).
The server degrades to the lower-cased key when the file is absent
(`lib/sequenceserver/routes.rb:802-814`), which is also the normal case for a
database whose names are all lower case already — the writer emits nothing
there, because the key is the spelling.

## One FlyBase file, one curator's hit

The chain below is the whole system. Every step was checked on this host.

**1. A line in the config repo.** `conf/FB/databases.FB.FB2026_03.json`
declares 200 entries. One of them:

```json
{
  "blast_title": "D. melanogaster Transcripts 6.69",
  "genus": "Drosophila", "species": "melanogaster",
  "md5sum": "34b1293e7c7651da88f9ef79d313531b",
  "seqtype": "nucl", "taxon_id": "7227", "version": "6.69",
  "uri": "https://s3ftp.flybase.org/alliance/blast/dmel-transcript.fasta.gz"
}
```

Despite the field being described everywhere as an FTP link, FlyBase's are
HTTPS URLs against an S3 mirror; NCBI-derived entries in the same file really
are `ftp://`. The manager handles both (`get_files_http`, `get_files_ftp`).

**2. The manager downloads it and checks the MD5.** `-e/--environment`
defaults to `dev` and decides the release directory name; it is not derived
from the config filename or from the `release` field in the file's metadata.
That is why the URL segment can look like nothing in the config repo: the
config deployed at `/blast/SGD/R64-5-1m/` is
`conf/SGD/databases.SGD.test.2025-10-07.json` (183 entries, `dateProduced`
2025-10-07, `release` `SGD:R64-5-1`, and a `data` section identical entry for
entry), and `/blast/SGD/R64-5-1f/` is `databases.SGD_fungal_test.2025-10-11.json`
(312 entries). Both files are still called *test* in the repository. When the
pipeline is driven by `-g conf/global.yaml` instead, the environment string
comes from that YAML (`create_blast_db.py:458-471`).

**3. `makeblastdb -parse_seqids`, and the one case where that mattered.**
Every MOD except ZFIN is built with `-parse_seqids`, which refuses duplicate
sequence ids; the flag is mandatory in the pipeline and ZFIN is the one coded
exemption (`create_blast_db.py:274-280`), though several releases still on the
volume predate that rule. The file above is assembled by FlyBase from six of
their exports with four of them included twice: 39,891 records under 35,738
distinct ids. For
a period `makeblastdb` rejected it, the database simply was not there, and
curators reported that the option to search annotated transcripts had
disappeared — no error surfaced anywhere, because a database that fails to
build is indistinguishable from one that was never declared. The manager now
de-duplicates before building (`create_blast_db.py:131-252`), explicitly as a
workaround rather than a fix; FlyBase's own exports are clean and the
assembly script is the defect. The database on disk today holds exactly 35,738
sequences, which is the de-duplicated count.

**4. The output path, and the database's name.** The directory comes from
genus, species and the sanitised `blast_title`; the database basename comes from
the *FASTA filename* with its extensions replaced by `db`:

```
/db/FB/FB2026_03/databases/Drosophila/melanogaster/D_melanogaster_Transcripts_6_69/dmel-transcriptdb.*
```

That `dmel-transcriptdb` is load-bearing far downstream — see step 8.

**5. The name index is written from the same FASTA, while it is still on
disk** (`create_blast_db.py`, the `build_name_index` call in
`run_makeblastdb`), then the FASTA is deleted — cleanup is
on by default (`--cleanup`, `default=True`). For databases built before
indexing existed, `bin/backfill_name_indexes.py` recovers the deflines with
`blastdbcmd` instead of re-downloading, which the script puts at around 76 GB
of FASTA avoided, and derives names with the same `index_entries()` the build
uses so the two cannot disagree. On FlyBase the deflines carry only the symbol
(`w`, not `white`), so the index is widened with FlyBase's own synonym table
(`gene_aliases()`, `flybase_aliases()` in the manager's `src/utils.py`).

**6. Publish.** Databases are copied to `/var/sequenceserver-data/blast/FB/FB2026_03/databases/`
and the config JSON to `…/config-dev/FB/FB2026_03/environment.json`. All three
containers now see both. Nothing was restarted.

**7. A curator finds a gene.** On the search form, typing into the gene box
hits `/blast/:mod/:version/gene_search?q=…`. Live, on the dev container:

```
$ curl -s 'localhost:4569/blast/FB/FB2026_03/gene_search?q=act5c'
[{"symbol":"Act5C","accession":"FBpp0070788",
  "database_id":"ca7661911a8e4edc8e900c4b6722631a",
  "database_title":"D_melanogaster_Proteins_6_69","type":"protein",
  "organism":"Drosophila melanogaster"},
 {"symbol":"Act5C","accession":"FBtr0070823",
  "database_id":"5c5b941c52567bd01eacdcfec8f3b2b7",
  "database_title":"D_melanogaster_Transcripts_6_69","type":"nucleotide",
  "organism":"Drosophila melanogaster"}]
```

The `database_id` is the MD5 the server keys its collection on; the form posts
it back to `get_sequence` to fetch the record and uses it to tick that database
in the tree (`public/js/gene_search.js:124-140`). The title beside it is for
the human.

0.5s, and the gene box is the only thing that looks at all 928 MB of FlyBase
indexes; a `?name=` lookup reads them one at a time until it matches.
The box returns a *list* rather than resolving to one sequence on purpose: 16 of
SGD's fungal databases carry an `act1`, and the older `?name=` deep link took
the first match, so a curator typing ACT1 was silently handed *Candida
albicans* (`lib/sequenceserver/routes.rb:147-158`). The organism label comes
from `environment.json` — a BLAST database carries no organism of its own, only
its directory categories, which on SGD's fungal set are clades such as
`Agaricomycetes_mushrooms_allies` rather than species.

**8. The search runs, and the hit is matched back to its config entry.** This
is the step that is easy to miss. Given a hit, `Hit#links` takes the database's
file basename, strips the trailing `db`, and looks for that string inside each
config entry's `uri` (`lib/sequenceserver/blast/hit.rb:83-118`). So
`dmel-transcriptdb` becomes `dmel-transcript`, which appears in
`https://s3ftp.flybase.org/alliance/blast/dmel-transcript.fasta.gz`, and that
entry's `genome_browser` block is the one used. **The download URL is also the
join key between a served database and its metadata.** Rename a source file
upstream and the databases still build, still serve and still answer searches —
they just quietly stop producing genome-browser links.

Verified on a stored job against SGD's ORF set (`YeastORFdb` →
`YeastORF.fsa.gz`):

```
hit YFL039C, gene_symbol ACT1
  Alliance: ACT1 -> https://www.alliancegenome.org/gene/SGD:S000001855
  JBrowse        -> https://www.alliancegenome.org/jbrowse2/?loc=chrVI%3A50388..57568
                    &tracks=Saccharomyces_cerevisiae_all_genes%2Cblasthits&sessionTracks=…
```

The `chrVI` there is not in the data: it is derived per MOD from the hit's
defline and its genome-browser metadata, because WormBase writes Roman
numerals, FlyBase writes arm names and RGD writes `ChrN`
(`lib/sequenceserver/links.rb:378-437`). `docs/GENE_SEARCH.md` covers the
symbol and link extraction in detail.

**9. The browser polls.** The results page is served as a shell; it polls
`location.pathname + '.json'` until the job is done (`public/js/report.js:47`)
and then adds one HSP every 25ms so a large report does not lock the tab
(`public/js/hits.js:44-55`).

## Why the URL carries the MOD and the release

Upstream SequenceServer is one deployment with one `database_dir`, fixed at
startup, serving one set of databases at `/`. This fork serves
`/blast/:mod/:version/…` and resolves the database directory per request from
those two path segments. The container config still sets `:database_dir: "/db"`,
but that is now only the root the per-request path is built under.

The reason is the shape of the problem rather than any preference. The page
chrome recognises seven MOD identifiers — FB, MGD, RGD, SGD, WB, ZFIN, XB, plus
AGR for the Alliance itself (`views/layout.erb:53-62`) — and each MOD publishes
on its own cycle, with older releases kept live because papers and curator
bookmarks point at them. FlyBase alone has eight releases on disk. Running one
container per MOD per release would be dozens of containers over one copy of the
data, each holding its own scan of it. Putting the MOD and release in the path
instead means one image, any number of releases, and a new release needs no
configuration change at all.

The costs are real and specific:

- Nothing is loaded once at boot, so the per-request scan is on the hot path of
  every page. `@makeblastdb ||=` is per-request memoisation, not a cache. It is
  cheap enough in practice — `searchdata.json` for FlyBase's 200 databases
  answers in 0.14s on this host — but it is paid again on every request, and it
  scales with the number of databases in the release, not with the search.
- Request-scoped database state is a class-level global
  (`Database.collection = …`). The search `POST` used to validate the submitted
  database ids against whatever collection an earlier, unrelated request had
  left behind — fine while consecutive requests were for the same MOD, and
  `400 Database id should be one of …` when two MODs were searched at once.
  Fixed on `main` by loading the request's databases first
  (`lib/sequenceserver/routes.rb:237-246`); the image running as
  `agr-blast-prod` predates that fix.
- The path depth is itself an assumption. `get_categories` used to take
  `path.split('/')[4..-1]`, hard-coding the four segments of
  `/db/:mod/:version/databases/`, and kept the database filename as a tree
  level, giving the search form five levels: genus, species, the sanitised
  blast title, the database filename, and then the checkbox — whose label is
  `db.title` (`lib/sequenceserver/database.rb:196-202`), which is that same
  sanitised blast title again. On the *A. echinatior* genome that read
  `Acromyrmex`, `echinatior`, `A_echinatior_Genome_Assembly_GCF_024713525_1_…`,
  `GCF_024713525db`, and then that long title once more as the checkbox. It now
  computes the path relative to the scanned directory and drops the filename
  (`lib/sequenceserver/makeblastdb.rb:339-344`, commit `019664b6`). The title
  still appears twice, as the last directory level and as the checkbox label;
  what went was the filename wedged between them.

Two conveniences sit on top of the scheme. `/blast/:mod/` redirects to the
newest release, sorting on the numeric components so `WS298` beats `WS99`, and
skipping anything named `dev`, `test` or `staging` — or merely *ending* in
`test`, which is the clause that actually matters on this volume, since it is
what keeps `/blast/ZFIN/` on `prod` rather than on `zfintest`, the only other
ZFIN directory there (`lib/sequenceserver/routes.rb:95`, route at `:97-121`).
And because SGD ships two sets in parallel that differ only by a trailing
letter — `R64-5-1m` (yeast) and
`R64-5-1f` (fungal) — neither of which is "newer", there are named aliases
`/blast/SGD/yeast/` and `/blast/SGD/fungal/`
(`lib/sequenceserver/routes.rb:395-428`). Live:

```
/blast/WB/        -> 302 /blast/WB/WS298/
/blast/FB/        -> 302 /blast/FB/FB2026_03/
/blast/SGD/       -> 302 /blast/SGD/R64-5-1m/
/blast/SGD/yeast/ -> 302 /blast/SGD/R64-5-1m/
/blast/ZFIN/      -> 302 /blast/ZFIN/prod/
```

## What is actually served

Measured on the volume, per MOD and release:

| MOD | Release | Databases | Nucleotide | Protein |
|---|---|---|---|---|
| FB | FB2024_02 | 197 | 132 | 65 |
| FB | FB2024_04 | 169 | 113 | 56 |
| FB | FB2025_01 | 200 | 134 | 66 |
| FB | FB2025_03 | 194 | 130 | 64 |
| FB | FB2025_05 | 200 | 134 | 66 |
| FB | FB2026_01 | 200 | 134 | 66 |
| FB | FB2026_02 | 200 | 134 | 66 |
| FB | FB2026_03 | 200 | 134 | 66 |
| SGD | R64-5-1f | 312 | 208 | 104 |
| SGD | R64-5-1m | 183 | 125 | 58 |
| WB | WS298 | 63 | 32 | 31 |
| WB | dev | 61 | 31 | 30 |
| ZFIN | prod | 7 | 7 | 0 |
| ZFIN | zfintest | 9 | 9 | 0 |
| RGD | 8.3.0 | 9 | 9 | 0 |
| ALLIANCE | prod | 1 | 1 | 0 |

The volume is not on its own filesystem: it sits on the host root, which is
170 GB used of 250 GB (68%). Disk exhaustion there is not hypothetical — it is
what killed seven of the nine ALLIANCE builds in 2024.

`environment_info.json` sits beside the per-release configs and reads like the
list of releases the service intends to advertise: it names `FB/FB2026_03`,
`WB/WS298`, `SGD/R64-5-1m` ("Yeast BLAST"), `SGD/R64-5-1f` ("Fungal BLAST") and
`RGD/8.3.0`, with display names and contacts, and no ZFIN or ALLIANCE at all.
Nothing reads it — see below. Every release on the volume is reachable by URL
whether it appears there or not.

Two MODs named in this repo's own documentation are not here at all. XenBase
has a config file (`conf/XB/databases.XB.5.5.1.json`), an entry in the config
repo's `global.yaml` and a legacy `conf/sequenceserver.xenbase.conf`, but no
data on the volume. MGD appears only in the page chrome — three branches of the
MOD maps in `views/layout.erb` (`:55`, `:67`, `:78`), an entry in the footer's
Members nav (`views/_alliance_footer.erb:35`, a link to
`alliancegenome.org/members/mgd` rather than anything MOD-segment driven) — and
a comment in `links.rb:613`. Neither is served.

## What is broken or unfinished

These are the ones that matter for understanding the system, not a complete
bug list.

**`agr-blast-prod` is seven merged PRs behind.** It runs `agr-blast:fda1db1f`
(PR #23); `main` is `73e4a38a` (PR #30), and `git log fda1db1f..main` is seven
commits, #24 through #30. It has no gene search (`gene_search` returns 404 on
port 4568) and carries the request-scoped-database concurrency bug described
above, which was fixed in #24. Because it reads the same volume, every index and
display file is already on disk for it. The three request-handling defects the
October audit found — the job id that became a filesystem path, the `%2F`
traversal on the asset routes, and the uncapped `?query=` fan-out — are not
prod-specific: they are on `main` too, and so live on all three containers
as of `b435058e` (#31). `docs/AUDIT_2026-10.md` has them.

**ZFIN and RGD deflines carry no gene symbols**, so gene search cannot answer
for them at all. Both would need defline standardisation or an external lookup.
ZFIN is worse than that: it is the one MOD the pipeline deliberately builds
without `-parse_seqids`, so when its indexes were backfilled through
`blastdbcmd` every accession came back as a placeholder. All sixteen ZFIN index
files are 100% `BL_ORD_ID:N` keys — 3.6 million of them, 134 MB on disk, not
one usable name. Rebuilding them is pointless until the databases themselves
are rebuilt with `-parse_seqids`.

ZFIN is not the only release affected, which is the part the known-issues list
used to get wrong. Checking the first key of every index on the volume finds
`BL_ORD_ID` in 753 of the 2,387: the 16 ZFIN files and the single ALLIANCE one,
but also 557 across `FB/FB2024_04`, `FB/FB2025_01` and `FB/FB2025_03` and 179
across the three retired WormBase releases. No policy exempted those; whatever
produced them, nothing re-checks a database once it is published, so they stay
as built. Since `ddce9418` the gene box skips any candidate whose accession
starts with `BL_ORD_ID:` (`lib/sequenceserver/routes.rb:677`, `:767`), so those
databases now contribute nothing to the list rather than fifty rows that fail
when clicked. That makes the box honest, not correct: the indexes are still
unusable.

**ALLIANCE/prod serves one of nine declared genomes.** The config was written
on 2024-03-21 naming nine reference genomes. One build ran against it, on
2024-10-09, for 65 seconds: C. elegans failed on a stale MD5, seven failed with
`[Errno 28] No space left on device`, zebrafish built. The run exited 0, and a
year later `copy_to_production` shipped the one database that had succeeded.
Nothing alerted, because publishing on partial success is the designed
behaviour. The config has not been content-edited since the day it was written,
and still spells two of its nine species `xenupus laevis` and
`xenupos tropicalis`. `docs/ALLIANCE_WIDE_PLAN.md` is the plan to fix it;
`agr_blastdb_manager/docs/alliance_2024_build_failure.md` is the post-mortem.

**The one ALLIANCE database that did build was built without `-parse_seqids`,**
so its accessions come back as `BL_ORD_ID:0`.

**Manager citations here are against `origin/main`, not the checkout on this
host.** `/home/ec2-user/gitroot/agr_blastdb_manager` sat six commits behind at
`2c5da0e` while the first pass of these documents was written, which produced a
crop of false claims — that the manager had no per-MOD defline grammars, no
FlyBase synonym widening, no move to `uv` and no display-name writer. All four
are on `main`, which is `92fdc2a`. The checkout has since been fast-forwarded
and now sits one commit *ahead* of `origin/main`, on the working branch
`zfin-defline-prefix`, so line numbers read out of it are not the ones a reader
of `main` will see. The manager line citations in this document are
`origin/main`'s.

**The configuration repo's `global.yaml` has not kept up.** It lists WB
`WS291`/`WS292`, FB `FB2024_04`, SGD `2024-06-13`, XB `5.5.1` and ALLIANCE
`prod`. Of those, only `ALLIANCE/prod` is on the volume. Since `-g` derives the
release directory name from this file, none of the releases actually being
served could have come from a `-g` run against it; they are `-j` runs with an
explicit `-e`. The file is still what the validator walks, so it is not dead,
but it is not an inventory of anything.

**`sitemap.xml` is stale.** It lives on the volume
(`/var/sequenceserver-data/blast/sitemap.xml`) and is served at
`/blast/sitemap.xml`. Two of its five URLs 404: `WB/WS292` no longer exists and
`SGD/main` never did (the aliases are `yeast` and `fungal`). A third,
`WB/dev`, works — so the sitemap hands search engines the one release name the
`/blast/:mod/` redirect goes out of its way to treat as non-public.

**`POST /cloud_share` and its CSRF exemption are removed on
`harden-request-handling`, and still live on everything deployed.** The
Share-results panel went out of the UI in #26, but the route, `rest-client` and
the `skip: ['POST:/cloud_share']` on `Rack::Csrf` stayed behind on `main`
(`routes.rb:5`, `:71`, `:384` as `main` numbers them), so all three containers
are still serving an unauthenticated, CSRF-exempt relay to a third party that
nothing in the UI can reach. `ddce9418` deletes the route, the component, both
specs, the dead state and props in `report.js` and the dependency;
`Rack::Csrf` is now installed with no exemption at all
(`lib/sequenceserver/routes.rb:70`). The branch is not merged. Why it mattered
rather than being merely untidy is in `docs/AUDIT_2026-10.md`: the relay could
not be switched off, because the guard tested truthiness while the documented
value to disable it was the string `'disabled'`, and it did not `halt`, so an
unfinished job was relayed regardless.

**`GET /blast/environment_info.json` has no consumer.** The route exists and
the file is on the volume, but nothing in `public/js/` or `views/` fetches it;
the only other references are the manual smoke test and
`docs/ALLIANCE_WIDE_PLAN.md`.

## Where to go next

- `docs/ARCHITECTURE.md` — the web app itself: routes, the BLAST job and report
  pipeline, the React component trees, the plugin aliases.
- `docs/AUDIT_2026-10.md` — the October sweep of all three repos: what was
  fixed on `harden-request-handling`, what is still wrong in the data, and
  which findings the verifier got wrong in each direction.
- `docs/DEPLOYMENT.md` — the containers, the image tagging convention, the
  volumes, and how a release is actually promoted.
- `docs/GENE_SEARCH.md` — the gene box, `?name=` deep links, defline grammars
  per MOD, and the display-casing file.
- `agr_blastdb_manager/docs/PIPELINE.md` — the build, from config file to
  published directory, including `-parse_seqids` policy and the publish step's
  lack of staging.
- `agr_blastdb_manager/docs/NAME_INDEX.md` — what goes into `.names.json`, how
  each MOD's deflines are parsed, and how to backfill.
- `docs/ALLIANCE_WIDE_PLAN.md` — the cross-species deployment: what it is for,
  why it serves one genome, and the plan to get the other eight back.

Unverified from this host: whether `www.alliancegenome.org/blast/` resolves
here. This host's TLS certificate is for `blast-dev.alliancegenome.org`, and its
nginx proxies `*.alliancegenome.org` on 443 to port 4569 (the dev container) and
on 80 to port 4568 (`/etc/nginx/nginx.conf:33-60`) — so on this machine the
HTTPS service is the dev image, not the prod one. `docs/DEPLOYMENT.md` is the
place that should settle the public mapping.
