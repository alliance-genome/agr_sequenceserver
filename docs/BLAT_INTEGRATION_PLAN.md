# Plan: Add BLAT Support to Alliance SequenceServer

## Context

BLAT (BLAST-Like Alignment Tool) is a fast sequence alignment tool commonly used in genome browsers. The Alliance SequenceServer currently only supports BLAST+. Adding BLAT as a parallel search tool gives users a faster option for near-exact nucleotide matches — a common use case in model organism research. This is a parallel pipeline alongside BLAST, not a replacement.

## Architecture Decision: Standalone `blat` (Phase 1) then gfServer (Phase 2)

Phase 1 uses the standalone `blat` binary, which fits directly into the existing `Job#run` -> `sys()` fork-and-wait pattern. gfServer/gfClient (persistent daemon model) is deferred to Phase 2 as a performance optimization once parsing and rendering are proven.

---

## Phase 1: Minimal Viable BLAT

### Step 1: Backend Data Structures

Create `lib/sequenceserver/blat/` module mirroring `lib/sequenceserver/blast/`:

| New File | Purpose | Pattern From |
|----------|---------|-------------|
| `lib/sequenceserver/blat.rb` | Module loader | `lib/sequenceserver/blast.rb` |
| `lib/sequenceserver/blat/constants.rb` | `ALGORITHMS = %w[blat]`, PSL column defs | `blast/constants.rb` |
| `lib/sequenceserver/blat/hsp.rb` | HSP struct (score, identity, gaps, qstart/qend/sstart/send, qseq/sseq/midline) | `blast/hsp.rb` |
| `lib/sequenceserver/blat/query.rb` | Query struct (number, id, title, length, hits) | `blast/query.rb` |
| `lib/sequenceserver/blat/hit.rb` | Hit struct with `Links` module for JBrowse links | `blast/hit.rb` |
| `lib/sequenceserver/blat/error.rb` | Error handling | `blast/error.rb` |

Key difference: BLAT HSPs have no e-value or bit_score. Set `evalue=0`, `bit_score=0`. Score = `matches + repMatches`. Identity = `matches / (matches + misMatches)`. Gaps = `qNumInsert + tNumInsert`. Compute `qcovhsp = (qEnd - qStart) / qSize * 100`.

### Step 2: PSL Parser (`lib/sequenceserver/blat/report.rb`)

The hardest backend piece. Parses PSL output (use `-out=pslx` for sequences) and produces the same JSON shape as BLAST:

- Group PSL rows by `qName` -> Query objects
- Within each query, group by `tName` -> Hit objects
- Each PSL row -> HSP object
- Build `midline` from character-by-character comparison of qseq/sseq from pslx blocks
- Sort hits by score descending
- `done?` checks that the PSL output file exists

Output JSON must match the BLAST structure: `{program, program_version, queries, querydb, params, stats, ...}` with `program: "blat"`.

### Step 3: BLAT Job (`lib/sequenceserver/blat/job.rb`)

Subclass `SequenceServer::Job`. Key differences from BLAST::Job:
- `command`: `blat 'database.2bit' 'query.fa' 'output.psl' -out=pslx [options]`
- BLAT writes output to a file argument (3rd positional arg), not stdout — override `run` accordingly, writing to `Job#stdout` path
- `.2bit` database located by convention at `/db/{mod}/{version}/blat/{assembly}.2bit`, assembly name from environment.json
- BLAT params: `-minScore`, `-minIdentity`, `-stepSize` (not evalue/max_target_seqs)

### Step 4: Dynamic Dispatch (`lib/sequenceserver/job.rb`)

Replace hardwired `BLAST::Job.new(params)` (has `# TODO: Dynamic dispatch` comment):

```ruby
def self.create(params)
  job = case params[:method]
        when *BLAST::ALGORITHMS then BLAST::Job.new(params)
        when *BLAT::ALGORITHMS  then BLAT::Job.new(params)
        else fail InputError, "Unknown method: #{params[:method]}"
        end
  enqueue(job)
end
```

Add `SequenceServer::BLAT::Job` to `serializable_classes`.

### Step 5: Route Changes (`lib/sequenceserver/routes.rb`)

- **Results JSON** (`GET /:s1/:s2/:jid.json`): Dispatch to `BLAT::Report.new` when `job.is_a?(BLAT::Job)`
- **Downloads** (`GET /:s1/:s2/download/:jid.:type`): Serve raw PSL for BLAT jobs
- **searchdata.json**: Add `blatEnabled: true` flag when `.2bit` files exist for the current mod/version

### Step 6: Binary Init (`lib/sequenceserver.rb`)

Add optional BLAT binary validation in `init_binaries`. BLAT prints usage to stderr on no-args, so catch `CommandFailed` and check output contains 'blat'.

### Step 7: Frontend Search Form

**`public/js/form.js`** — Add `'blat'` to the return arrays in `determineBlastMethods()` for nucleotide query + nucleotide database combinations (last in list, never default).

