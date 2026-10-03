# How the AGR BLAST web app works

This is the Alliance of Genome Resources fork of SequenceServer. It is still a
Sinatra app serving a React front end over BLAST+, but one structural decision
separates it from upstream and almost every other difference follows from it:
**a single process serves every MOD and every data release, and it decides which
BLAST databases exist by reading the URL.** Upstream scans one `database_dir`
once at boot and holds the result for the life of the process. Here, `init`
never scans anything — `SequenceServer.init_database` is still defined at
`lib/sequenceserver.rb:191` but nothing calls it; the call was deleted in
6e969b2c ("made it so that the urls is /blast/<mod>/<environment>", Adam Wright,
2023-11-17) along with the `SequenceServer.makeblastdb` singleton. Only
`init_database`'s definition came back in a later upstream merge. The singleton
did not: there is no `def makeblastdb` anywhere in `lib/sequenceserver.rb`, and
`init_database`'s own body calls it twice (`lib/sequenceserver.rb:202` and
`:204`), so the method is not merely uncalled — it would raise `NoMethodError`
if anything did call it. Every route that needs databases scans for them itself,
through a per-request `makeblastdb` helper of the Sinatra app's own
(`routes.rb:576`).

`CLAUDE.md` carries a sketch of this. Where the two disagree, this document is
the one that was checked against the code and against the running containers.

## The shape of a deployment

Three containers run from one image lineage, all mounting the same data volume:

| container | image | host port | `public/environments` from |
|---|---|---|---|
| `agr-blast-prod` | `agr-blast:fda1db1f` | 4568 | `/var/sequenceserver-data/config` |
| `agr-blast-dev` | `agr-blast:b435058e` | 4569 | `/var/sequenceserver-data/config-dev` |
| `agr-blast-restyle` | `agr-blast:restyle` | 4570 | `/var/sequenceserver-data/config-dev` |

All three mount `/var/sequenceserver-data/blast` at `/db` and all three run
`sequenceserver -c /sequenceserver/public/configs/sequenceserver.conf`. dev and
prod carry `HTTPS=on`; the test instance deliberately does not, so it is
reachable over the internal address in a browser. dev and prod are tagged with
the 8-character `main` commit they were built from, which is how you tell at a
glance that prod is eight merged PRs behind: `fda1db1f..b435058e` is PRs #24
through #30.

`docker-compose.yaml` describes something else entirely — four per-MOD services
on ports 5001-5004, each with its own `conf/sequenceserver.<mod>.conf` and its
own `./db/<mod>` volume. Nothing deploys that way any more. The same goes for
`conf/sequenceserver.{wormbase,flybase,sgd,xenbase}.conf`: they are not the
config the containers load, and two of them still say
`:databases_widget: classic`, which is not how any live deployment renders its
database list.

A URL is `/blast/:mod/:version/...`. `:mod` is the member abbreviation (`WB`,
`FB`, `SGD`, `RGD`, `ZFIN`, plus `ALLIANCE` for the Alliance-wide build) and
`:version` is a release directory under it. What the test instance serves today:

```
FB        FB2024_02 … FB2026_03    8 releases, 169-200 databases each
SGD       R64-5-1f                 312 databases (208 nucleotide, 104 protein)
SGD       R64-5-1m                 183 databases (125 nucleotide,  58 protein)
WB        WS298                     63 databases
WB        dev                       61 databases
ZFIN      prod / zfintest            7 / 9 databases, nucleotide only
RGD       8.3.0                      9 databases, nucleotide only
ALLIANCE  prod                       1 database
```

`XB` and `MGD` appear in the logo and name maps in `views/layout.erb` but no
such directory exists under `/db`, so there is no XenBase or MGD deployment.

A release is retired on this volume by renaming its directory with a leading
dot: `/db/WB` also holds `.retired-WS295`, `.retired-WS296` and
`.retired-WS297`. Those are not served — `VALID_VERSION_SEGMENT`
(`routes.rb:559`) requires the first character of a release segment to be a
letter, digit, underscore or dash. They were served, in full, until that was
tightened, which is to say retiring a release did nothing at all.

## A search, from URL to rendered report

**The search page.** `GET /blast/:mod/:version/` lands at
`lib/sequenceserver/routes.rb:430`. It resolves and validates the directory
(`database_dir_for`, `routes.rb:561`), runs a scan, assigns
`Database.collection`, logs a warning for any database built without
`-parse_seqids` or still in BLAST v4 format, and renders `views/search.erb`
inside `views/layout.erb`. The HTML it returns contains almost nothing: an empty
`<div id="view">`, the advanced-options modal markup, and a `<script>` for
`sequenceserver-search.min.js`.

**Populating the form.** `Form#componentDidMount` (`public/js/form.js:45`)
recovers the MOD and version by splitting `window.location.href` on `/` and
taking elements 4 and 5 (`form.js:62-63`), then fetches
`/blast/:mod/:version/searchdata.json`, with the path rebuilt from those two
strings. Deriving it from array indices rather than from a value the server
rendered hardcodes the assumption that `/blast/` sits at the root of the host:
every route in the app is written `/blast/...` absolutely, and upstream's
`:root_path_prefix` setting (`routes.rb:37`) survives only as a helper
(`routes.rb:883`) that no template or route calls. Serving this fork under a
subpath is not supported.

`searchdata.json` (`routes.rb:180`) is the one response the form needs. It scans
the directory again for this request, assigns the collection, and returns the
database list, the advanced-option presets from the server config, the BLAST
task map, the jstree node list when `databases_widget` is `tree`, and
`public/configs/database_order.json` if present. It also handles two forms of
pre-filling: `?query=` is treated as accessions and resolved through
`Database.retrieve` (`routes.rb:187`, capped — see below), and
`?name=YFL039C&type=dna` resolves a gene symbol or locus tag to a sequence
(`lookup_sequence_by_name`, `routes.rb:635`).

**Submitting.** The form posts to its own URL (`form.js:148`), which reaches
`POST /blast/:segment1/:segment2` at `routes.rb:218` and
`handle_blast_request`. That builds a `BLAST::Job`, which validates the method,
the sequence, the submitted database ids and the advanced options
(`lib/sequenceserver/blast/job.rb:120`), writes `query.fa` and a serialised
`job.yaml` into `~/.sequenceserver/<uuid>/`, resolves the submitted ids into
`Database` objects it then *carries* (`blast/job.rb:27`), and hands itself to a
thread pool (`lib/sequenceserver/job.rb:88`). The response is a 302 to
`/blast/:mod/:version/:jid`.

The pool is sized from `:num_jobs`, which is `1` in the live config, so BLAST
searches run strictly one at a time regardless of how many requests arrive. The
command is assembled in `BLAST::Job#command` (`blast/job.rb:71`) and
deliberately not memoised — memoising it cached `-num_threads` from whichever
job built the string first and reused that value for every later job, which is
the upstream bug taken as `wurmlab/sequenceserver a3d047ac`. Output format is
fixed at `-outfmt '11 qcovs qcovhsp'`: BLAST archive format, so the same run can
later be reformatted to XML, TSV, pairwise or either tabular form without
re-searching.

**Polling.** `GET /blast/:mod/:version/:jid` (`routes.rb:293`) only loads the
job's `job.yaml` through `Job.fetch` — a 404 if the id is not uuid-shaped or the
file is absent (`lib/sequenceserver/job.rb:58-71`) — and renders
`views/report.erb`, which loads `sequenceserver-report.min.js`. The bundle then
polls `/blast/:mod/:version/:jid.json` on a backing-off schedule of
200, 400, 800, 1200, 2000, 3000, 5000 ms, holding at 5 s
(`public/js/report.js:52`), treating 202 as "not finished" and 200 as the
result.

