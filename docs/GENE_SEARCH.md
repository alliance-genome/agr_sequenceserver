# Finding a query sequence by gene name

Both halves of this subsystem answer the same question — "give me the FASTA
record for this gene so I can paste it into the query box" — and they answer it
differently on purpose. `?name=` resolves a name to **one** record and is meant
for a link someone else constructed. The search box resolves a name to a **list
of candidates** and is meant for a person typing. The whole reason the second
exists is that the first is wrong when a human is driving, and the rest of this
document is mostly about why.

Line citations are to `main` at `b435058e` (PR #31, "Stop trusting request input
that becomes a filesystem path"), which is what dev runs. That commit changed
three things the box does — Enter, the `BL_ORD_ID:` skip and the no-results hint
— and each is called out below.

The measured figures were taken a little earlier, against `73e4a38a` on dev and
against the index files on `/var/sequenceserver-data/blast`. They are left as
measured rather than restated, and the commit is named wherever one appears, so
a reader can tell a recorded observation from a claim about today.

Production is eight merged PRs behind at `agr-blast:fda1db1f` (#23; `main` is
#31) and has no gene search at all. It mounts the same data volume, so every
index file the feature needs is already on disk there and the box appears the
moment prod is rebuilt.

## The ACT1 incident

SGD asked for a way to find a query sequence by gene symbol. The lookup already
existed — `lookup_sequence_by_name` at `lib/sequenceserver/routes.rb:635`, reached
as `?name=` — so the obvious move was to put a text box in front of it. That
would have shipped the defect, because `?name=` takes the first database that
matches and returns its record, and a gene symbol is not unique across a
hundred-odd organisms.

Sixteen of SGD's 312 fungal databases carry a key `act1`. The ordering in
`lookup_sequence_by_name` sorts coding/CDS databases first
(`routes.rb:647`) and then takes whatever comes, so on `R64-5-1f` a curator
typing ACT1 was handed *Candida albicans*. It still does, and it is worth seeing
the reproduction rather than taking it on trust:

```
$ curl -s '…/blast/SGD/R64-5-1f/searchdata.json?name=ACT1&type=dna'
>NC_032089.1_cds_XP_019330727.1_1268 [gene=ACT1] [locus_tag=CAALFM_C113700WA] …

$ curl -s '…/blast/SGD/R64-5-1f/searchdata.json?name=YFL039C&type=dna'
>NC_001138.5_cds_NP_116614.1_1760 [gene=ACT1] [locus_tag=YFL039C] [db_xref=SGD:S000001855] …
```

Nothing on screen said which organism had been chosen. The unambiguous locus tag
works fine, which is exactly the point: `?name=` is correct for a deep link,
where the constructor of the link knows which record they mean, and wrong for a
box where the user types four letters and hopes.

So `GET /gene_search` returns candidates, not a sequence, and every candidate
names its organism. On the same release the live endpoint now reports 18
candidates for `ACT1` spanning 17 databases and 17 distinct organisms, with
*Saccharomyces cerevisiae*'s own record (`NC_001138.5_cds_NP_116614.1_1760`,
`S_cerevisiae_Coding_Sequences`) among them for the user to pick.

## The two entry points

| | `?name=` | `gene_search` |
|---|---|---|
| route | `GET /blast/:mod/:ver/searchdata.json` (`routes.rb:180`) | `GET /blast/:mod/:ver/gene_search` (`routes.rb:159`) |
| input | `name=`, `type=` (`dna` by default) | `q=` |
| returns | a FASTA string in `searchdata.query`, or nothing | a JSON array of candidates, `[]` when none |
| matching | exact, lower-cased | prefix, lower-cased |
| databases | only those of the requested type | all of them, both types |
| caller | a link; the front end forwards the page's whole query string to `searchdata.json` (`public/js/form.js:52-64`) | `GeneSearch` on keystroke (`public/js/gene_search.js:104`) |

Both validate the name against `/\A[a-zA-Z0-9_\-.]+\z/` before touching a
database; `gene_search` answers an invalid one with `400 {"error":"Invalid gene
name"}` and an empty one with `[]` rather than an error, because an empty box is
not a mistake.

Picking a candidate does not use either endpoint. `GeneSearch#choose`
(`gene_search.js:124`) POSTs the candidate's `accession` and `database_id` to
`get_sequence` (`routes.rb:338`) — it already knows exactly which record it
wants, so there is nothing left to resolve. That POST is the one request here
that needs a CSRF token; it reads it from the metatag `views/layout.erb:23`
emits, and guards the lookup, unlike `download_fasta.js:10` and `form.js:304`
which dereference `.content` unconditionally.

## The index files

`agr_blastdb_manager` writes two JSON files beside every BLAST database. The
writer side — how deflines, symbols and synonyms get into them — is in
`agr_blastdb_manager/docs/NAME_INDEX.md`; what matters here is their shape and
why there are two of them.

`<db>.names.json` maps a **lower-cased** identifier to the accession to
retrieve. One key per thing anyone might type: the accession itself, the locus
tag, the symbol, and on FlyBase the synonyms and full names too.

```json
{ "white": "FBpp0070468", "w": "FBpp0070468", "cg2759": "FBpp0070468",
  "fbpp0070468": "FBpp0070468", "white rabbit": "FBpp0288897" }
```

`<db>.names.display.json` maps the same lower-cased key to the spelling the
source database actually uses, and contains **only** the keys whose spelling
differs from the key:

```json
{ "dll": "Dll", "cg2759": "CG2759", "(a+t)-stretch binding protein": "(A+T)-stretch binding protein" }
```

Keys are lower-cased so that a lookup can be case-insensitive without
normalising anything at read time. The cost of that showed up as soon as the box
listed its results: it was printing the key, so FlyBase's Dll came back as
`dll`, CG2759 as `cg2759`, and every one of SGD's all-caps symbols in lower case
— someone typing ACT1 was answered with `act1`.

The fix (73e4a38a) could have gone into the index as a richer value. It did not,
for two reasons stated at `routes.rb:624-630`. The index is the hot path, read in
full on every search, so anything added to it is paid on every keystroke; the
companion file is read only for the handful of databases a search actually
matches. And leaving the index's shape alone means a deployment running older
code goes on resolving `?name=` against it unchanged — which is not a
hypothetical, since that is precisely prod's situation today.

Because the companion file holds only the differences, the fallback is the key
itself (`routes.rb:775`), which is the same spelling. That is also what a
deployment with no companion files gets, i.e. exactly the previous behaviour.
Four databases on the live host have an index but no companion file —
`SGD/R64-5-1m/BY4741_Toronto_2012db`, `BY4742_Toronto_2012db`,
`WB/WS298/c_latensdb`, `WB/dev/c_latens.PRJNA248912.WS291.genomic.db` — and all
four turn out to hold nothing but already-lower-case keys: 18 apiece on the two
Toronto strains (`2-micron`, `chr01`…`chr17`) and 1,858 apiece on the two
*C. latens* assemblies (`scaffold_<n>`), with not one non-lower-case key between
them, so there was nothing for the writer to record.

Sizes, measured on the host:

| | databases | `.names.json` | `.names.display.json` |
|---|---|---|---|
| `FB/FB2026_03` | 200 | 200 files, 119 MB | 200 files, 119 MB |
| `SGD/R64-5-1f` | 312 | 312 files, 146 MB | 312 files, 123 MB |
| `SGD/R64-5-1m` | 183 | 183 files, 23 MB | 181 files, 23 MB |
| `WB/WS298` | 63 | 63 files, 36 MB | 62 files, 35 MB |
| `ZFIN/prod` | 7 | 7 files, 12 MB | 7 files, 12 MB |
| `RGD/8.3.0` | 9 | 9 files, <1 MB | 9 files, <1 MB |
| all sixteen served releases | 2,205 | 2,205 files, 1.27 GB | 2,201 files, 1.24 GB |

The last row counts only served releases. Counting everything on the volume
gives 2,387 and 2,383 files (1.36 GB and 1.33 GB, the figures in
`GROUND_TRUTH.md`), because three retired WormBase releases are still on disk
with their indexes — `WB/.retired-WS295`, `.retired-WS296`, `.retired-WS297`,
182 index and 182 spelling files between them. They are not served and not
counted here.

Every database on the host has an index — 2,205 of 2,205 across all sixteen
MOD/release directories. That makes the `?name=` fallback path
(`scan_database_for_name`, `routes.rb:837`, which streams deflines out of
`blastdbcmd` until one matches) and its 15-second budget
(`NAME_LOOKUP_BUDGET_SECONDS`, `routes.rb:612`) dead code in practice. Keep them:
the budget exists because a *miss* on the fungal set used to mean reading ~100
coding databases and ~1.3M entries on an unauthenticated request, and a release
built by an older `agr_blastdb_manager` would put the app straight back there.

Neither file is cached in the process. `name_index_for` says why
(`routes.rb:817-820`): the indexes for a MOD are far larger than any one lookup
needs, and parsing one is milliseconds. 146 MB of resident index per deployment
to save that is not a trade worth making in a process that serves every MOD.

## Making a search cheap enough to type into

Parsing every index in a release to look for one symbol costs over a second —
312 files and 146 MB on SGD's fungal set, measured at 1.2s — and almost none of
them contain any given symbol. So `gene_search_candidates` (`routes.rb:720`)
reads each index as raw text and checks it for the needle before parsing:

```ruby
needle = %("#{prefix})
…
raw = File.read(path)
next unless raw.include?(needle)
index = JSON.parse(raw)
```

The leading quote is what makes this a prefix search rather than a substring
one: keys are quoted in the JSON, so `"act` can only land at the start of a key
or of a value. Prefix matching was itself a bug fix (91726df5). The lookup was
inherited from `?name=`, where an exact symbol is what a deep link carries, and
the box's first report was someone typing `ACT` on FlyBase and being told no
such gene existed while Act5C, Actn, Act42A and fifteen others sat in the index.

The measured gain at the time was 1.2s to 0.19s. Over HTTP on this host today,
warm, the figures are larger because each request also rescans the database
directory:

| request on `SGD/R64-5-1f` | time |
|---|---|
| `searchdata.json` (the per-request `makeblastdb` scan alone) | 0.14-0.16s |
| `gene_search?q=ZZZNOTAREALGENE123` (needle over 146 MB, no parse) | 0.23-0.33s |
| `gene_search?q=ACT1` (needle, then parse 17 matching indexes) | 0.44-0.54s |
| `gene_search?q=a` (needle, then parse ~every index) | 1.04s |

A single letter is the worst case and it is the one the design cannot avoid,
since single-character symbols have to be searchable (below). The commit that
introduced prefix search quotes "0.12-0.39s per deployment even for a single
letter matching 22,078 keys on SGD's fungal set"; `a` matches 88,262 keys on
`R64-5-1f` as it stands now, so treat that figure as historical rather than
current. The 350ms debounce in the UI (`gene_search.js:20`) is what keeps the
worst case off most keystrokes, together with a monotonic request id
(`gene_search.js:101,111`) so that a slow early reply cannot overwrite a fast
late one, and so that a reply arriving after unmount is a no-op
(`gene_search.js:57`).

The companion spelling file is loaded lazily, inside the key loop and on first
match (`routes.rb:769`), not alongside the index. The stated reason is that the
needle is matched against raw text where it can equally well land on a *value's*
opening quote, so a database that passed the filter may have no matching key at
all. Worth being precise: that case does not currently arise. Across all 312 SGD
fungal indexes, every one of the 1,831,337 distinct values has its lower-cased
form present as a key, so a lower-case needle that matches a value start also
matches a key.
The lazy load still earns its place on cost — it keeps the companion file
unread for every database that contributes nothing — but it is insurance, not a
fix for an observed miss.

## Shaping the result list

Five rules, each with a report behind it.

**A cap per database, not a global one.** Searching `w` on FlyBase returned fifty
hits, every one a protein, so FlyBase looked as though it had no nucleotide genes
at all. The limit was global and applied while iterating; the protein database
has enough symbols beginning with `w` to reach fifty on its own and the loop
never got as far as the transcripts. `GENE_SEARCH_PER_DATABASE = 8`
(`routes.rb:686`) now bounds each database's contribution, with
`GENE_SEARCH_LIMIT = 50` (`routes.rb:681`) still capping the whole list. `w` on
`FB/FB2026_03` now returns 18 candidates, 9 protein and 9 nucleotide.

**Exact hits are exempt from the per-database cap.** What someone actually typed
must survive however many near misses share its prefix. Since at most one key per
index can equal the query, this means one exact hit per database and no more: the
two `w` records above, protein and nucleotide, both survive. Exact hits are also
listed first — `(exact + partial).first(GENE_SEARCH_LIMIT)` at `routes.rb:799` —
which on WormBase puts `unc-5` above `unc-50`, `unc-51` and `unc-54` rather than
burying it among them. Partials are ordered by length then by the lower-cased
spelling, deliberately not by the displayed spelling: sorting `CG2759` by its
bytes would put it ahead of every lower-cased symbol. The exact list is left in
database-iteration order, which is why `ACT1` on the fungal set still answers
with Candida first and why the browser spec asserts that rather than assuming
otherwise.

**Both sequence types are searched**, regardless of what the user has selected.
WormBase carries symbols only on its protein databases — its nucleotide sets are
genome assemblies with no `locus=` — so a box that followed the selected type
would find nothing at all on WB. Confirmed: `unc-54` on `WB/WS298` returns one
candidate, `C_elegans_Protein_Sequences`, protein.

**No minimum query length.** A two-character floor would have been the obvious
guard against searching on every keystroke, and would have been wrong: FlyBase
has single-character gene symbols, and they are on the MOD that reported wanting
the box findable. The code comments put the count at 17; what is on disk in
`FB/FB2026_03` is 36 distinct single-character keys — 23 ASCII letters
(`abcdefghijklmnprstvwxyz`), nine digits and four Greek letters — all of them in
the melanogaster transcript and protein sets, and the same 36 in every FlyBase
release back to `FB2024_02`. The 17 could not be reproduced; the argument does
not depend on which figure is right. Debouncing belongs in the UI, not in a rule
about what a gene name may look like.

**Choosing a gene selects no database.** It originally mirrored
`handleExampleSelected`, where selecting the example's database is the whole
point. For a gene it is wrong twice over: the database a sequence came *from* is
rarely the one anyone wants to search it against, and selecting it silently
discarded whatever the user had already chosen. `handleGeneSelected`
(`form.js:248`) now fills the query box and stops. The sequence type still
follows from the sequence, as it does for anything pasted in.

The box sits *above* the textarea with an explicit "or" between them
(`query.js:355-361`). It was below at first, under the examples, which is the
wrong way round once you notice that choosing a gene *fills* the box below it;
and the label "Or find a gene" stopped making sense once the box came first,
because the alternative it offers has not been shown yet. The results overlay the
textarea rather than pushing it down, and the dropdown is capped at 42rem.

The box is a `<div>`, not a `<form>` (`gene_search.js:202-205`). It was a form of
its own at first, which put it inside `<form id="blast">`, and a nested form is
not valid HTML: the parser discards the inner one. So the browser read Enter in
the gene box as a submit of the BLAST form and fired off a real search with
whatever happened to be in the query box — the one keystroke a person typing a
gene symbol is most likely to use. With no inner form there is nothing to
submit, and Enter is handled on the input itself (`handleKeyDown`,
`gene_search.js:92-98`): it cancels the pending debounce, searches immediately,
and stops the event bubbling to the BLAST form.

The placeholder names a symbol each MOD actually has (`gene_search.js:30`): SGD
`ACT1`, FB `Dll`, WB `unc-54`. `ACT1` was shown everywhere at first, which on
FlyBase is an example that cannot work — and an example that returns nothing
reads as a broken box rather than a wrong suggestion. ZFIN and RGD deliberately
get no example, for the reason in the next section.

## What it cannot answer

**ZFIN and RGD have no gene symbols to find.** This is not a gap in the search
code; it is the deflines. All seven `ZFIN/prod` indexes together hold 336,209
keys and every single one is of the form `bl_ord_id:<n>`, mapping to a value
`BL_ORD_ID:<n>` — those databases were built without `-parse_seqids`, so there
is not even a usable accession, let alone a symbol. RGD's nine indexes hold
9,151 keys, all GenBank/RefSeq sequence accessions (`nc_086019.1`,
`cm099000.1`, `jakeku010000023.1`), so RGD can only answer a query that happens
to be the start of an accession — `q=n` returns 16 rows of `NC_…` contigs. Ask
either for a gene and nothing comes back:

```
ZFIN/prod  q=pax6 -> []     RGD/8.3.0  q=tp53 -> []
ZFIN/prod  q=a    -> []     RGD/8.3.0  q=a    -> []
```

ZFIN used to answer *something*, though, and it was worse than nothing. Because
the keys themselves begin `bl_ord_id`, anything a visitor typed starting with
`b` matched them: `q=b` on `ZFIN/prod` returned a full 50 rows, every one
reading `BL_ORD_ID:0` and every one dead on click, since `BL_ORD_ID:0` is not
an accession `blastdbcmd` can retrieve. The backfill that populated the indexes
had written those synthetic ordinals in as though they were accessions, and 762
of the 2,387 index files on the volume are like this — 580 of the 2,205 that
belong to a served release. `gene_search` now skips any candidate whose
accession starts with `BL_ORD_ID:` (`BL_ORD_ID_PREFIX`, `routes.rb:677`, applied
at `routes.rb:767`), so `q=b` on ZFIN returns `[]` as well: the box has no
answer there and now says so. The check cannot be delegated to
`VALID_SEQUENCE_ID`, which the `?name=` path uses (`routes.rb:664`) — that
pattern permits `:` and accepts `BL_ORD_ID:0` quite happily.

Fixing this properly means standardising the deflines upstream, or looking names
up against something that knows them. It is not more pattern matching here.

**The box is still offered where it cannot answer.** The docstring at
`gene_search.js:17` claims the component "renders nothing where the deployment
has no name indexes"; it does not. `render` is unconditional, `query.js:355`
renders `<GeneSearch>` unconditionally, and nothing in `searchdata.json` reports
whether usable names exist. On ZFIN and RGD a visitor gets a "Find a gene" box
with no example in it, which answers every gene name with "No gene starting
with …". The claim is simply untrue of the code as it stands.

**Multi-word gene names are unreachable.** When the empty state was first
written, searching `white` on FlyBase returned nothing, which was correct and
unhelpful: the deflines carried `name=w-RA` and the string "white" appeared
nowhere in the database. So the hint said to try the symbol rather than the full
name. Joining FlyBase's synonym table in at index time made that advice false —
`white` on `FB/FB2026_03` now returns 10 candidates, among them `white`,
`whiterabbit` and `white walker` — and a hint that tells people not to do the
thing that works is worse than no hint. It now describes what the match actually
is: the start of a gene's symbol, name or synonym, with the caveat that some
datasets carry no gene names at all (`gene_search.js:158-170`). What has not
changed is that a name containing a space cannot be queried: the index holds
`"white rabbit"` as a key, but the validator rejects the space, so
`q=white%20rabbit` is answered with `400 Invalid gene name`. Such keys are
reachable only as a prefix of their first word, which is how `white walker`
appears in the results for `white` above.

## The browser specs

`test/e2e/gene_search.spec.js` holds twelve Playwright tests. They run against
the deployed dev site, not localhost — `playwright.config.js` explains why: the
dev container sets `HTTPS=on`, so `views/layout.erb` emits absolute `https://`
asset URLs and a page fetched over `http://localhost:4569` loads no CSS and no JS
at all, failing every assertion for reasons unrelated to the code.

What each one pins:

| spec | property |
|---|---|
| the box is offered on the search form | present, empty, and running no search nobody asked for |
| an ambiguous symbol lists every organism that has it | `ACT1` on `R64-5-1f` yields several candidates that are genuinely *different organisms*, including S. cerevisiae and a Candida |
| choosing an organism loads that organism, not the first match | asserts the first candidate is **not** S. cerevisiae, then picks it and checks the textarea holds `NC_001138.5_cds_NP_116614.1_1760`. Fails if the list ever reverts to first-match. Also asserts no database ends up selected |
| both sequence types are searched | `unc-54` on `WB/WS298` includes a `protein` row — WormBase has symbols nowhere else |
| a single-character symbol is searchable | `w` on `FB/FB2026_03` finds D. melanogaster; a minimum length would break this |
| a partial symbol finds the genes that start with it | every returned symbol starts with `act`, and at least one is longer than the query, so this really is prefix matching |
| an exact match is listed before longer symbols | `unc-5` is the first row, above `unc-50`/`unc-51`/`unc-54` |
| one database cannot fill the list | `w` returns both `protein` and `nucleotide` rows, and exactly two rows whose symbol is `w` — one exact hit per database, surviving the cap |
| a symbol is shown with the database's own capitalisation | `Dll`, not `dll` |
| an all-caps symbol is not lower-cased either | `ACT1` on `R64-5-1m`; SGD writes every symbol in caps, so the whole MOD was affected |
| a name the source spells in lower case stays lower case | `white` is not title-cased on the way out merely because a `White` synonym exists — i.e. the companion-file fallback really is the key |
| a symbol nothing carries says so | "No gene starting with", and "start of a gene" in the hint — it asserted the word "symbols" until the hint stopped claiming full names were unsearchable — plus no results, textarea untouched, no page errors |

The three capitalisation specs exist because the rest of the suite compares
symbols case-insensitively and so would not notice that regressing. The spec file
makes the same point at its head about the suite as a whole: what is worth
testing is not that a lookup returns something, but the two things the box exists
to fix.

That a lookup returns something is covered separately, by the three `?name=`
specs in `test/e2e/routing.spec.js:138-183`. They pin that
`?name=YFL039C&type=dna` prefills a real FASTA record on `SGD/R64-5-1m` — a
defline plus a body over 1,000 characters that is nothing but `[ACGTNacgtn]` —
that `?name=ACT1` and `?name=act1` prefill the *same* record rather than merely
"some record", and that a nonsense name leaves the textarea empty with the form
still usable and submit correctly disabled, rather than pasting an error string
into it. Note that on `R64-5-1m` the ACT1 ambiguity does not bite: `act1` appears
in four of its databases and all four map to `YFL039C`, so `?name=ACT1` there
resolves to the yeast record and nothing is being papered over. The collision is
a property of the 312-database fungal set, which is why the gene search specs use
`R64-5-1f` for it.