**`public/js/search_button.js`** — Fix `decorate()` regex (`/(.?)(blast)(.?)/` doesn't match 'blat'): add explicit `if (name === 'blat')` branch. Update tooltip text.

**`public/js/options.js`** — When `blastMethod === 'blat'`, render BLAT-specific params (minScore, minIdentity) instead of evalue/max_target_seqs/task.

### Step 8: Frontend Results

**`public/js/hsp.js`** — Add `case 'blat':` branches:
- `hspStats()`: Show score (not bit_score), skip e-value, show strand (like blastn)
- `getNqseq()`/`getNsseq()`: Same as blastn (use qstart/sstart)
- `qframe_unit()`/`sframe_unit()`: Return 1

**`public/js/query.js`** — "No BLAST hits found" -> conditional on `program`. HitsTable: show "Score" instead of "E value" column for BLAT.

**`public/js/hits_overview.js`** — Add `blat: 'nucleic_acid'` to `SEQ_TYPES`. Color scale: use score instead of e-value for BLAT.

**`public/js/sidebar.js`** — Hide BLAST download formats for BLAT. Show PSL download link instead.

**`public/js/hit.js`** — Hide "Sequence"/"FASTA" buttons when `algorithm === 'blat'` (no BLAST DB to retrieve from).

**`public/js/report.js`** — Loading text: "BLAT-ing" instead of "BLAST-ing" when appropriate.

### Step 9: JBrowse Links

BLAT hits have chromosome names directly in `tName` (PSL column 14) — much cleaner than BLAST's complex chromosome extraction. In `lib/sequenceserver/blat/hit.rb`, the `links` method can pass `tName` directly as the ref_name to `Links.jbrowse()`. The existing JBrowse link generation in `links.rb` should work with minimal changes since it just needs coordinates and a ref_name.

### Step 10: Docker

Add `blat` binary to Dockerfile (from UCSC binaries). Add `.2bit` volume mount convention. Note: UCSC BLAT licensing requires verification for the Alliance's use case.

### Step 11: Database Setup

Each MOD needs `.2bit` files generated for BLAT-searchable assemblies. Convention:
```
/db/{MOD}/{version}/blat/{assembly}.2bit
```

To generate `.2bit` from FASTA:
```bash
faToTwoBit genome.fa genome.2bit
```

The `faToTwoBit` utility is available from UCSC: https://hgdownload.soe.ucsc.edu/admin/exe/linux.x86_64/

The DB generation script needs to:
1. Download genomic FASTA (same source as BLAST databases)
2. Run `faToTwoBit` to create `.2bit` files
3. Place them at the convention path above

### Step 12: Build and Test

- `npm run build` to rebuild frontend bundles
- Prepare a small `.2bit` test database (e.g., C. elegans chr I)
- End-to-end test: submit BLAT query, verify PSL parsing, verify JBrowse links

---

## Phase 2 (Future): gfServer + Polish

- `BlatDaemon` class managing gfServer instances (one per .2bit, unique ports)
- Health check/restart thread
- Switch `BLAT::Job` to use `gfClient`
- Protein BLAT and translated BLAT
- BLAT-specific graphical overview color scaling
- Combined BLAST+BLAT search mode

---

## Key Files to Modify

| File | Change |
|------|--------|
| `lib/sequenceserver/job.rb` | Dynamic dispatch in `Job.create`, add BLAT to serializable_classes |
| `lib/sequenceserver/routes.rb` | Dispatch to BLAT::Report, BLAT downloads, blatEnabled in searchdata |
| `lib/sequenceserver.rb` | Optional BLAT binary validation |
| `public/js/form.js` | Add 'blat' to method lists |
| `public/js/search_button.js` | Fix `decorate()` for non-blast names |
| `public/js/options.js` | BLAT-specific parameter UI |
| `public/js/hsp.js` | Add 'blat' algorithm cases |
| `public/js/query.js` | Conditional text/columns for BLAT |
| `public/js/hits_overview.js` | Add blat to SEQ_TYPES |
| `public/js/sidebar.js` | BLAT download links |
| `public/js/hit.js` | Hide BLAST-only buttons for BLAT |
| `public/js/report.js` | Loading text |
| `Dockerfile` | Install blat binary |

## New Files to Create

| File | Purpose |
|------|---------|
| `lib/sequenceserver/blat.rb` | Module loader |
| `lib/sequenceserver/blat/constants.rb` | BLAT constants |
| `lib/sequenceserver/blat/job.rb` | Job subclass |
| `lib/sequenceserver/blat/report.rb` | PSL parser |
| `lib/sequenceserver/blat/query.rb` | Query struct |
| `lib/sequenceserver/blat/hit.rb` | Hit struct with links |
| `lib/sequenceserver/blat/hsp.rb` | HSP struct |
| `lib/sequenceserver/blat/error.rb` | Error handling |

## PSL Format Reference

21 tab-separated columns:
```
matches misMatches repMatches nCount qNumInsert qBaseInsert tNumInsert tBaseInsert
strand qName qSize qStart qEnd tName tSize tStart tEnd blockCount blockSizes qStarts tStarts
```

With `-out=pslx`, two additional columns are appended: `qSequence` and `tSequence` (comma-separated per-block sequences).

## Verification

1. Start SequenceServer with a `.2bit` database available
2. Select a nucleotide database, enter a nucleotide query, select BLAT from the method dropdown
3. Submit search — verify job creates and runs successfully
4. Verify results page renders with score (no e-value), strand info, pairwise alignment
5. Verify JBrowse links open to correct coordinates
6. Verify PSL download works
7. Verify BLAST searches still work unchanged