**Parsing.** The JSON route (`routes.rb:264`) reads
`/sequenceserver/public/environments/<mod>/<version>/environment.json` — an
absolute path, not one derived from `settings.root` — and passes its `data`
array into `BLAST::Report`. The report runs `Formatter` twice over the archive,
once to XML and once to a custom TSV, and is `done?` only when both files exist
(`lib/sequenceserver/blast/report.rb:50`). The XML goes through Ox into a nested
array (`node_to_array`/`node_to_value`, `report.rb:229-244`) and the TSV into a
`{qseqid => {sseqid => [sciname, qcovs, [qcovhsp]]}}` hash (`report.rb:259`),
because BLAST's XML carries neither `qcovs` nor scientific names. The two are
joined per hit in `query_hits` (`report.rb:166`).

One rewrite happens there that matters downstream. A hit from a database built
without `-parse_seqids` has `Hit_id` of the form `gnl|BL_ORD_ID|7`;
`report.rb:177-183` moves that into the accession field and splits the defline
to recover something displayable as id and title. Upstream's comment
(`report.rb:170-176`) gives the reason as "accession is what blastdbcmd expects
for non -parse_seqids databases". That is the intent, not a property of these
databases: on the ZFIN v5 databases neither spelling retrieves anything (see
below), so the rewrite buys a displayable id and title and nothing else.

All seven ZFIN databases are in that state. Checked directly:

```
$ blastdbcmd -db /db/ZFIN/prod/databases/.../VEGA_Transcript/vega_transcript.fa \
             -entry all -outfmt "%a|%i|%t" | head -1
BL_ORD_ID:0|gnl|BL_ORD_ID|0|tpe|OTTDART00000003965|OTTDARG00000003778|ZDB-GENE-030616-226 itsn1|…
```

That is why ZFIN's gene identifiers have to be looked for in `Hit_id` rather
than the accession (`links.rb:666-671`), and it is the same condition that
leaves `ALLIANCE/prod`'s ZFIN GRCz11 database returning `BL_ORD_ID:0`.

The app's own detector does not catch it. `Database#non_parse_seqids?`
(`lib/sequenceserver/database.rb:82-91`) decides the question for a v5 database
by testing whether a `.njs` or `.pjs` file exists — but in BLAST+ v5 that is the
JSON metadata file, written for every database regardless. The files
`-parse_seqids` actually produces are `.nos`/`.pos` and `.nog`/`.pog`, and those
are exactly what the ZFIN directories are missing while SGD's and WormBase's
have them:

```
ZFIN  VEGA_Transcript    ndb nhr nin njs     not nsq ntf nto
SGD   cds                ndb nhr nin njs nog nos not nsq ntf nto
```

So the predicate returns false for every v5 database, the `non_parse_seqids`
flag in the report JSON (`blast/report.rb:41`) is always false, and the
route-time warning at `routes.rb:438-441` never fires — including for the seven
databases it was written for.

