#!/usr/bin/env bash
#
# Smoke test for the SGD-request changes (commits df50020b, 9c6b1501 and the
# follow-up audit fixes).
#
#   ./smoke-test.sh [BASE_URL]      default: http://localhost:4569
#
# Exercises the HTTP surface only, so it can run against any deployment. The
# browser-facing behaviour lives in manual-test-plan.md.
#
# Not using `set -e`: every check should run so the summary is complete.
set -uo pipefail

BASE_URL="${1:-http://localhost:4569}"
SGD_FUNGAL="SGD/R64-5-1f"

if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  RED=''; GRN=''; YEL=''; DIM=''; RST=''
fi

PASS=0; FAIL=0; XFAIL=0
FAILED_NAMES=()

ok()   { PASS=$((PASS+1)); printf '%s  PASS %s %s\n' "$GRN" "$RST" "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); printf '%s  FAIL %s %s\n' "$RED" "$RST" "$1"
         [ $# -gt 1 ] && printf '%s         %s%s\n' "$DIM" "$2" "$RST"; return 0; }
xfail(){ XFAIL=$((XFAIL+1)); printf '%s  KNOWN%s %s\n' "$YEL" "$RST" "$1"
         [ $# -gt 1 ] && printf '%s         %s%s\n' "$DIM" "$2" "$RST"; return 0; }
section(){ printf '\n%s== %s ==%s\n' "$DIM" "$1" "$RST"; }

# --- helpers ---------------------------------------------------------------

# status <name> <path> <expected-code>
status() {
  local name="$1" path="$2" want="$3" got
  got=$(curl -so /dev/null -w '%{http_code}' "$BASE_URL/$path")
  [ "$got" = "$want" ] && ok "$name" || bad "$name" "expected HTTP $want, got $got  ($path)"
}

# header <name> <path> <header-name> <extended-regex the value must match>
header() {
  local name="$1" path="$2" hdr="$3" want="$4" got
  got=$(curl -sI "$BASE_URL/$path" | tr -d '\r' | awk -v h="$hdr" 'BEGIN{IGNORECASE=1} $1==h":"{ $1=""; sub(/^ /,""); print }')
  if printf '%s' "$got" | grep -Eq "$want"; then ok "$name"
  else bad "$name" "$hdr: '$got' does not match /$want/  ($path)"; fi
}

# jsoncheck <name> <path> <python expression over `d`>  -- must evaluate truthy
#
# The expression is passed as argv, never interpolated into the Python source,
# so it may contain quotes of either kind.
jsoncheck() {
  local name="$1" path="$2" expr="$3" out
  out=$(curl -s "$BASE_URL/$path" | python3 -c '
import sys, json
expr = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("NOT-JSON: %s" % e); sys.exit(0)
try:
    print("OK" if eval(expr) else "FALSE: " + expr)
except Exception as e:
    print("ERROR: %s: %s" % (type(e).__name__, e))
' "$expr" 2>&1)
  [ "$out" = "OK" ] && ok "$name" || bad "$name" "$out"
}

# body_lacks <name> <path> <string that must NOT appear>
body_lacks() {
  local name="$1" path="$2" needle="$3"
  if curl -s "$BASE_URL/$path" | grep -qF -- "$needle"; then
    bad "$name" "response body contained: $needle"
  else ok "$name"; fi
}

# elapsed <path> -> whole seconds
elapsed() { curl -so /dev/null -w '%{time_total}' "$BASE_URL/$1" | cut -d. -f1; }

printf 'Smoke test against %s\n' "$BASE_URL"

# --- 0. reachability -------------------------------------------------------
section "0. instance is up"
if ! curl -sf -o /dev/null "$BASE_URL/blast/"; then
  printf '%sCannot reach %s/blast/ — is the container running?%s\n' "$RED" "$BASE_URL" "$RST"
  exit 2
fi
ok "GET /blast/ reachable"

# --- 1. preset defaults (SGD requests #2 and #3) ---------------------------
section "1. BLAST option presets"

jsoncheck "blastn default task is blastn, not blastn-short" \
  "blast/$SGD_FUNGAL/searchdata.json" \
  "'-task blastn' in d['options']['blastn']['default']['attributes']"

jsoncheck "blastn default is not blastn-short" \
  "blast/$SGD_FUNGAL/searchdata.json" \
  "'-task blastn-short' not in d['options']['blastn']['default']['attributes']"

jsoncheck "blastn default carries evalue and max hits" \
  "blast/$SGD_FUNGAL/searchdata.json" \
  "'-evalue 1e-5' in d['options']['blastn']['default']['attributes'] and '-max_target_seqs 100' in d['options']['blastn']['default']['attributes']"

# Every method's every preset must carry a human-readable description.
jsoncheck "all presets across all methods have a non-null description" \
  "blast/$SGD_FUNGAL/searchdata.json" \
  "all(p.get('description') for m in d['options'].values() for p in m.values())"

jsoncheck "blastn exposes both default and short-seq presets" \
  "blast/$SGD_FUNGAL/searchdata.json" \
  "set(d['options']['blastn']) == {'default','short-seq'}"

# --- 2. get_sequence returns JSON on error (the BLASTX 'Unexpected token <') --
section "2. get_sequence error is JSON, not HTML"

GS="blast/$SGD_FUNGAL/get_sequence/?sequence_ids=nosuchseq&database_ids=deadbeef"
header "GET get_sequence error has Content-Type: application/json" \
  "$GS" "Content-Type" "application/json"

body_lacks "GET get_sequence error body is not an HTML page" "$GS" "<!DOCTYPE html>"

jsoncheck "GET get_sequence error body has an 'error' key" \
  "$GS" "'error' in d"

# --- 3. ?name= gene lookup -------------------------------------------------
section "3. ?name= gene lookup"

jsoncheck "?name=YFL039C resolves to the ACT1 CDS" \
  "blast/$SGD_FUNGAL/searchdata.json?name=YFL039C&type=dna" \
  "d.get('query') and 'locus_tag=YFL039C' in d['query']"

jsoncheck "?name= miss returns null query rather than erroring" \
  "blast/$SGD_FUNGAL/searchdata.json?name=ZZZNOTAGENE&type=dna" \
  "d.get('query') is None"

# With name indexes present a lookup is a file read, not a defline scan. Without
# them the scan is capped at NAME_LOOKUP_BUDGET_SECONDS (15) in routes.rb, so the
# bound here covers both; the indexed case should come in far under it.
for probe in "hit:name=YFL039C&type=dna" "miss:name=ZZZNOTAGENE&type=dna"; do
  label="${probe%%:*}"; qs="${probe#*:}"
  secs=$(elapsed "blast/$SGD_FUNGAL/searchdata.json?$qs")
  if [ "$secs" -le 20 ]; then ok "?name= $label completes within the budget (${secs}s)"
  else bad "?name= $label exceeded the budget" "took ${secs}s, cap is 15s"; fi
done

# Gene symbols only resolve on SGD's main dataset via the name index, since its
# deflines carry no [gene=] tag.
jsoncheck "?name=ACT1 resolves a gene symbol on the main SGD dataset" \
  "blast/SGD/R64-5-1m/searchdata.json?name=ACT1&type=dna" \
  "d.get('query') is None or 'ACT1' in d['query'].split('\n')[0]"

# A normal page load must not pay the lookup cost at all.
secs=$(elapsed "blast/$SGD_FUNGAL/searchdata.json")
if [ "$secs" -le 3 ]; then ok "searchdata.json without ?name= stays fast (${secs}s)"
else bad "searchdata.json without ?name= is slow" "took ${secs}s"; fi

# Shell metacharacters must be rejected by the name regex, not passed to a shell.
jsoncheck "?name= with shell metacharacters is rejected" \
  "blast/$SGD_FUNGAL/searchdata.json?name=Y%27%3Bid%3B%23&type=dna" \
  "d.get('query') is None"

# --- 4. permanent URLs -----------------------------------------------------
section "4. /blast/:mod/ permanent URLs"

header "/blast/WB/ redirects to the newest WS release" \
  "blast/WB/" "Location" "/blast/WB/WS[0-9]+/$"
header "/blast/FB/ redirects to a real FB release" \
  "blast/FB/" "Location" "/blast/FB/FB[0-9_]+/$"
header "/blast/SGD/ redirects to an R64 dataset" \
  "blast/SGD/" "Location" "/blast/SGD/R64[A-Za-z0-9.-]*/$"

# ZFIN has prod/ and zfintest/; curators must never be sent to the test set.
header "/blast/ZFIN/ redirects to prod, not zfintest" \
  "blast/ZFIN/" "Location" "/blast/ZFIN/prod/$"

status "/blast/NOSUCHMOD/ is 404" "blast/NOSUCHMOD/" "404"

# --- 5. the new route must not shadow the existing ones --------------------
section "5. route shadowing regressions"

status "/blast/ still serves the search form" "blast/" "200"
status "/blast/sitemap.xml still served" "blast/sitemap.xml" "200"
status "/blast/environment_info.json still served" "blast/environment_info.json" "200"

# /blast/features renders views/features.erb. Older container images predate
# that template and return 500 — that is image drift, not route shadowing. What
# matters here is that it is NOT answered by the :mod redirect.
feat=$(curl -sI "$BASE_URL/blast/features" | tr -d '\r' | awk 'BEGIN{IGNORECASE=1} /^Location:/{print}')
if [ -z "$feat" ]; then ok "/blast/features is not captured by the :mod redirect"
else bad "/blast/features is being redirected by /blast/:mod/" "$feat"; fi

# --- 6. traversal / injection on :mod --------------------------------------
section "6. /blast/:mod/ input validation"

trav=$(curl -sI "$BASE_URL/blast/WB%2F..%2F..%2Fetc/" | tr -d '\r' | awk 'BEGIN{IGNORECASE=1} /^Location:/{ $1=""; sub(/^ /,""); print }')
if [ -z "$trav" ]; then ok "path traversal in :mod does not produce a redirect"
else bad "path traversal in :mod produced a redirect" "Location: $trav"; fi

status "traversal attempt is rejected with 404" "blast/WB%2F..%2F..%2Fetc/" "404"

body_lacks "404 body does not echo :mod back (reflected XSS)" \
  "blast/%3Cscript%3Ealert(1)%3C%2Fscript%3E/" "<script>"

ext=$(curl -sI "$BASE_URL/blast/%2F%2Fevil.example.com/" | tr -d '\r' | awk 'BEGIN{IGNORECASE=1} /^Location:/{print}')
if printf '%s' "$ext" | grep -qi 'evil.example.com'; then
  bad "open redirect via :mod" "Location: $ext"
else ok "no open redirect via :mod"; fi

# --- 7. NCBI links on hits -------------------------------------------------
section "7. NCBI link generation"
# ncbi_link is a pure function; exercise it directly where a container is
# available. Skipped automatically when docker or the container is absent.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^agr-blast-dev$'; then
  ncbi_out=$(docker exec agr-blast-dev ruby -e '
require "/sequenceserver/lib/sequenceserver/links"
L = SequenceServer::Links
cases = [
  ["NP_009332",                        "Pau8p",                                "protein",    "protein/NP_009332"],
  ["NC_001138.5",                      "chromosome VI",                        "nucleotide", "nuccore/NC_001138.5"],
  ["NC_001138.5_cds_NP_116614.1_1760", "[gene=ACT1] [protein_id=NP_116614.1]", "nucleotide", "protein/NP_116614.1"],
  ["Q0010",                            "SGD mitochondrial ORF",                "nucleotide", "NIL"],
  ["WBGene00000001",                   "abc-1",                                "nucleotide", "NIL"],
  ["FBgn0000008",                      "a",                                    "nucleotide", "NIL"],
  ["II",                               "C. elegans chromosome II",             "nucleotide", "NIL"],
]
bad = cases.reject do |acc, title, dbt, want|
  r = L.ncbi_link(acc, title, dbt)
  got = r ? r[:url].sub("https://www.ncbi.nlm.nih.gov/", "") : "NIL"
  got == want
end
puts bad.empty? ? "OK" : "MISMATCH: #{bad.map(&:first).join(", ")}"
' 2>&1 | tail -1)
  [ "$ncbi_out" = "OK" ] && ok "NCBI links: protein/nuccore routing + no links on MOD-native ids" \
                         || bad "NCBI link generation" "$ncbi_out"

  # Both defline styles must resolve: the NCBI-style titles in the fungal set
  # (R64-5-1f) and the [chromosome=XVI] tags in the main set (R64-5-1m).
  sgd_out=$(docker exec agr-blast-dev ruby -e '
require "/sequenceserver/lib/sequenceserver/links"
L = SequenceServer::Links
cases = {
  "Saccharomyces cerevisiae S288C chromosome I, complete sequence"    => "chrI",
  "Saccharomyces cerevisiae S288C chromosome IX, complete sequence"   => "chrIX",
  "Saccharomyces cerevisiae S288C chromosome XVI, complete sequence"  => "chrXVI",
  "Saccharomyces cerevisiae S288c mitochondrion, complete genome"     => "chrmt",
  "[org=Saccharomyces cerevisiae] [strain=S288C] [chromosome=XVI]"    => "chrXVI",
  "[org=Saccharomyces cerevisiae] [strain=S288C] [chromosome=II]"     => "chrII",
  "[org=Saccharomyces cerevisiae] [strain=S288C] [location=mitochondrion]" => "chrmt",
  "[org=Saccharomyces cerevisiae] [strain=A364A D5] [chromosome=2-micron]" => nil,
}
bad = cases.reject { |t, want| L.extract_sgd_chromosome(t, nil) == want }
puts bad.empty? ? "OK" : "MISMATCH: #{bad.keys.join(" | ")}"
' 2>&1 | tail -1)
  [ "$sgd_out" = "OK" ] && ok "SGD chromosome names map to JBrowse refseqs (both defline styles)" \
                        || bad "SGD chromosome extraction" "$sgd_out"

  # The dataset /blast/SGD/ lands on must carry JBrowse config, or the linkout
  # silently disappears for anyone following the permanent URL.
  sgd_target=$(curl -sI "$BASE_URL/blast/SGD/" | tr -d '\r' \
    | awk 'BEGIN{IGNORECASE=1}/^Location:/{print $2}' | sed 's|.*/blast/SGD/||;s|/$||')
  for v in $(printf '%s\n' "$sgd_target" R64-5-1f R64-5-1m | awk 'NF && !seen[$0]++'); do
    gb=$(docker exec agr-blast-dev sh -c \
      "grep -c genome_browser /sequenceserver/public/environments/SGD/$v/environment.json 2>/dev/null" || echo 0)
    if [ "${gb:-0}" -ge 1 ]; then ok "SGD/$v has JBrowse genome_browser config ($gb entries)"
    else bad "SGD/$v has no genome_browser config" "JBrowse linkout will not render there"; fi
  done
else
  printf '%s  SKIP  docker/agr-blast-dev unavailable; NCBI+SGD unit checks skipped%s\n' "$DIM" "$RST"
fi

# --- 8. other MODs still respond ------------------------------------------
section "8. cross-MOD regression"
status "WB WS298 search page still loads"  "blast/WB/WS298/"        "200"
status "WB WS298 searchdata.json still OK" "blast/WB/WS298/searchdata.json" "200"

# --- summary ---------------------------------------------------------------
printf '\n%s%d passed%s, %s%d failed%s' "$GRN" "$PASS" "$RST" "$RED" "$FAIL" "$RST"
[ "$XFAIL" -gt 0 ] && printf ', %s%d known-failing%s' "$YEL" "$XFAIL" "$RST"
printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '\nFailed checks:\n'
  for n in "${FAILED_NAMES[@]}"; do printf '  - %s\n' "$n"; done
  exit 1
fi
exit 0
