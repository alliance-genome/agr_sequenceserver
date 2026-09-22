# Manual test plan — SGD change set

Covers commits `df50020b`, `9c6b1501` and the follow-up audit fixes. Each test
is an ID, what it proves, what to do, what you should see, and the specific
wrong behaviour that means a regression.

For everything testable without a browser, run `./smoke-test.sh` in this
directory instead — it asserts the same backend behaviour in a few seconds.
This document is only for what needs eyes on a page.

---

## Setup

### S1. Use a browser-testable instance

> **The `agr-blast-dev` container on port 4569 cannot be used for browser
> testing.** It is started with `HTTPS=on`, so `views/layout.erb` emits
> `https://localhost:4569/...` for every stylesheet and script. Port 4569
> serves plain HTTP, so the browser loads **zero CSS and zero JS** — no React,
> no database tree, no Settings block. Every UI test below would "fail" for a
> reason unrelated to the code.

Launch an instance without `HTTPS=on` and copy the build into it:

```bash
cd <repo root>
docker rm -f agr-blast-ui 2>/dev/null
docker run -d --name agr-blast-ui -p 4570:4567 \
  -v /var/sequenceserver-data/blast:/db \
  -v /var/sequenceserver-data/config:/sequenceserver/public/environments \
  -e NODE_ENV=production \
  agr-blast-dev sequenceserver -c /sequenceserver/public/configs/sequenceserver.conf

for f in lib/sequenceserver/routes.rb lib/sequenceserver/links.rb \
         lib/sequenceserver/blast/hit.rb public/configs/sequenceserver.conf \
         public/css/app.min.css public/sequenceserver-search.min.js \
         public/sequenceserver-report.min.js; do
  docker cp "$f" "agr-blast-ui:/sequenceserver/$f"
done

# The image ships an older views/layout.erb that raises NoMethodError on
# /blast/ (no MOD segment). Sync the templates too or that page 500s.
docker cp views/. agr-blast-ui:/sequenceserver/views/

docker restart agr-blast-ui && sleep 10
```

- [ ] **S1** `curl -s http://localhost:4570/blast/SGD/R64-5-1f/ | grep app.min.css`
  shows an `http://` URL, not `https://`.

**Base URL for every test below: `http://localhost:4570`**

### S2. Confirm the new code is actually being served

- [ ] **S2a** `curl -sI http://localhost:4570/blast/ZFIN/ | grep -i location`
  → `/blast/ZFIN/prod/`. (Old code returned `/blast/ZFIN/zfintest/`.)
- [ ] **S2b** `curl -s http://localhost:4570/blast/SGD/R64-5-1f/searchdata.json | python3 -c "import sys,json;print(json.load(sys.stdin)['options']['blastp']['default']['description'])"`
  prints a sentence, not `None`.

### Test data

Real *S. cerevisiae* ACT1 (`YFL039C`). Copy-paste these verbatim.

**Nucleotide — first 300 bp of the ACT1 CDS:**

```
>ACT1_CDS_1-300
ATGGATTCTGAGGTTGCTGCTTTGGTTATTGATAACGGTTCTGGTATGTGTAAAGCCGGTTTTGCCGGTGACGACGCTCC
TCGTGCTGTCTTCCCATCTATCGTCGGTAGACCAAGACACCAAGGTATCATGGTCGGTATGGGTCAAAAAGACTCCTACG
TTGGTGATGAAGCTCAATCCAAGAGAGGTATCTTGACTTTACGTTACCCAATTGAACACGGTATTGTCACCAACTGGGAC
GATATGGAAAAGATCTGGCATCATACCTTCTACAACGAATTGAGAGTTGCCCCAGAAGAA
```

**Protein — Act1p:**

```
>NP_116614.1_actin
MDSEVAALVIDNGSGMCKAGFAGDDAPRAVFPSIVGRPRHQGIMVGMGQKDSYVGDEAQSKRGILTLRYPIEHGIVTNWD
DMEKIWHHTFYNELRVAPEEHPVLLTEAPMNPKSNREKMTQIMFETFNVPAFYVSIQAVLSLYSSGRTTGIVLDSGDGVT
HVVPIYAGFSLPHAILRIDLAGRDLTDYLMKILSERGYSFSTTAEREIVRDIKEKLCYVALDFEQEMQTAAQSSSIEKSY
ELPDGQVITIGNERFRAPEALFHPSVLGLESAGIDQTTYNSIMKCDVDVRKELYGNIVMSGGTTMFPGIAERMQKEITAL
```

---

## T1 — Preset defaults and descriptions

**Proves:** the task pulldown defaults to `blastn` (not `blastn-short`), and
presets read as English rather than raw flags.