This one is the fork's own. Upstream (`bea64f86`, Anurag Priyam) tested
`(%w[nog nos pog pos] & extensions).length != 2`, which is the correct test and
answers exactly right on this volume: counting `.nos`/`.pos` across the
deployment flags ZFIN/prod's 7 databases and ALLIANCE/prod's 1 — precisely the
eight that genuinely lack `-parse_seqids` — and passes all 63 of WB/WS298, 183
of SGD/R64-5-1m, 200 of FB2026_03 and 9 of RGD/8.3.0. Commit 8164a02a ("getting
close with links...", 2025-08-22) replaced it with `!(extensions & %w[njs pjs]).any?` and
rewrote the v4 branch the same way, under a comment reading "Check that at least
one ID index exists (pjs or njs)" — but `.njs`/`.pjs` is not an ID index, it is
the v5 JSON metadata file that `makeblastdb` writes unconditionally. Every
deployed database has one — FB2026_03 200/200, WB WS298 63/63, SGD R64-5-1m
183/183, ZFIN prod 7/7, RGD 9/9, ALLIANCE prod 1/1, every one of them reporting
format version 5. A working check was traded for one that cannot return true.

If the XML is larger than `:large_result_warning_threshold` the route short-
circuits and returns a payload of download links instead
(`routes.rb:284`, rendered by `Report#warningJSX`), bypassable with
`?bypass_file_size_warning=true`. The live config does not set that key, so it
takes the built-in default of 250 MB (`lib/sequenceserver/config.rb:136`).

**Rendering.** `Hits` does not render the report in one pass. It pushes at most
10 HSPs per cycle (`public/js/hits.js:18`) and schedules the next cycle with
`setTimeout(..., 25)` (`hits.js:55`), so the browser stays responsive on a
report with thousands of alignments; past 250 cycles it sets `veryBig`, which
child components use to drop the expensive parts. Per-hit link generation
(below) happens server-side during `to_json`, not here.

## Per-request databases, and the bug that forced thread-local state

Four facts combine into the interesting part of this design. The server is
WEBrick (`lib/sequenceserver/server.rb`), so each request is handled on its own
thread. `Database.collection` was a single process-wide Hash. Every route
cleared and repopulated it from the URL's directory. And `Database`'s class-level
API — `Database.ids`, `Database.all`, `Database[ids]` — reads that Hash with no
notion of which request is asking.

So two requests for different MODs overwrote each other's databases. A WormBase
search that validated its submitted ids just after an SGD request had replaced
the collection matched none of them and was rejected by
`validate_databases` (`blast/job.rb:146`) with
`Database id should be one of: ...` and HTTP 400.

It was worse than that, because the search POST was the one route that never
loaded its own databases at all. `handle_blast_request` validated against
whatever collection some earlier, unrelated request had left behind — which
worked whenever the previous request on the process happened to be for the same
MOD, which is why it passed almost always and looked like flakiness rather than
a race. The Playwright suite reproduced it only when run with more than one
worker, and its helper had been asserting a CSRF cause that nobody had checked;
the trace says 400, not 403.

Both halves were fixed together in b9d9de72, and both are needed: scoping the
collection without also loading it in the POST makes every search fail, because
the leftover state the POST depended on is then never there.

The POST now does what every other route does (`routes.rb:244-246`):

```ruby
env_database_dir = database_dir_for(params[:segment1], params[:segment2])
makeblastdb(env_database_dir).scan
Database.collection = makeblastdb(env_database_dir).formatted_fastas
```

and the collection became thread-local when assigned off the main thread
(`lib/sequenceserver/database.rb:150-167`):

```ruby
def collection
  Thread.current[:sequenceserver_database_collection] || process_collection
end

def collection=(databases)
  built = {}
  databases.each { |db| built[db.id] = db }
  if Thread.current == Thread.main
    @collection = built
  else
    Thread.current[:sequenceserver_database_collection] = built
  end
end
```

The main-thread branch is what keeps upstream's single-`database_dir` mode
working: set once at boot, read by every request after. In this fork nothing
sets it at boot, so in practice only the thread-local branch is ever taken by
the server.

This is only safe because nothing outside the assigning thread reads the
collection. A job resolves `Database[params[:databases]]` at construction, on
the request thread, and carries the resulting objects; `BLAST::Report` takes
`job.databases` as its `querydb` (`blast/report.rb:28`); `Hit#links` resolves
the hit's database out of that list. So the pool thread that actually runs
`blastn`, and the later request that renders the report, both work from the
job's own copy and never consult `Database.collection`. The report JSON route is
accordingly the one database-touching route that does *not* assign the
collection, and it is correct that it does not.

Measured on the deployed build, 20 interleaved WB/SGD searches per round:
18/20, 18/20 and 20/20 accepted before the fix (four HTTP 400s in 60, plus a
500), and 40/40 across four rounds after. The browser suite went from 3.9 to
2.2 minutes, because nothing waits on a dead submission any more.
`test/manual/smoke-test.sh:501` is the standing check, and it was verified able
to fail: against an image with both fixes reverted it reported 1 × 400 of 12.

**prod does not have this fix.** `agr-blast:fda1db1f` predates b9d9de72, so two
curators searching two MODs on port 4568 at the same moment can still reject
each other's searches.

### What a scan costs

`makeblastdb(dir)` is memoised per Sinatra request instance
(`routes.rb:576`), and Sinatra builds a fresh instance per request, so the scan
runs once per request but on *every* request. The scan is
`blastdbcmd -recursive -list <dir> -list_outfmt "%f\t%t\t%p\t%n\t%l\t%d\t%v"`
(`lib/sequenceserver/makeblastdb.rb:165`), one subprocess over the whole release
tree. Measured on the test instance, `searchdata.json` for SGD's 312-database
fungal set returns in 0.14-0.21 s depending on page-cache state, which is
effectively that scan's floor.

Each row becomes a `Database` struct whose `id` is the MD5 of its path on disk
(`database.rb:33`). That is why examples and the e2e suite match databases by
*title*: an id differs between deployments even for the same data. The tree
grouping comes from `get_categories` (`makeblastdb.rb:339`), which is just the
database's directory path below the release's `databases/` directory, minus the
leaf.

## Request input that became a filesystem path

Reading the URL to decide what exists is the fork's organising idea, and it is
also where the fork's worst defects came from. Three of them were closed
together in `b435058e` (#31); all three were live on every deployment when found,
unauthenticated, and two of them were upstream's rather than the fork's.

**The job id came out of the request.** `Job#initialize` did
`params.fetch(:id, SecureRandom.uuid)`, and `params` there is the search form's
request params passed through whole by `handle_blast_request`. `Job.validate`
checks the method, the sequence, the database ids and the advanced options; it
has never looked at `:id`. Since `dir` is `File.join(DOTDIR, id)`, a POST
carrying `id=../../../../tmp/x` wrote the job directory — `query.fa` included —
anywhere the process could reach, as root in the container. It was also an
arbitrary recursive delete: `mkdir_p` over an existing *file* raises `EEXIST`,
which matches neither the `ENOSPC` nor the `EACCES` rescue and falls through to
`rescue StandardError`, whose first act is `rm_rf dir`. `/var/sequenceserver-data`
is mounted read-write into all three containers, so one request could have taken
a BLAST index out from under test, dev and prod at once. No caller ever needed to
supply an id — `Job.create` is the only one, and ids restored from `job.yaml` are
rebuilt by YAML without passing through `initialize` — so the id is now always
generated (`lib/sequenceserver/job.rb:121`). `Job.fetch` and `Job.delete` check
the shape of the one they are handed against `Job::VALID_ID` (`job.rb:29`, used
at `:62` and `:75`), because every route reads `:jid` straight out of the URL,
and the rescue cleanup now refuses to recurse outside `DOTDIR` (`job.rb:135`).

**The four static-asset routes joined the URL onto `public/`.** `/blast/logos/*`,
`/blast/fonts/*`, `/blast/css/*` and the catch-all `/blast/*` each did
`File.join(settings.root, 'public', file)` with the splat capture. Mustermann
percent-decodes that capture *after* the server has normalised the path, so `%2F`
survived normalisation and then became a real separator: `GET /blast/..%2FGemfile`
returned the Gemfile, `..%2Flib%2Fsequenceserver%2Froutes.rb` returned the
application source, and `conf/*.conf` went the same way — which is where a
credential would live. The four now share `serve_public_file`
(`routes.rb:594-604`), which expands the path and requires it to still begin with
the directory it belongs to; `expand_path` collapses the `..` segments and the
`start_with?` check is what actually refuses them. `File.file?` is in the same
condition so a directory is never handed to `send_file`.

**`Database.retrieve` had no bound of any kind.** It is what `?query=` resolves
accessions through, and every id is looked up in every database until one
matches — each lookup forking the VM to exec `blastdbcmd`. So a *miss* costs one
fork per database: one absent accession on SGD's fungal set is 312 spawns and
about 19.5 s. Nothing limited the number of commas either, so a `?query=` with
100 ids was roughly 31,000 spawns and about 26 minutes of the single worker, for
one unauthenticated GET. It is now capped at `RETRIEVE_LOCI_LIMIT = 10` ids with
a `RETRIEVE_BUDGET_SECONDS = 15` deadline checked per database rather than per
locus (`lib/sequenceserver/database.rb:249-250`, enforced at `:261` and `:285`)
— the same budget the `?name=` path beside it already had, and for the same
reason. Ids past the cap and a lookup that runs out of budget each come back as a
commented `# ERROR:` line in the FASTA, which is how this code already reported a
missing accession. Measured after: 100 ids costs 15.2 s.

The release segment was tightened in the same pass; that fix is described under
the deployment shape above, since its visible consequence was that retired
releases went on being served.

## The two bundles

`webpack.config.js` emits exactly two bundles from two entry points
(`webpack.config.js:8-19`):

- `public/js/search.js` → `public/sequenceserver-search.min.js`
- `public/js/report_root.js` → `public/sequenceserver-report.min.js`

No chunks are emitted, and both are committed to the repository. The bundle a
browser receives is the bundle somebody committed, not one built inside the
image — checked by md5 against both running containers:

```
848136a70005574380212f8703a08739  working tree (= HEAD, 73e4a38a)
848136a70005574380212f8703a08739  agr-blast-dev:/sequenceserver/public/…
11885c7e9d53425616eb91aade1eaf79  git show fda1db1f:public/…
11885c7e9d53425616eb91aade1eaf79  agr-blast-prod:/sequenceserver/public/…
```

Each container serves exactly the bundle committed at the revision it was tagged
from. That is why changing JS without rebuilding and committing ships nothing,
and why `CLAUDE.md` insists on it.

`output.publicPath` hardcodes `//blast-dev.alliancegenome.org:4568/blast/` when
`process.env.NODE_ENV === 'production'`. `npm run build` passes
`--mode production` but does not set that environment variable, so the localhost
branch is what gets baked in: `localhost:4567/blast/` appears once in each
shipped bundle and `blast-dev.alliancegenome.org` not at all. Since no chunks are
emitted, nothing ever resolves a URL against it. It is dead configuration rather
than a live misdirection, but the condition is wrong and would misfire the first
time anyone introduces code splitting.

### Search page

```
Page                       public/js/search.js
├── SearchHeaderPlugin     (plugin alias)
├── DnD                    public/js/dnd.js        — drag a FASTA file onto the page
└── Form                   public/js/form.js
    ├── SearchQueryWidget  public/js/query.js:94
    │   ├── GeneSearch         public/js/gene_search.js   (above the textarea)
    │   ├── <textarea #sequence>
    │   └── ExampleSequences   public/js/query.js:403     (below it)
    ├── DatabasesTree      public/js/databases_tree.js    — when :databases_widget is tree
    │   └── (or Databases  public/js/databases.js         — plain checkbox list)
    ├── Options            (plugin alias → public/js/options.js)
    ├── QueryStats         (plugin alias)
    └── SearchButton       public/js/search_button.js
```

`Form` holds the shared form state — the database list, the detected sequence
type, the chosen options — and the children report into it through callbacks.
It is not the only stateful node, though: `SearchButton` (`search_button.js:10`),
`Databases` (`databases.js:7`), `SearchQueryWidget` (`query.js:97`), `Options`
(`options.js:7`) and `GeneSearch` (`gene_search.js:45`) each keep their own, and
`Form` reaches into one of them directly — `form.js:146` reads
`this.button.current.state.methods[0]` to put the method on the submission.

Two bits of coupling are worth knowing. The BLAST method is never chosen by the
user: `determineBlastMethods` (`form.js:165`) derives it from the detected query
sequence type and the selected database type, and `SearchButton` renders the
first result. And `Options` prepends `-task <method>` when the selected preset
does not name one (`public/js/options.js:53`), because most presets in
`sequenceserver.conf` omit `-task` and the Task dropdown would otherwise sit
unselected.

`handleExampleSelected` (`form.js:253`) and `handleGeneSelected`
(`form.js:248`) are deliberately asymmetric. An example fills the query box
*and* selects its database, driving the selection through jstree so the tree and
the hidden checkboxes the form actually submits stay in agreement. A gene chosen
from the gene box fills the box and stops: the database a sequence came *from*
is rarely the one anyone wants to search it against, and selecting it would both
make that choice for the user and quietly undo one they had already made.

### Report page

```
Page                       public/js/report_root.js
├── Report                 public/js/report.js
│   ├── Sidebar            public/js/sidebar.js
│   ├── RunSummary         public/js/report/run_summary.js
│   ├── GraphicalOverview  public/js/report/graphical_overview.js
│   └── AlignmentResults   public/js/report/alignment_results.js
│       └── Hits           public/js/hits.js
│           ├── ReportQuery public/js/query.js:17  → HitsTable (query.js:433)
│           ├── Hit         public/js/hit.js
│           └── HSP         public/js/hsp.js
├── SequenceModal          public/js/sequence_modal.js
└── ErrorModal             public/js/error_modal.js
```

The sketch in `CLAUDE.md` omits `RunSummary` and `AlignmentResults` and puts
`Hits` directly under `Report`; it has not been that shape for some time.
`Hits` is also not a tree in the usual sense — it accumulates a flat array of
`ReportQuery`, `Hit` and `HSP` elements in `this.state.results` and renders that
array, which is what makes the incremental 10-HSP slicing possible.

`HitsTable` is where a hit's gene symbol is shown, in bold ahead of the
accession (`query.js:487-489`). The symbol comes from the server as
`hit.gene_symbol`, not from anything the client parses.

### The plugin extension points

`webpack.config.js:44-56` aliases module names to files under
`pluginsPath`, which defaults to `./public/js/null_plugins` and is overridden
with `--env=pluginsPath=../real_plugins`. **Seven** aliases resolve into that
directory, not six as `CLAUDE.md` says:

| alias | imported at | what it reaches |
|---|---|---|
| `report_plugins` | `report.js:6` | `init`, a per-query panel, and the report's stats block |
| `download_links` | `sidebar.js:5`, rendered at `sidebar.js:362` | extra download links in the sidebar |
| `hit_buttons` | `hit.js:7`, instantiated at `hit.js:30`, drawn at `hit.js:149` | buttons on a hit header |
| `search_header_plugin` | `search.js:6` | a banner above the search form |
| `query_stats` | `form.js:8` | the stats line in the sticky action bar |
| `options` | `form.js:7` | the advanced-options widget |
| `histogram` | `null_plugins/report_plugins.js:1` | the report's histogram graph |

`histogram` is reached indirectly — nothing outside the plugin directory imports
it, so swapping `report_plugins` without also swapping `histogram` leaves the
graph stubbed. And `options` is the odd one: its null implementation re-exports
the real `public/js/options.js`, so the default build gets a working widget
rather than a stub, unlike the other six, which render nothing. `grapher` is
aliased too but always to `public/js/grapher.js`, so it is not an extension
point.

## links.rb: getting a hit into a genome browser

`Hit#to_json` (`lib/sequenceserver/blast/hit.rb:22`) includes `links`, so every
link on the report is computed server-side while serialising. `Hit#links`
(`hit.rb:51`) does two separable things.

First, the links that need nothing but the defline: NCBI sequence, the MOD's own
gene report, the Alliance gene page, and NCBI Gene. These are computed before
anything else (`hit.rb:57-62`) precisely so that they survive the paths below
that give up early — a deployment with no `environment.json` still gets them.

Second, the genome-browser link, which needs the hit matched to a config entry.
That match is done by resolving which of the job's databases contains the hit
(`hit.rb:69-80`, one `blastdbcmd` call per database until one answers), reducing
its filename to a species identifier, and scanning `environment.json`'s entries
for a `uri` containing that identifier (`hit.rb:110-118`). C. elegans is special-
cased, because WormBase builds its protein and genomic databases both as
`c_elegansdb`, differing only by BioProject.

### Whether a hit can be placed at all

A hit in a protein database is addressed by amino-acid offset, so its own
coordinates are never chromosome positions. But that does not make protein hits
unlinkable. SGD's protein deflines name the gene's location outright, in the
same form as its ORF ones:

```
$ blastdbcmd -dbtype prot \
    -db /db/SGD/R64-5-1m/databases/.../Protein_sequences/YeastORF_pepdb \
    -entry all -outfmt '%t' | head -1
YAL069W SGDID:S000002143, Chr I from 335-649, Genome Release 64-3-1, Dubious ORF, "…"
```

So the gate is not "is this protein" but "can this hit be placed":

```ruby
protein_hit = hit_db.type.to_s == 'protein'
locatable = !protein_hit || !Links.defline_feature_ranges(title).nil?
```

(`hit.rb:105-106`). WormBase protein deflines name no location — `wormpep=…
gene=… locus=…` — so they stay unlinked, which is the case the gate was added
for: because WormBase's protein and genomic sets share the name `c_elegansdb`,
the protein database matched the genomic config entry and inherited its
`genome_browser` block, producing browser links at protein coordinates.

### Offsets into a feature are not chromosome coordinates

`Links.genomic_hsp_spans` (`lib/sequenceserver/links.rb:337`) is the piece that
exists because of a visible bug. For a genome assembly the subject *is* the
chromosome and an HSP's `sstart`/`send` need only ordering. For a feature
database — SGD's ORF, RNA and protein sets — the subject is one gene, and
passing its offsets through unchanged sent the browser to the start of the
chromosome: an ACT1 hit covering 1..456 of the CDS opened `chrVI:1..456`
instead of the ACT1 locus at 53260..54696.

So the feature's own location is parsed out of the defline and the offsets are
mapped onto it. Two cases refuse exact placement and fall back to highlighting
the whole feature (`links.rb:362-365`): protein, where offsets are amino acids
and the reading frame does not survive an intron; and spliced features, where
the subject is the joined product. The spliced case is not rare — ACT1, which
the shipped SGD example searches, is `Chr VI from 54377-53260,54696-54687`, and
those ranges are not in transcription order. It is on the reverse strand, so its
first exon is the one at the *higher* coordinates, listed second. Walking the
ranges to place an offset would have to know that, and getting it wrong puts the
highlight in the neighbouring gene. Showing the whole feature is also the honest
answer: the hit is somewhere in this gene.

Two defline conventions are parsed. SGD's own (`SGD_FEATURE_LOCATION`,
`links.rb:277`) encodes the reverse strand by *descending* the range. NCBI's,
used by SGD's fungal sets (`NCBI_FEATURE_LOCATION`, `links.rb:297`), always
lists coordinates ascending and marks the strand with `complement()`. The NCBI
parser normalises to SGD's convention (`links.rb:310`), so the same gene yields
the same ranges either way and the mapping code needed no new case. Six location
shapes were measured across all 6,020 S. cerevisiae CDS entries — a count that
still reproduces: `blastdbcmd -info` on `saccharomyces_cerevisiae_cdsdb` reports
6,020 sequences — including a bare single coordinate inside a `join()` in four
of them.

### Per-MOD chromosome names

`extract_ref_name` (`links.rb:378`) picks an extractor by looking first at the
`genome_browser.url` or `assembly` in the config, then falling back to the
database path and the defline text. If no extractor claims the hit it returns the
defline's first word, and failing that the raw accession.

That generic fallback is why `DEFLINE_ATTRIBUTE` (`links.rb:76`) exists. A
defline opening with an attribute pair has no sequence name in that position —
WormBase protein deflines start `wormpep=CE09349`, FlyBase's `type=polypeptide`,
C. elegans genomic ones `length=14890789` — and returning the pair verbatim
produced JBrowse links addressed to `wormpep=CE09349`. The pattern is anchored
on a bare identifier so that SGD's fungal `[gene=PAU8]`, which is bracketed and
not an attribute in this sense, is left alone.

Each extractor speaks one MOD's vocabulary:

- **WormBase** (`links.rb:86`) normalises to JBrowse 2's `I`…`V`, `X`, `MtDNA`,
  accepting both Arabic and Roman spellings from either the title or the
  accession. It also handles two oddities: a `length=…`-only defline from a
  non-`parse_seqids` database, where the chromosome is recovered from the
  `BL_ORD_ID` ordinal (1→I … 6→X, 7→MtDNA), and the CB4856 strain under
  PRJEB28388, whose references are `chrI_pilon`-style. That second branch is
  stale: it is gated on `database_path&.include?("WS297")` (`links.rb:107`), and
  `/db/WB` holds only `WS298` and `dev` as servable releases, so it never fires
  — even though WS298 does carry the assembly it was written for
  (`.../C_elegans_CB4856_Genome_Assembly/c_elegansdb`). Widening the gate is one
  word; nobody has.
- **FlyBase** (`links.rb:150`) prefers `loc=`, falls back to `ID=` on
  `type=golden_path` entries, and screens the result through
  `is_valid_flybase_chromosome` (`links.rb:138`) so that scaffold identifiers —
  long numeric ids — are rejected and produce no link rather than a broken one.
- **RGD** (`links.rb:177`) turns
  `… chromosome 1, GRCr8, whole genome shotgun sequence` into `Chr1`, and
  anything mitochondrial into `ChrMT`. Scaffolds and unlocalised sequences
  return nil.
- **SGD** (`links.rb:231`) has three paths, described next.

### Why SGD needed a RefSeq → chrN map

SGD runs two datasets side by side with different defline conventions, and the
fungal one names the chromosome nowhere in the title. The fungal deployment's
own example search returned hits with an NCBI link and nothing else — no
JBrowse link, no Alliance gene link. The data was never the problem: the fungal
sets describe the same genes as SGD's main sets, in NCBI's vocabulary, and none
of the extractors spoke it.

The only place a fungal CDS defline carries the chromosome is the RefSeq
accession its id is built from:

```
NC_001138.5_cds_NP_116614.1_1760
  [gene=ACT1] [locus_tag=YFL039C] [db_xref=SGD:S000001855,GeneID:850504]
  [protein=actin] [protein_id=NP_116614.1]
  [location=complement(join(53260..54377,54687..54696))] [gbkey=CDS]
```

There is no algorithmic relation between `NC_001138` and `chrVI`, so
`SGD_REFSEQ_CHROMOSOME` (`links.rb:222`) is a literal 17-entry table. It was
read off the fungal genome assembly database, which is the one place carrying
both halves — and it still reproduces exactly:

```
$ blastdbcmd -db …/S_cerevisiae_Genome_Assembly/saccharomyces_cerevisiae_genomicdb \
             -entry all -outfmt "%a|%t"
NC_001133.9|Saccharomyces cerevisiae S288C chromosome I, complete sequence
NC_001134.8|Saccharomyces cerevisiae S288C chromosome II, complete sequence
…
NC_001148.4|Saccharomyces cerevisiae S288C chromosome XVI, complete sequence
NC_001224.1|Saccharomyces cerevisiae S288c mitochondrion, complete genome
```

The version suffixes differ per chromosome (`.9`, `.8`, `.5`, `.10`, …), which
is why the lookup keys on the bare `/\bNC_\d{6}/` and drops the version
(`links.rb:257`).

The map holds S288C accessions only, so only S. cerevisiae resolves. That is
correct rather than incomplete: S. cerevisiae is the only fungus AGR's JBrowse 2
hosts, so a hit in any of the other ~60 fungal species returns nil and gets no
link, because there is nowhere to send it. The fungal protein set is likewise
left unlinked — no location, no chromosome accession, no SGD id — and the
`locatable` gate above already suppresses it.

The accession is tried *after* the title (`links.rb:253-260`) because the title
is the more specific signal where it exists: the genome assembly carries both an
`NC_` accession and `chromosome I` in its description, and they agree.

The third SGD path is the abbreviated form its feature sets use, `Chr I from
335-649`. Without it those deflines fell through to the generic fallback and
returned the first word — `YAL069W`, a gene name, which is not a sequence
JBrowse can find.

Identifying SGD at all took one change when SGD moved to AGR's JBrowse 2:
matching `genome_browser.url` on `"yeastgenome"` stopped working once the URL
became `www.alliancegenome.org`, and only the `database_path` fallback was still
getting these right. The assembly name is now what distinguishes it
(`links.rb:397-398`).

The property worth asserting here is convergence, and the smoke test asserts it
rather than hardcoding either answer: ACT1 searched on the fungal deployment and
on the main one yields the same `loc` (`chrVI:50388..57568`), the same highlight
(`53260..54696`) and the same gene page, from two unrelated defline formats
through two code paths.

### Building the URL

`Links.jbrowse` (`links.rb:439`) branches on `genome_browser.type`. Both
branches cap at the first five HSPs to keep URLs manageable, zoom to the first
(best) HSP with padding of `max(hsp_length * 2, 1000)` so a hit is visible even
when HSPs are far apart, and refuse to emit anything when the reference name is
empty, starts with `type=`, or still contains `gnl|BL_ORD_ID`
(`links.rb:471`, `links.rb:563`).

The **JBrowse 2** branch builds `loc`, `tracks`, an `assembly` parameter and a
`sessionTracks` parameter holding a `FromConfigAdapter` feature track named
"BLAST Hits", with one subfeature per HSP. The separator is chosen rather than
assumed (`links.rb:576`), because FlyBase's configured URL already carries query
parameters:
`https://flybase.org/jbrowse2/?config=dmel%2Fconfig.json&tracklist=true`.
Appending `?loc=` to that would have produced a URL with two query strings.

The **JBrowse 1** branch builds `addFeatures`/`addTracks` instead, and overrides
the configured track list with `["Gene_span", "RNA"]` for any FlyBase URL
(`links.rb:489-495`). It is dead code in the current deployment: each of
`/var/sequenceserver-data/config` and `config-dev` holds 272 `genome_browser`
blocks, and every single one of them is `"type": "jbrowse2"`. The branch is also
the fragile one — `tracks` is `join`ed
without a nil check (`links.rb:494`), which would raise on a config entry that
omits it, and no deployed entry does.

### Gene links

Two unrelated mechanisms produce a gene link, and they are not interchangeable.

`gene_from_defline` (`links.rb:686`) reads the gene straight out of the defline.
`AGR_GENE_PATTERNS` (`links.rb:626`) keys on the *shape* of the identifier
rather than the MOD segment of the URL, because the two do not always agree —
XenBase would be served under `/blast/XB/` but mints `Xenbase:` CURIEs, and MGD
under `/blast/MGD/` mints `MGI:` — and a wrong prefix yields a link that 400s
at the Alliance rather than one that visibly fails here. FlyBase is anchored on
`parent=` specifically: a bare `/FBgn\d+/` also matches the intergenic-region
sets, whose deflines are *named* after a flanking gene without being that gene.

Every field is searched (title, id, accession) because BLAST splits a defline at
its first space and which half holds the gene id depends on how the MOD orders
its deflines. The *symbol*, by contrast, is looked for in the title only
(`links.rb:700-707`): searching all fields let ZFIN's own id prefix win, because
`tpe|OTTDART…` satisfies the ZFIN symbol pattern, so a hit whose title held no
symbol was labelled `Alliance: tpe`.

`MOD_GENE_URL` (`links.rb:679`) adds the MOD's own gene report at `order: 1`,
ahead of the Alliance link at `order: 2`, because on FlyBase's own deployment
FlyBase's page is what a curator reaches for. Only FlyBase is populated — only
FlyBase asked — and adding another MOD is one line.

The other mechanism (`hit.rb:130-154`) shells out to `jbrowse-nclist-cli`
against the config's `gene_track` using the hit's genomic coordinates. It needs
three things the defline route does not: a matched config entry, a
`genome_browser.gene_track` in it, and a nucleotide hit — it is gated off for
protein (`hit.rb:130`), because feeding amino-acid offsets to a genomic track
reports whichever gene happens to sit at that base pair. So it produces nothing
for the protein and transcript sets, which are precisely the ones whose deflines
name the gene outright. That is why both mechanisms exist.

Where both fire they name the same gene and build the same
`alliancegenome.org/gene/<MOD>:<id>` URL, so `dedupe_links` (`hit.rb:173`) drops
one. Its comment says the surviving label is the coordinate-derived one, which
carries the gene's display name — but that reads backwards. `links` starts as a
copy of `defline_links` (`hit.rb:108`) and the coordinate-derived link is
*pushed* afterwards (`hit.rb:145`), and `Array#uniq` keeps the first occurrence,
so what survives is the defline-derived label. Read from the code, not observed
in a browser. No user-visible harm either way — both labels are a gene name —
but the comment will mislead anyone changing the ordering.

Both the hit table's bold symbol and the gene links go through the same
`gene_from_defline` extraction on the same three fields — `Hit#gene_symbol`
calls it at `hit.rb:44`, `Links.agr_gene_from_defline` at `links.rb:714` and
`Links.mod_gene_from_defline` at `links.rb:728`. Three calls, one code path, so
the symbol shown in the table and the symbol on the link cannot disagree
(nothing caches the result, which is why it is three calls and not one). That is
the only property
there worth guaranteeing. It came from FlyBase curator feedback: a BLAST for Dll
returned a hit list of FBpp identifiers in which none of the first hundred rows
could be recognised as Dll, and there was no route to a FlyBase gene report. The
symbol was already being resolved — a search for `white` returns w, st, CG9664 —
but only as the label on a link further down the page.

### NCBI links

`ncbi_link` (`links.rb:773`) is deliberately strict. It prefers an explicit
`[protein_id=…]`, then accepts the hit accession only if it matches
`REFSEQ_ACCESSION` (`links.rb:770`) or embeds something that does; a looser
pattern linked MOD-native identifiers — SGD's `Q0010`, WormBase gene names — to
NCBI records that do not exist. It then has a FlyBase-specific fallback, because
FlyBase names the RefSeq record in its `dbxref=` list rather than in the
accession, which is its own FBpp id, and without that a FlyBase hit carried no
NCBI link at all even though the defline said exactly which record it was.

## The Alliance chrome

`views/layout.erb` wraps every page. It renders `views/_alliance_nav.erb` above
a header and `views/_alliance_footer.erb` below the yielded content.

The nav (`_alliance_nav.erb:20-25`) is three things: a link back to
alliancegenome.org, "BLAST" as the current section, and Contact Us — the last of
which is the sole entry in the link table at `:13-15`. An earlier
draft mirrored all six of the Alliance's top-level sections, which made the bar
read as a copy of their site rather than as a way out of this one. BLAST is shown
as a section although the Alliance nav has no such entry — that is a proposal,
not something their web team has agreed.

The header (`layout.erb:113-153`) carries the Alliance logo, the member logo,
the page title, and the data version. The title is *assembled* from its non-empty
parts (`layout.erb:131-133`) rather than interpolated, because the Alliance-wide
deployment has no member name and plain concatenation left the heading as
` BLAST`; the same expression appends "Fungal" when the version ends in `f`. The
data version is also published as a `data-data-version` attribute
(`layout.erb:147`), because two e2e specs used to read it out of the header's
visible prose by matching `/Data Version:\s*(\S+)/` — and a restyle that removed
the colon and uppercased the label in CSS broke four routing tests and three
cross-MOD boot tests for reasons unrelated to routing or booting.

### The dynamic MOD logos

`layout.erb:89-109` fetches `https://www.alliancegenome.org/asset-manifest.json`
over `Net::HTTP`, looks up `src/assets/images/alliance_logo_<member>.png`, and
uses the hashed filename the manifest names. This happens **synchronously, with
no cache and no timeout, on every page render whose MOD segment is a recognised
member.** The fetch sits inside `if member_key` (`layout.erb:94`), so a path
whose second segment is not one of `FB`, `MGD`, `RGD`, `SGD`, `WB`, `ZFIN`, `XB`
or `AGR` makes no request at all — which spares the Alliance-wide deployment and
nothing else, since every real MOD page is in that list. A failure is caught and
logged and the Alliance logo is substituted (`layout.erb:105-107`, fallback at
`layout.erb:127`), so the page does not break — but a slow or unreachable
alliancegenome.org slows every page of this service. It is the one network call
in the request path that is not a subprocess.

The member maps at `layout.erb:53-85` cover `FB`, `MGD`, `RGD`, `SGD`, `WB`,
`ZFIN`, `XB` and `AGR`. The Alliance-wide deployment is served under
`ALLIANCE`, which is in none of them, so it takes the fallback logo, gets the
empty member name the title assembly was written for, and links to
`/members/ALLIANCE`.

### The footer

`_alliance_footer.erb` is two sections. The colophon (`:74-146`) holds what is
ours: the SequenceServer attribution, the in-development caveat about JBrowse
links, and the two citations as a definition list anchored by their DOIs, which
is the part a reader copies. The 22-author SequenceServer author list
(`:127-132`, Anurag Priyam through Yannick Wurm) is collapsed behind a button
that the inline script adds (`:179-201`) rather than
the markup, so with no JavaScript the full list stays visible and no dead button
appears. The script lives in the partial rather than in a bundle because the
colophon is on every page, including ones that load no React bundle. The ERB
comment above the list (`:117`) says "24 authors"; it is a count of nothing and
should be deleted rather than corrected.

Below it is the Alliance's own footer (`:148-177`): their light logo and their
six site-map groups — Data and Tools, Members, News, About, Help, Community —
built from a literal table at `:18-70`. That table has 12 + 8 + 3 + 5 + 4 + 7 =
39 links, which matches the "identical 39-link footer" verified across all seven
deployments when it landed. Group order, link order and labels are theirs, read
off their live site on 2026-09-30, so a visitor leaves this page into the same
destinations they would have from any other Alliance page. The external-link
arrow is applied to the same links they apply it to, not to every absolute URL.
One deliberate difference: their site-map is CSS multi-column with no break
rule, so their Community list splits across columns and strands "Cite Us" under
no heading; this one keeps each heading with its own list.

The nav and the footer are both static ERB copies of markup the Alliance renders
client-side on their own site. When they change theirs, these do not follow, they
do not break visibly, and nobody currently owns re-checking them. That is the
standing liability of this chrome, and it is worth saying rather than leaving to
be rediscovered.

### The jstree checkbox CSS, and why it needs id-prefixed selectors

`databases_tree.js:366-371` renders a `<link rel="stylesheet">` for jstree's
default theme *inside the React tree*, in the body. `app.min.css` is in the
head. So jstree's stylesheet lands after ours in the cascade and wins any
contest decided by source order. An id in the selector beats its class selectors
outright regardless of order, which is why every rule overriding jstree is
prefixed with `#nucleotide_database_tree` / `#protein_database_tree` rather than
written against `.jstree-checkbox` alone. Both the chevron rules
(`public/css/app.css:811-877`) and the checkbox rules (`app.css:1326-1440`) are
written that way, for that reason.

Two rounds of work live there. jstree draws its expand control and its
checkboxes as offsets into a 32-pixel bitmap sprite
(`public/vendor/github/vakata/jstree@3.3.8/dist/themes/default/32px.png`). SGD
reported that the expand control read as a faint "+" on a dotted line, weaker
than the checkbox and folder icon beside it; an earlier attempt at making it
easier to hit by widening `.jstree-ocl` to 24px only padded a small glyph with
empty space, because the sprite does not scale. The chevron is now drawn in CSS
from two borders of a rotated square, so it scales and takes the theme colour,
and the dotted connector lines are turned off as sprite noise that indentation
already conveys. The checkboxes went the same way afterwards — they were soft on
a HiDPI screen next to the now-crisp chevron, and were the palest thing in the
row, so the one control a user has to operate read as the least interactive.

One constraint carried from the first round into the second: the cell keeps
jstree's 24px height. Changing it drops every row by 2px, because the cell is
what sets the line box — the folder icon beside it sits 2px higher and the
chevron, centred in a taller cell, sits low in the row. Only the drawn glyph
needed to grow.

### The database tree itself

`DatabasesTree` extends the plain `Databases` component and initialises jstree
lazily, on first click on the container (`databases_tree.js:402-407`). Selection
is synchronised back into the hidden per-database checkboxes the form actually
submits, through a doubly-debounced `select_node`/`deselect_node` handler
(`databases_tree.js:25-50`) that filters jstree's selected ids down to the
32-character ones — database ids are MD5 hex, group nodes are joined category
paths — and that unchecks the other category's tree, because a search is
nucleotide or protein, never both.

`handleToggle` (`databases_tree.js:290`) had to be overridden for the same
reason: the inherited implementation only sets React state, which updates the
hidden checkboxes but leaves jstree showing nothing selected — and because the
tree's own handler rebuilds state from jstree, the next click on any node
silently undid it.

Auto-expansion (`databases_tree.js:135-273`) opens the reference species' genus
and species nodes on WormBase, FlyBase, RGD, SGD's fungal set and ZFIN, so that
the tree does not open on a hundred collapsed clades. It identifies the MOD by
hostname, URL path, or the `alt`/`src` of a logo image, and runs 500 ms after
`ready.jstree`.

## Configuration

Three files do the work, plus a fourth that people look for and that does not
exist.

**`public/configs/sequenceserver.conf`** is the server config the containers
actually load. It sets `:host`, `:port`, `:databases_widget: tree`,
`:database_dir: "/db"`, `:num_threads: 1`, `:num_jobs: 1`,
`:job_lifetime: 43200` and `:options` — the advanced-parameter presets per BLAST
method. `:job_lifetime` is in **minutes** (`JobRemover` multiplies it by 60 at
`lib/sequenceserver/job_remover.rb:16`), so 43200 is 30 days, not 12 hours; a
finished job directory under `~/.sequenceserver/` survives that long.
Each preset is a `:description` plus an `:attributes` list, and they are what
populate the Options dropdown; all five methods currently default to
`-evalue 1e-5 -max_target_seqs 100`, with `blastn` offering a second
`short-seq` preset at `-task blastn-short -evalue 1e-1`. `:database_dir` reads
like the most important key here and is in fact inert in the server: the only
code that consumed it was `init_database`, which is no longer called. What
remains is bookkeeping — `Config#normalize` renames a legacy `:database` key
into it (`lib/sequenceserver/config.rb:66-68`) so very old config files keep
loading. The real root is the literal `/db` that `database_dir_for` joins
(`routes.rb:565`). The only other code that would read `:database_dir` is
`bin/sequenceserver`'s interactive database-formatting flow, and that is itself
broken: it reaches the directory only through `SequenceServer.makeblastdb`,
which no longer exists. The `conf/*.conf` files are the old per-MOD configs and
are not loaded by any running container.

**`public/environments/<mod>/<version>/environment.json`**, mounted from
`/var/sequenceserver-data/config{,-dev}` and written by
`agr_blastdb_manager`, is the per-release data description. Its `data` array has
one entry per source FASTA, carrying `blast_title`, `genus`, `species`,
`taxon_id`, `uri`, `md5sum`, `seqtype`, and optionally a `genome_browser` block
of `{type, url, assembly, tracks, data_url, gene_track, mod_gene_url}`. Three
separate things read it:

- the report route, for the genome-browser blocks (`routes.rb:270`);
- `organism_by_title` (`routes.rb:695`), which labels each gene-search
  candidate with its organism. A database carries no organism of its own — its
  categories are the tree grouping, which on SGD's fungal set is a clade such as
  `Agaricomycetes_mushrooms_allies` rather than a species. The config does carry
  one, and sanitising its `blast_title` the way the build does yields the
  database title exactly — reported in `routes.rb:691-694` as 100% across SGD,
  FB, WB and ZFIN, which I have not re-measured;
- the entries' `uri` fields, which are how a hit's database is matched to a
  config entry at `hit.rb:116`.

Every one of the 272 `genome_browser` blocks in each config directory is
`jbrowse2`. Only a small minority of entries carry a block at all — 10 of SGD's
183 main-set entries, 1 of FlyBase's 200 — which is why most hits get no genome
browser link and that is not a fault.

**`public/configs/database_order.json`** controls only how the jstree node list
is sorted, and only for the two MODs it names. It is sent to the client inside
`searchdata.json` (`routes.rb:205-208`) and consumed in
`databases_tree.js:56-129`. Each entry has a `detection.titleContains` list
matched against the serialised tree — SGD on `S288C`, RGD on `R. norvegicus`,
`Rattus`, `GRCr8`, `mRatBN7` — and then `strainGroups` and `typeOrder` maps of
substring to rank, with a default of 99. Sorting is strain group, then type,
then alphabetical. SGD uses it to put S288C ahead of alternative reference
strains ahead of other strains, and genomic DNA ahead of ORFs ahead of RNA; RGD
uses it to put GRCr8 ahead of mRatBN7. No other MOD has an entry, so no other
MOD gets a custom sort.

**`public/configs/examples`** does not exist — example sequences are in the
bundle, as a literal table in `public/js/examples.js`. Each entry names its
database by *title*, not id, and the set is filtered against the databases the
deployment actually loaded before anything is offered. Without that filter an
example whose database is absent fills the query box and selects nothing,
leaving the user with a disabled search button and no explanation.

## The gene search box

`GET /blast/:mod/:version/gene_search?q=` (`routes.rb:159`) is a fork addition
with no upstream equivalent. `agr_blastdb_manager` writes two JSON files beside
each BLAST database: `<db>.names.json`, mapping a lower-cased accession, locus
tag or gene symbol to the accession to retrieve, and `<db>.names.display.json`,
mapping the same key to the spelling the source uses, for the keys where the two
differ. There are 2,387 of the former (1.36 GB) and 2,383 of the latter
(1.33 GB) on the shared volume.

They are two files rather than one richer index for two reasons. The index is the
hot path — a gene search reads the raw text of every index in the release — so
anything added to it is paid on every search, whereas the display file is read
only for the few databases a search actually matches. And the index keeps its
exact existing shape, so a deployment running older code goes on resolving
`?name=` against it unchanged.

`gene_search_candidates` (`routes.rb:720`) is deliberately a list rather than a
sequence. `?name=` resolves a symbol to one record by taking the first database
that matches, which is fine for a deep link and wrong for a box someone types
into. Exactly 16 of SGD's 312 fungal name indexes contain an `act1` key —
`grep -l '"act1"'` over them still returns 16 — so a curator typing ACT1 was
silently handed Candida albicans. Each candidate now names the organism it came
from and the user chooses.

Both sequence types are searched, because WormBase carries symbols only
on its protein databases — its nucleotide sets are genome assemblies with no
`locus=` — so filtering by type would make the box useless there.

Three details are load-bearing:

- The match is a **prefix** match on the index's quoted keys (`routes.rb:726`
  builds the needle, `routes.rb:755` applies it). The first report of this box
  was someone typing ACT and being told no such gene exists while ACT1 sat in
  the index.
- Parsing every index costs over a second, and almost none of them contain any
  given symbol, so the **raw text** is checked for the needle before any JSON is
  parsed (`routes.rb:734-735`). The needle can land on a value's opening quote as
  well as a key's, which is why the display file is loaded lazily on the first
  real hit rather than alongside the index.
- The near-miss cap is **per database**, not global (`GENE_SEARCH_PER_DATABASE
  = 8`, `routes.rb:686`). Capping as we went across all databases meant one of
  them could fill the whole list: searching `w` on FlyBase returned fifty
  protein hits and never reached the transcripts, so the box looked as though
  FlyBase had no nucleotide genes at all. An exact hit is never dropped.
- A candidate whose accession starts `BL_ORD_ID:` is skipped
  (`BL_ORD_ID_PREFIX`, `routes.rb:677`, applied at `:767`). The backfill wrote
  those synthetic ordinals into the indexes of every database built without
  `-parse_seqids`, so on ZFIN the box returned fifty rows all reading
  `BL_ORD_ID:0`, each of them dead when clicked. Skipping them leaves ZFIN
  honestly empty, which is the true answer. `VALID_SEQUENCE_ID` could not be
  reused for the test: it permits `:` and accepts `BL_ORD_ID:0` quite happily.

There is no minimum query length. A two-character floor would have been the
obvious guard against scanning on every keystroke, but FlyBase's deployed
indexes carry 23 single-letter gene keys (`a` through `z`, with only `o`, `q`
and `u` absent) and 36 single-character ones once digits and Greek letters count,
nearly all of them in `dmel-transcriptdb` and `dmel-translationdb` — so a floor
would make them unsearchable on the MOD that asked for this box. The comment at
`routes.rb:165` says 17, which is not a figure that reproduces against
FB2026_03. Debouncing is in the UI instead (`gene_search.js:20`, 350 ms).