- [ ] **T1a** Open `http://localhost:4570/blast/SGD/R64-5-1f/`.
- [ ] **T1b** Paste the **nucleotide** sequence into the query box.
- [ ] **T1c** In the database tree open **Saccharomyces → S_cerevisiae_Coding_Sequences**
      and tick it.
- [ ] **T1d** Look at the **Settings** block.

**Expected:** two radio options, the first selected:

| | |
|---|---|
| **default:** | Standard nucleotide BLAST (E-value: 1e-5, Max hits: 100) |
| **short-seq:** | Short sequences under 50bp (E-value: 0.1) |

- [ ] **T1e** The **Task** dropdown reads `blastn`.

**Fails if:** `short-seq` is the pre-selected radio, the Task dropdown reads
`blastn-short`, or the rows show bare flags (`-task blastn -evalue 1e-5`)
instead of prose.

- [ ] **T1f** Clear the query box, paste the **protein** sequence, tick
      **S_cerevisiae_Protein_Sequences**. The Settings block still appears, with
      one row: *Standard protein BLAST (E-value: 1e-5, Max hits: 100)*.

**Fails if:** the Settings block vanishes entirely for protein searches. That
was the pre-fix behaviour — the block was hidden whenever a method had only one
preset, so four of the five descriptions could never be seen.

---

## T2 — NCBI links on hits

**Proves:** hits link to the right NCBI database, and MOD-native identifiers
do not get bogus links.

- [ ] **T2a** Run the T1 nucleotide search (**Coding Sequences** database).
- [ ] **T2b** On the first hit's link row, find a link labelled
      **NCBI: NP_116614.1**.
- [ ] **T2c** Hover it — the target is `https://www.ncbi.nlm.nih.gov/protein/NP_116614.1`.
- [ ] **T2d** Click it. NCBI shows the **actin [Saccharomyces cerevisiae S288C]**
      protein record.

**Fails if:** the link points at `/nucleotide/...` for a protein accession, or
the label shows a bare accession with no `NCBI:` prefix.

- [ ] **T2e** Now search the **S_cerevisiae_Genome_Assembly** database with the
      nucleotide sequence. The hit link reads **NCBI: NC_001138.5** and targets
      `https://www.ncbi.nlm.nih.gov/nuccore/NC_001138.5`.

**Fails if:** a genomic accession routes to `/protein/`.

- [ ] **T2f** **Regression — no bogus links.** Open
      `http://localhost:4570/blast/WB/WS298/`, paste any *C. elegans* sequence,
      search a genome database. Hits must show **no `NCBI:` link at all**
      (WormBase accessions like `II` or `WBGene…` are not NCBI accessions).

**Fails if:** any `NCBI:` link appears on a WormBase hit. The pre-fix
catch-all regex did this, producing links to records that do not exist.

---

## T3 — SGD JBrowse linkout

**Proves:** SGD genome hits link into SGD's JBrowse at the right chromosome.

- [ ] **T3a** Search the **nucleotide** sequence against
      **S_cerevisiae_Genome_Assembly**.
- [ ] **T3b** The hit row has a **JBrowse** link.
- [ ] **T3c** Hover it: the URL is on `jbrowse.yeastgenome.org` and the `loc=`
      parameter names **`chrVI`** (ACT1 is on chromosome VI), *not* `NC_001138.5`.
- [ ] **T3d** Click it. SGD's JBrowse opens on chromosome VI with a **BLAST
      Hits** feature visible near position 53,260–54,700.

**Fails if:** `loc=` contains a RefSeq accession (`NC_001138.5`) — JBrowse
refseq names are `chrI`…`chrXVI`/`chrmt` and will not resolve — or the URL has
a doubled `?` / a stray `data=` segment.

- [ ] **T3e** **The main SGD dataset.** `R64-5-1m` is SGD's primary dataset and
      is where `/blast/SGD/` lands. Open
      `http://localhost:4570/blast/SGD/R64-5-1m/`, paste the **nucleotide**
      sequence and tick **S288C_Reference_Strain_Genomic_DNA →
      Nuclear_chromosomes**. The hit must also carry a **JBrowse** link with
      `loc=chrVI:…`.

> The two datasets label chromosomes differently — `R64-5-1f` uses NCBI-style
> `chromosome VI, complete sequence`, `R64-5-1m` uses SGD-style
> `[chromosome=VI]`. Both must resolve to `chrVI`.

- [ ] **T3f** Repeat against **Mitochondrial_chromosome** — `loc=chrmt:…`.
- [ ] **T3g** Repeat against **2_micron_plasmid** — there must be **no JBrowse
      link**. SGD's JBrowse has no 2-micron reference, so a link would 404.

- [ ] **T3h** **Regression — other MODs' JBrowse still works.** On
      `http://localhost:4570/blast/WB/WS298/`, run a genome search and confirm
      the **JBrowse** link still opens WormBase JBrowse 2 at the right location.