Measured on the test instance (agr-blast:restyle, 2026-10-02), including the
per-request `blastdbcmd -recursive -list` scan. These are wall-clock ranges
across repeated runs on different days, and they are **cache-state dependent**:
the same request is reliably at the bottom of its range once the index files are
in page cache and at the top on a cold volume, so treat the shape as the result
and not the digits.

| request | time |
|---|---|
| SGD fungal, `searchdata.json` (scan only) | 0.14-0.21 s |
| SGD fungal (312 databases, 146 MB of indexes), `q=zzzzq`, no match | 0.23-0.37 s |
| SGD fungal, `q=ACT1` | 0.45-0.72 s |
| SGD fungal, `q=act` | 0.50-0.92 s |
| FB2026_03 (200 databases, 119 MB of indexes), `q=Dll` | 0.37-0.69 s |

The no-match case sitting near the scan floor is the raw-text prefilter working,
and that holds at either end of the ranges.

Two code comments nearby overstate themselves. `routes.rb:715-719` claims the
prefilter took SGD fungal from 1.2 s to 0.19 s; its "312 files and 146 MB"
checks out exactly (SGD/R64-5-1f has 312 name indexes totalling 146.1 MiB), but
0.19 s is below anything measurable here today. Separately,
`routes.rb:620-630` — the `NAME_DISPLAY_SUFFIX` block — justifies splitting the
display names out of the index with "928 MB of them on FlyBase". That figure is
every FlyBase release on the volume added together (928.2 MiB across eight);
one deployment reads 119.3 MiB. The argument for splitting survives the
correction, the number does not.

`lookup_sequence_by_name` (`routes.rb:635`), which serves `?name=`, falls back
to streaming deflines out of a database with `blastdbcmd -entry all` when no
index exists, closing the pipe on the first match. That path is capped at
`NAME_LOOKUP_BUDGET_SECONDS = 15` (`routes.rb:612`), because a miss on the
fungal set has to read ~100 coding databases and about 1.3M entries, and an
unauthenticated request must not be able to run unbounded. Coding and CDS
databases are tried first, since `gene=` and `locus_tag=` only occur on coding
deflines. `blastdbcmd` is spawned without a shell there (`routes.rb:843`), with
database paths and accessions as argv entries, so they can never be parsed as
shell syntax.

## What is broken or unfinished

- **prod is seven merged PRs behind** (`agr-blast:fda1db1f`, i.e. #23; main is at
  #30). It has no gene search, and it carries the request-scoped-database
  concurrency bug described above, as well as all three filesystem defects of
  the section above it. It reads the same shared volume, so every index and
  spelling file it would need is already on disk.
- **ZFIN and RGD deflines carry no gene symbols**, so gene search cannot answer
  for them. `gene_search.js:30-34` deliberately omits a placeholder example for
  those two rather than promise something the deployment cannot do. Fixing it
  needs defline standardisation or an external lookup.
- **`ALLIANCE/prod` serves one database** where its config declares nine
  reference genomes. The cause is not architectural — see
  `docs/ALLIANCE_WIDE_PLAN.md` and
  `agr_blastdb_manager/docs/alliance_2024_build_failure.md`. Its ZFIN GRCz11
  database was additionally built without `-parse_seqids`, so its accessions
  come back as `BL_ORD_ID:0`.
- **`Database#non_parse_seqids?` never reports true for a v5 database**
  (`database.rb:82-91`), because commit 8164a02a replaced upstream's
  `.nos`/`.nog` seqid-index test with one on the `.njs` JSON metadata file,
  which every v5 database has. It is a fork regression, not inherited: the
  upstream predicate answers correctly on this volume. The eight databases that
  genuinely lack `-parse_seqids` — ZFIN/prod's seven and ALLIANCE/prod's one —
  therefore produce no warning in the log and no flag in the report. Retrieval
  from them does fail, in both the spellings
  the code might use: against `ZFIN/prod`'s `vega_transcript.fa`, both
  `blastdbcmd -entry 'gnl|BL_ORD_ID|0'` and `-entry 'BL_ORD_ID:0'` answer
  `Error: [blastdbcmd] DB contains no accession info.` (checked at the
  `blastdbcmd` level; not traced end-to-end through `get_sequence`), which is
  exactly the failure the suppressed warning is about.
- **`init_database` is dead code** (`lib/sequenceserver.rb:191`) and
  `SequenceServer.makeblastdb`, which it calls at `:202` and `:204`, does not
  exist at all. That is not only a dead caller: `bin/sequenceserver -m`
  (`--make-blast-databases`) calls the same missing singleton at `:361`, `:363`
  and `:384`, outside any rescue, so it aborts with `NoMethodError`. The "no
  databases found, shall I format the FASTA files?" prompt (`:304-305`) calls it
  too, and is in addition unreachable, since nothing raises
  `NO_BLAST_DATABASE_FOUND` at boot any more. `-l`/`--list_databases` prints
  nothing for the same reason — no boot-time scan, so `Database.all` is empty.
  The entire JBrowse 1 branch of `Links.jbrowse` (`links.rb:441-514`) is dead
  too, while no deployed config entry asks for it.
- **The CB4856 `chrI_pilon` branch in `extract_wormbase_chromosome` is gated on
  WS297** (`links.rb:107`), a release that no longer serves, so it never fires
  on WS298 or dev even though WS298 carries that assembly.
- **The asset-manifest fetch in `layout.erb` is uncached and untimed.** Every
  page render for a recognised MOD makes a synchronous HTTPS request to
  alliancegenome.org (`layout.erb:94-108`).
- **`conf/*.conf` and `docker-compose.yaml` describe a deployment that no longer
  exists**, and two of those configs still say `:databases_widget: classic`.
- **The database tree overflows at 390px** on its long labels. That predates the
  Alliance chrome work; the chrome itself contributes no horizontal overflow at
  1440, 900 or 390px.
- **A comment at `public/js/hits.js:108` says "3 hsps are rendered in each
  cycle"** where the limit is 10; the identical comment eighteen lines above it
  says 10. Stale and harmless, but it will mislead the next reader of that loop.