**Fails if:** the WormBase link is missing or its `loc=` is malformed. The
JBrowse-1 URL builder was changed to tolerate an empty assembly, and WormBase
goes through the neighbouring code path.

---

## T4 — `?name=` deep link prefills the query box

**Proves:** SGD can link straight into BLAST for a gene.

- [ ] **T4a** Open
      `http://localhost:4570/blast/SGD/R64-5-1f/?name=YFL039C&type=dna`.
- [ ] **T4b** The page takes **several seconds** (the lookup scans deflines
      across databases; ~5–15s is expected).
- [ ] **T4c** The query box is pre-filled with a FASTA record whose header
      contains `[gene=ACT1] [locus_tag=YFL039C]`.

**Fails if:** the box is empty, or the page hangs past ~20s (the scan is capped
at 15s by `NAME_LOOKUP_BUDGET_SECONDS`).

- [ ] **T4d** Open `.../?name=ZZZNOTAGENE&type=dna` — the form loads normally
      with an **empty** query box and no error banner.
- [ ] **T4e** Open `http://localhost:4570/blast/SGD/R64-5-1f/` with no
      parameters. It loads in well under a second.

**Fails if:** the plain page load is also slow — the lookup must only run when
`?name=` is present.

---

## T5 — Database tree affordance

**Proves:** it is discoverable that tree groups expand.

- [ ] **T5a** On `http://localhost:4570/blast/SGD/R64-5-1f/`, above the tree
      there is the hint *"Click arrows to expand/collapse groups. Use checkboxes
      to select databases."*
- [ ] **T5b** Collapsed groups show a clear arrow; clicking one expands it.
- [ ] **T5c** The arrow is comfortably clickable (a ~24px target), and the
      expand/collapse icons are not visually clipped or offset.

**Fails if:** the hint is duplicated once per category, or the enlarged hit area
shifts the jstree sprite so arrows render half-cut.

---

## T6 — Sequence viewer error handling (the BLASTX bug)

**Proves:** a failed sequence fetch shows a readable message instead of
`Unexpected token '<'`.

- [ ] **T6a** Run any search that returns hits.
- [ ] **T6b** Click **Sequence** on a hit — the viewer opens and shows the
      sequence.
- [ ] **T6c** With devtools open, confirm the `get_sequence/` response has
      `Content-Type: application/json`.
- [ ] **T6d** Force the error path — in the devtools console:
      ```js
      fetch('get_sequence/?sequence_ids=nosuch&database_ids=deadbeef')
        .then(r => r.headers.get('content-type')).then(console.log)
      ```
      → `application/json; charset=utf-8`.

**Fails if:** the response is `text/html`, or the UI surfaces
`Unexpected token '<'` / `SyntaxError` instead of a message.

- [ ] **T6e** Click **FASTA** on a hit — the download starts normally.

**Fails if:** a Sinatra stack-trace page appears instead of a download or a
plain-text error.

---

## T7 — Permanent URLs

**Proves:** version-less URLs are safe to bookmark and publish.

- [ ] **T7a** `http://localhost:4570/blast/WB/` → lands on `/blast/WB/WS298/`
      (the newest release), fully loaded.
- [ ] **T7b** `http://localhost:4570/blast/SGD/` → lands on **`/blast/SGD/R64-5-1m/`**,
      SGD's main dataset, and hits there carry JBrowse links (see T3e).
- [ ] **T7c** `http://localhost:4570/blast/ZFIN/` → lands on **`/blast/ZFIN/prod/`**.

**Fails if:** ZFIN lands on `zfintest`. Sending curators to a test dataset is
the specific regression this guards.

- [ ] **T7d** `http://localhost:4570/blast/NOSUCHMOD/` → a plain 404 reading
      *"No databases found"*.

**Fails if:** the page echoes `NOSUCHMOD` back (reflected-input bug), or the
existing pages `/blast/`, `/blast/sitemap.xml`, `/blast/environment_info.json`
stop working — the `:mod` route sits in front of them.

> `/blast/features` returns 500 on this image because `views/features.erb`
> post-dates it. That is image drift, not a routing regression; the smoke test
> asserts only that the route is *not* swallowed by the `:mod` redirect.

---

## T8 — Cross-MOD smoke

**Proves:** the shared `links.rb` / `routes.rb` edits did not break other MODs.

- [ ] **T8a** `http://localhost:4570/blast/WB/WS298/` loads; tree and Settings render.
- [ ] **T8b** A WormBase search returns hits with working **JBrowse** and
      **WB:** links.
- [ ] **T8c** Repeat for FlyBase (`/blast/FB/`) and RGD (`/blast/RGD/`).

**Fails if:** any MOD loses its existing links, gains a spurious `NCBI:` link,
or its Settings block disappears.

---

## Teardown

```bash
docker rm -f agr-blast-ui
```
