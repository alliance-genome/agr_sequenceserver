# Running the three BLAST instances

Everything below was read off the host on 2026-10-02. None of it was written
down anywhere before this file, which is the main reason it exists. The topology
is three `docker run` invocations and two nginx `server` blocks. The
invocations survive nowhere but in the containers themselves — the shell
histories hold only an older form of the prod one, against a differently-named
image — so the commands here were reconstructed from `docker inspect`. The
nginx blocks do not route the way the hostnames suggest, and that part has cost
people time.

Line numbers below are against `main` at `b435058e` (PR #31), the commit dev is
running — not against whatever happens to be checked out. The working copy on
this host is routinely parked on a feature branch, and a branch's bundles are
not the ones any instance serves, so `md5sum public/...` in the working tree
will not reproduce the figures here while `git show b435058e:public/...` will.

Measured figures are dated where they appear, because several were taken at
`73e4a38a` before #31 merged. The one that matters most is the asset digest
used below as a fingerprint: dev moved from `279b24bc…` to `d2a25f6a…` when it
was rebuilt onto `b435058e`. Read a digest off the instance rather than
trusting one written down here.

Nothing here is automated. There is no CI deploy, no orchestration, no image
registry, and no image is pushed anywhere — the tags below exist only in this
host's local Docker. `deploy.sh` in the repository root looks like the deploy
script and is not: it builds an image called `agr-blast-prod-container`, and the
container actually serving production runs `agr-blast:fda1db1f`. Running it
would redeploy prod from an untagged image and lose the one record of which
commit is live, so treat it as historical. `monitor.sh` beside it is harmless —
an interactive menu of `docker logs`, `restart`, `stop`, `exec` against
`agr-blast-prod` — but it only knows about prod. The same goes for
`docker-compose.yaml`, which describes four per-MOD services on ports 5001-5004;
none of the three running containers carries a `com.docker.compose.*` label, so
nothing on this host was started from it.

## The three instances

| | test | dev | prod |
|---|---|---|---|
| container | `agr-blast-restyle` | `agr-blast-dev` | `agr-blast-prod` |
| image | `agr-blast:a3ecb680` | `agr-blast:a3ecb680` | `agr-blast:fda1db1f` |

Test and dev were moved onto `a3ecb680`, which is `main` at the Alliance
JBrowse 2 work, on 2026-10-09. Both now run the same image, so the floating
`agr-blast:restyle` tag no longer names what the test instance serves; read the
image off the container rather than trusting a tag.
| host port | 4570 | 4569 | 4568 |
| reached at | `http://172.31.3.193:4570` | `https://blast-dev.alliancegenome.org` | `https://blast.alliancegenome.org` |
| `public/environments` from | `/var/sequenceserver-data/config-dev` | `/var/sequenceserver-data/config-dev` | `/var/sequenceserver-data/config` |
| `HTTPS` | unset | `on` | `on` |
| restart policy | `no` | `no` | `unless-stopped` |

All three mount `/var/sequenceserver-data/blast` at `/db` read-write and all
three run the identical command,
`sequenceserver -c /sequenceserver/public/configs/sequenceserver.conf`. They
differ in code, in which config directory they see, and in nothing else. There
is no per-instance data: a database release appears on all three at the same
moment, because all three re-scan the same directory on every request.

### The config volume split is the one real difference, and it is load-bearing

Databases and `environment.json` files travel separately, and only the config
half has a staging step. The manager writes `environment.json` to
`CONFIG_DEPLOY_ROOT`, which defaults to the *dev* directory
(`agr_blastdb_manager/src/utils.py:151`). The comment immediately above that
constant records why:

> This used to be `/var/sequenceserver-data/config`, which the dev and prod
> containers both mounted read-write. A config change therefore took effect on
> production the moment it was written — no deploy, no review — and that is how
> production ended up serving genome browser links for code that only existed
> on dev.

So a config change lands where it can be looked at, and promoting it to
production is a deliberate, manual copy:

```bash
cp -a /var/sequenceserver-data/config-dev/. /var/sequenceserver-data/config/
```

At the time of writing the two directories are byte-identical —
`diff -rq /var/sequenceserver-data/config /var/sequenceserver-data/config-dev`
prints nothing — so the split is currently latent. Nothing detects or reports
drift between them, and nothing reminds you to run that `cp`. If production
stops showing a genome browser link that dev shows, this is the first thing to
check.

### Why test has no HTTPS, and why that is deliberate

`views/layout.erb:15` and `views/search.erb:2` emit **absolute** asset URLs, and
choose `https` if any of four things is true: `X-Forwarded-Proto: https`, the
request port is 443, `ENV['HTTPS'] == 'on'`, or the request `Host` contains
`alliancegenome.org`. Dev and prod set `HTTPS=on` because they sit behind TLS
terminators that speak plain HTTP to the container. Test does not, and the
commit that introduced it says why in as many words — "running for review on
port 4570, deliberately without `HTTPS=on` so it is reachable in a browser over
the internal address" (`b9d9de72`). Test has no proxy and no DNS name; you
reach it on port 4570 directly, and an `https://` asset URL on a port that
speaks only HTTP loads nothing:

```
$ curl -s http://localhost:4568/blast/WB/WS298/ | grep -o 'href="[^"]*app.min.css[^"]*"'
href="https://localhost:4568/blast/css/app.min.css?v=651d65fef8d4"

$ curl -s http://localhost:4570/blast/WB/WS298/ | grep -o 'href="[^"]*app.min.css[^"]*"'
href="http://localhost:4570/blast/css/app.min.css?v=<branch currently in agr-blast:restyle>"
```

The first of those — any `HTTPS=on` container reached over plain HTTP — is a
page that returns HTTP 200 with valid HTML and then loads zero CSS and zero
JavaScript, because nothing serves `https://localhost:4568`. React never boots
and nothing on the page works, while a status-code check passes. That is the
one constraint the browser suite documents at length (`test/e2e/README.md`):
never point Playwright at `http://localhost:4569` either.

Note incidentally that the `?v=` value is the first 12 hex digits of the
SHA-256 of the asset file (`lib/sequenceserver/routes.rb:903-921`, `asset_version`), so it is a
reliable fingerprint of which bundle a given container is serving. `651d65fe…`
is prod's CSS, i.e. `app.min.css` as committed at `fda1db1f`; `d2a25f6a…` is
dev's, i.e. `main` at `b435058e` (it was `279b24bc…` at `73e4a38a`, which is
the kind of drift that makes this a useful check rather than a constant). Test
has no fixed digest to quote: it is
whatever branch was last built into the floating `agr-blast:restyle` tag, which
is rebuilt in place several times a day, so read it off the instance rather than
trusting a value written down here. `sha256sum public/css/app.min.css | cut -c1-12`
in the tree you built it from is the other half of that check, and the two
agreeing is how you confirm test is running the branch you think it is.

## Which container actually answers which URL

This is the part that will cost you an afternoon if you take it on trust.
`/etc/nginx/nginx.conf` has exactly two server blocks, both with
`server_name *.alliancegenome.org`:

| nginx listener | proxies to | instance |
|---|---|---|
| `listen 443 ssl` (nginx.conf:34) | `http://localhost:4569` | **dev** |
| `listen 80` (nginx.conf:50) | `http://localhost:4568` | **prod** |

The 443 block is a catch-all. Any `*.alliancegenome.org` name that arrives at
this box over TLS is served by dev, including the production name. Production
traffic avoids that only because, from the public internet,
`blast.alliancegenome.org` is a CNAME to
`agr-services-1974539419.us-east-1.elb.amazonaws.com`; the load balancer
terminates TLS and forwards to port 80 here, which nginx sends to 4568. From
*this host* the same name resolves to 172.31.3.193 — the host itself — so an
on-box HTTPS request to the production URL is answered by dev. Measured three
ways, by the CSS fingerprint:

```
$ curl -s  http://blast.alliancegenome.org/blast/WB/WS298/            # nginx :80  -> 4568
…app.min.css?v=651d65fef8d4      prod

$ curl -sk https://blast.alliancegenome.org/blast/WB/WS298/           # nginx :443 -> 4569
…app.min.css?v=279b24bcfa8c      dev   (!)

$ curl -sk -H 'Host: blast.alliancegenome.org' https://54.157.220.173/blast/WB/WS298/
…app.min.css?v=651d65fef8d4      prod  (via the ELB, as a real visitor)
```

**Verify production on `http://localhost:4568`, never through its public name
from this host.** `blast-dev.alliancegenome.org` resolves to the host's own
public address and is served by the 443 block, so for dev the public name and
the port agree; its certificate is a Let's Encrypt one for that single name,
valid 2026-09-23 to 2026-12-22.

nginx is `systemctl enable`d. `docker.service` is **not** (`docker.socket` is),
so dockerd is socket-activated; prod's `--restart unless-stopped` can only act
once dockerd is running. What a cold reboot of this host actually brings back is
untested — the machine has been up 24 days — so treat "prod restarts itself" as
unverified.

## Image tags

Dev and prod images are tagged with the 8-character `agr_sequenceserver` `main`
commit they were built from: `git rev-parse --short=8 HEAD`. That is the whole
convention, and it is the only record of what is deployed. Test uses the
floating tag `agr-blast:restyle`, rebuilt in place from whatever working branch
is under review, so its tag tells you nothing about its contents — check the
image id or the asset fingerprint instead.

You can check a tag rather than trust it. The bundle inside the image matches
the one committed at that commit, so:

```bash
docker run --rm --entrypoint sh agr-blast:fda1db1f \
  -c 'md5sum /sequenceserver/public/sequenceserver-search.min.js'
# 11885c7e9d53425616eb91aade1eaf79

git show fda1db1f:public/sequenceserver-search.min.js | md5sum
# 11885c7e9d53425616eb91aade1eaf79
```

## Rebuilding and redeploying an instance

The three running images were not built the same way, which is worth knowing
before you pick a target. `docker history` shows prod's top two layers are the
`COPY --from=node` pair, i.e. it was built with `--target=minify`; dev's and
test's top layer is `VOLUME [/db]`, the Dockerfile's final stage, i.e. the
default target:

```
$ docker history agr-blast:fda1db1f --format '{{.CreatedBy}}' | head -2
COPY /usr/src/app/public/css/sequenceserver.…
COPY /usr/src/app/public/sequenceserver-*.mi…

$ docker history agr-blast:73e4a38a --format '{{.CreatedBy}}' | head -1
VOLUME [/db]
```

**Use the default target.** `minify` adds a `node:20-alpine` stage that runs
`npm run build` and copies two things forward: the two
`public/sequenceserver-*.min.js` bundles, and `public/css/sequenceserver.min.css`
(`Dockerfile:106-107`). It does not copy `public/css/app.min.css`. That is
backwards — `app.min.css` is the stylesheet the page loads, while
`sequenceserver.min.css` sits inside an HTML comment in
`views/layout.erb:29-35` and is never requested at all. So the stage spends an
npm install and a webpack run refreshing one file nothing reads and leaving the
one that matters as committed.

Its effect on the JavaScript is worse than useless, it is misleading: it
silently replaces the committed bundles with a fresh build, so a pull request
that changed JavaScript and forgot `npm run build` would ship correctly on prod
and incorrectly on dev and test, which is the opposite of what you want to find
out. On the current prod image it happens to make no difference — all four
assets in `agr-blast:fda1db1f` are byte-identical to what is committed at
`fda1db1f`, including the two the node stage rebuilt, which is evidence that
`fda1db1f`'s bundles were genuinely in sync with its source.

`.dockerignore` is a deny-everything list with a dozen exceptions, so `spec/`
and `test/` are **not** in any image. That matters for running the Ruby suite
(below).

### Build once

Dev and prod take the same image, so build it once and name it after the commit:

```bash
cd /home/ec2-user/gitroot/pull-upstream/agr_sequenceserver
git checkout main && git pull
TAG=$(git rev-parse --short=8 HEAD)

docker build . -t agr-blast:$TAG
```

### prod

**The image is already built.** `agr-blast:c3867140` is `main`, built and
checked on 2026-10-09, and it is the same image id as the `agr-blast:a3ecb680`
that test and dev run, so it has been exercised on both. All four committed
bundles in it match `git show HEAD:public/...`. Rebuild only if `main` has moved
since.

**Promote the config in the same window.** Production reads
`/var/sequenceserver-data/config`, whose ALLIANCE entries still name the
assemblies retired on 2026-10-09 and so match none of the rebuilt databases.
The deploy is therefore two copies, not one:

```bash
cp -a /var/sequenceserver-data/config-dev/. /var/sequenceserver-data/config/
```

Measured on `agr-blast:c3867140` against the real database tree, with one
cross-species search of 152 hits:

| config | links | correct refName | wrong |
|---|---|---|---|
| production's current config | 6 | 6 | 0 |
| after the copy above | 152 | 152 | 0 |

So forgetting the copy costs 146 links and breaks nothing. Doing the copy
without the new image is the combination to avoid: the older code ignores
`ref_name` and answers `Chr1` for rat, which GRCr8 does not contain.

**Rescue the job history first.** Until the `jobs-prod` volume below exists,
prod keeps its jobs in `/root/.sequenceserver` *inside the container's writable
layer*, so the `docker rm -f` that starts a redeploy deletes every one of them.
Each is a result URL someone may have shared or bookmarked; at the last count
there were 1,758 of them, 3.6 GB. They do not come back.

```bash
# Point-in-time copy, so run it IMMEDIATELY before the swap -- anything
# submitted after this runs and before the container stops is lost.
mkdir -p /var/sequenceserver-data/jobs-prod
docker cp agr-blast-prod:/root/.sequenceserver/. /var/sequenceserver-data/jobs-prod/

# Must match, and must not be zero.
docker exec agr-blast-prod sh -c 'find /root/.sequenceserver -name job.yaml | wc -l'
find /var/sequenceserver-data/jobs-prod -name job.yaml | wc -l
```

Then recreate, with that directory mounted so the next redeploy needs no rescue
at all:

```bash
# Keep the old container rather than deleting it, so rollback is a rename.
docker stop agr-blast-prod
docker rename agr-blast-prod agr-blast-prod-pre-$TAG

docker run -d --name agr-blast-prod \
  --restart unless-stopped \
  -p 4568:4567 \
  -v /var/sequenceserver-data/blast:/db \
  -v /var/sequenceserver-data/config:/sequenceserver/public/environments \
  -v /var/sequenceserver-data/jobs-prod:/root/.sequenceserver \
  -e HTTPS=on \
  -e NODE_ENV=production \
  agr-blast:$TAG \
  sequenceserver -c /sequenceserver/public/configs/sequenceserver.conf
```

Both `-e` lines are load-bearing and easy to drop: `HTTPS=on` drives the fork's
own proxy detection (see "Why test has no HTTPS" above), and without it the
URLs the page builds for itself come out as `http://` behind the Alliance
proxy. Confirm an old job still resolves before announcing the deploy:

```bash
# Any id from /var/sequenceserver-data/jobs-prod; the segments are not checked
# against the job, so WB/WS298 works for any of them.
JID=$(ls /var/sequenceserver-data/jobs-prod | head -1)
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://localhost:4568/blast/WB/WS298/$JID.json"
# 200 -- a 404 here means the job history did not survive; roll back.
```

Rollback, if it did not:

```bash
docker rm -f agr-blast-prod
docker rename agr-blast-prod-pre-$TAG agr-blast-prod
docker start agr-blast-prod
```

### dev

Identical except for the port, the config volume, the restart policy, and the
absence of `NODE_ENV`:

```bash
docker rm -f agr-blast-dev
docker run -d --name agr-blast-dev \
  -p 4569:4567 \
  -v /var/sequenceserver-data/blast:/db \
  -v /var/sequenceserver-data/config-dev:/sequenceserver/public/environments \
  -e HTTPS=on \
  agr-blast:$TAG \
  sequenceserver -c /sequenceserver/public/configs/sequenceserver.conf
```

### test

Built from the branch under review, tagged `restyle`, and with **no** `HTTPS`
variable so the page is usable over `http://172.31.3.193:4570`:

```bash
git checkout <branch>
docker build . -t agr-blast:restyle

docker rm -f agr-blast-restyle
docker run -d --name agr-blast-restyle \
  -p 4570:4567 \
  -v /var/sequenceserver-data/blast:/db \
  -v /var/sequenceserver-data/config-dev:/sequenceserver/public/environments \
  agr-blast:restyle \
  sequenceserver -c /sequenceserver/public/configs/sequenceserver.conf
```

Those three `docker run` lines were reconstructed from `docker inspect` of the
containers running now, not copied from a script, because no script produces
them.

The tag is only as honest as the working tree. `docker build` sends the working
tree, not the commit, so building with a dirty tree produces an image tagged
with a commit it does not contain — and since the tag is the only record of what
is deployed, that is a lie you cannot detect later. Check `git status` before
building for dev or prod, and keep the floating `restyle` tag for anything that
is not a clean checkout of `main`.

`NODE_ENV=production` on prod is inherited from `deploy.sh` and does nothing at
runtime: nothing under `lib/`, `views/` or `config.ru` reads it, the only
reference anywhere is `public/js/sidebar.js:10`, and that is resolved when
webpack runs, which is not in a running container. It is listed anyway because
it is what prod actually has, and a redeploy that silently drops an environment
variable is the kind of difference nobody later believes was accidental.

A redeploy loses that container's job history. Finished jobs live inside the
container at `/root/.sequenceserver`, not on the shared volume, with a 12-hour
`:job_lifetime` (`public/configs/sequenceserver.conf`), so every result URL
anyone is holding against that instance stops resolving.

Rolling back is the same `docker run` with the previous tag, and it works
because the images are kept: the local registry currently holds 19
`agr-blast:<sha>` tags (17 distinct images — two pairs of shas point at one
image each) plus four named tags, going back two weeks, `agr-blast:fda1db1f`
among them.
Code rolls back cleanly this way. Data does not roll back at all — see the
`copy_to_production` section at the end.

### Verifying a redeploy

Three checks, in increasing cost. First, that the instance serves databases at
all, and the expected number of them:

```bash
curl -s http://localhost:4569/blast/FB/FB2026_03/searchdata.json \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["database"]))'
# 200
```

Second, that the gene search index is reachable — this is the newest route and
the one that depends on the `*.names.json` files beside each database:

```bash
curl -s 'http://localhost:4569/blast/SGD/R64-5-1m/gene_search?q=act1' | head -c 200
# [{"symbol":"ACT1","accession":"YFL039C","database_id":"51b942c42957ad2dd31d527a422e94bd",…
```

Third, the HTTP smoke suite and the browser suite:

```bash
bash test/manual/smoke-test.sh http://localhost:4569     # 50 passed, 0 failed
npx playwright test                                      # 83 tests, 83 passed (2.5m)
```

The browser suite asserts on UI copy, so "83 passed" holds only when the spec
files and the instance are the same commit. Run a feature branch's specs against
dev and you get failures that are not bugs: a branch that reworded the gene
search hint also reworded `test/e2e/gene_search.spec.js:187`, which then fails
against dev because dev is running `main`'s wording. Check out the deployed
commit before running, or point `E2E_BASE_URL` at the test instance you built
from that branch.

One caveat on the browser suite: **it cannot be pointed at prod from this
host.** Prod runs with `HTTPS=on`, so `E2E_BASE_URL=http://localhost:4568`
yields the broken-asset page described above, and the public name over HTTPS is
answered by dev. `test/e2e/README.md` lists "the prod deployment and port 4568"
under what the suite deliberately does not cover, and that is a consequence of
the routing rather than a choice. So the order that works is: build the image,
deploy it to test or dev, run the browser suite there, and only then redeploy
prod from the same image and verify prod with the two curl checks and
`smoke-test.sh`.

Both of the numbers above are from runs made while writing this file, against
dev at `73e4a38a` with a `73e4a38a` checkout. `test/e2e/README.md:88` still says
64 tests with one known failure. `npx playwright test --list` now reports 83 in
8 files; the gap over the 64 static `test(` blocks is data-driven specs, where
`cross_mod.spec.js`'s 5 declarations list as 17 tests. The known failure — SGD
fungal offering examples for databases the fungal release does not have — is
fixed: `examplesForCurrentMod` filters the offered examples against the
databases the deployment actually returned (`public/js/examples.js:95-104`).

## Running the test suites

### Playwright, and why `E2E_BASE_URL` matters

```bash
npx playwright test                              # or: npm run test:e2e
npx playwright test test/e2e/gene_search.spec.js
E2E_BASE_URL=http://172.31.3.193:4570 npx playwright test   # against test
```

The default is `https://blast-dev.alliancegenome.org`
(`playwright.config.js:19`), i.e. **dev, over the public proxy**. That default is
not a convenience: as shown above, a container with `HTTPS=on` emits `https://`
asset URLs, so pointing the suite at `http://localhost:4569` gives you 200s with
no CSS and no JavaScript, and every assertion fails for a reason that has
nothing to do with the code. `smoke.spec.js` exists to catch exactly that — it
asserts more than 100 CSS rules parsed and no asset request returning >= 400. If
it fails, the harness is broken; stop and fix the URL before reading any other
failure.

Pointing it at an instance is the whole point of the variable. To review a branch
you build it as `agr-blast:restyle`, redeploy test, and run the suite with
`E2E_BASE_URL=http://172.31.3.193:4570` — the test instance is the only one
without `HTTPS=on`, so it is the only one a plain-HTTP base URL works against,
and the only one you can drive without a certificate. Confirmed working:

```
$ E2E_BASE_URL=http://172.31.3.193:4570 npx playwright test test/e2e/smoke.spec.js
✓ stack smoke: React boots on dev › SGD main page boots React, renders query box
  and database trees (2.1s)
1 passed (2.6s)
```

Workers stay at 2 and `fullyParallel` is off because `:num_jobs: 1` in
`public/configs/sequenceserver.conf` becomes a job pool of one
(`lib/sequenceserver/job.rb:73`), so a container runs one BLAST job at a time
and raising the concurrency just makes specs queue behind each other.

Chrome is the system binary at `/usr/bin/google-chrome` (139.0.7258.127), not a
bundled Chromium — `npx playwright install` is unnecessary here and may fail.

### Jest

```bash
npm test
```

At `73e4a38a`: 7 suites, 34 tests, **2 failing**, in about 11 seconds. The
totals move with whatever spec files a branch adds or deletes — the
`harden-request-handling` branch deletes `cloud_share_modal.spec.js` and so
reports 6 suites and 30 tests — but the two failures are the durable part. They
are pre-existing and unrelated to deployment:

```
FAIL public/js/tests/form.spec.js    PARAMETERS › should render the link to advanced parameters modal…
FAIL public/js/tests/report.spec.js  REPORT PAGE › SIDEBAR › DOWNLOAD LINKS › ALIGNMENT DOWNLOAD › …
                                     TypeError: errCallback is not a function   (public/js/report.js:91)
```

PR #24's commit message records the same two suites failing identically with its
changes stashed, so this is the state of the repository, not a regression. A
clean `npm test` is not currently the bar; "still exactly these two" is.

### RSpec

The suite passes: **362 examples, 0 failures**. It did not until recently, and
the history is worth keeping, because most of the failures were specs that a
fork-wide change left behind rather than anything broken in the app.

**There is no Ruby on the host.** No `ruby`, `gem`, `bundle` or `rspec` on
`PATH`, nothing under `/opt` or `/usr/local`, no ruby RPM installed. The suite
can only be run inside a container.

**The shipped image cannot run it either.** `rspec` is a development dependency
(`sequenceserver.gemspec:36`), the builder stage runs
`bundle install --without=development` (`Dockerfile:18`), and that writes
`BUNDLE_WITHOUT: "development"` into `/usr/local/bundle/config`, which is then
copied into the final stage. The Dockerfile's `dev` target does run a plain
`bundle install` (`Dockerfile:115-117`) but inherits the same config file, so it
installs no development gems either. Unset it and mount the working tree:

```bash
cd /home/ec2-user/gitroot/pull-upstream/agr_sequenceserver
docker run --rm -v "$PWD:/work" -w /work --entrypoint bash agr-blast:effcac18 -c '
  bundle config unset without
  bundle install --quiet
  bundle exec bin/sequenceserver -s -d spec/database/v5/sample
  bundle exec rspec spec
'
# 362 examples, 0 failures
```

The `bin/sequenceserver -s -d spec/database/v5/sample` line is not optional and
is easy to miss. It is a step in the workflow
(`.github/workflows/tests.yml:81-82`) and it writes the config file that gives
`database_dir` to the specs that call `SequenceServer.init` with no arguments.

Note the image must carry **BLAST 2.16.0**. `spec/fixtures`' BLAST archive
reports `BLASTN 2.16.0+`, and report_spec compares that string, so the one
example fails on an older BLAST. The Dockerfile pinned 2.15.0 while CI and
CLAUDE.md both said 2.16.0; that is now 2.16.0 everywhere.

#### What had been failing, and why it went unnoticed

CI had never run on this fork: `tests.yml` triggered on `master`, and the
default branch is `main`, so every event it listened for was one that could not
occur. #32 pointed it at `main` and the first run reported **66 failures**.
Five causes, all fixed:

* `init_database` was dead code. `6e969b2c` removed the call and the method when
  it introduced `/blast/<mod>/<environment>` URLs; an upstream merge
  (`83f1ee87`) brought the body back without the call, and it then sat
  unreachable for a year -- and uncallable, since the body referenced a
  `makeblastdb` reader this fork had moved into routes.rb. Restoring it fixed 27
  examples, because scanning is only half of what it did and validating
  `database_dir` is the other half.
* `routes.rb` hardcoded `/db` as the root beneath the MOD and version segments,
  so `database_dir` was validated and then ignored, and no spec could exercise a
  route. It now takes the root from the config -- the same path, since every
  instance sets `:database_dir: "/db"`.
* `get_sequence` reported a rejected sequence id as 500, because a blanket
  `rescue StandardError` swallowed the 422 that `InvalidSequenceIdError` already
  declares.
* `makeblastdb_spec` had contradicted the code since upstream's `72a7dce3`
  (June 2021) deliberately made non-parse_seqids databases reformattable
  without updating the spec.
* `report_spec` resolved its fixture paths against a checkout named
  `sequenceserver`; this one is `agr_sequenceserver`, so `blast_formatter`
  failed on a database that was not there. Its golden file was also stale in
  five ways, every one of them this fork's own features.

#### What was removed, and what is dormant

`spec/features/` is gone -- 25 Capybara examples driving upstream's flat
checkbox list. Fixing their URLs was not enough: this fork renders databases
with jstree, so `.protein .database` elements are empty and `check "<title>"`
cannot find a visible checkbox, because jstree mirrors hidden inputs. The
Playwright suite in `test/e2e` covers the same ground against the markup this
fork actually serves, and its README documents those pitfalls.

`spec/blast_versions/` is still present and still stale -- ten importers built
on `BLAST::Report.new(job)` with one argument, and fixture ids shaped like
`blast_2.2.30/blastn`. They are inert: none is named `*_spec.rb`, so `rspec`
does not collect them, and they neither pass nor fail. Either port or delete
them; do not assume they are coverage.

## The frontend bundle rule

**If you change any JavaScript or CSS, run `npm run build` and commit the
resulting minified bundles in the same pull request.**

The usual reason given is that the test suite runs in production mode, and that
is true, but it undersells it. The pages only ever reference the minified files
— `views/search.erb:17` loads `sequenceserver-search.min.js` and
`views/report.erb:5` loads `sequenceserver-report.min.js`, with no
development-mode alternative anywhere, in any mode — and the default Docker
target copies the repository in verbatim and never runs webpack. So the
committed bundle is literally what every instance serves. Confirmed: all four
assets in `agr-blast:73e4a38a` are byte-identical to what is committed at
`73e4a38a`.

```bash
docker run --rm --entrypoint sh agr-blast:73e4a38a \
  -c 'cd /sequenceserver/public && md5sum sequenceserver-*.min.js css/app.min.css css/sequenceserver.min.css'
for f in sequenceserver-report.min.js sequenceserver-search.min.js \
         css/app.min.css css/sequenceserver.min.css; do
  git show 73e4a38a:public/$f | md5sum
done
# both print, in this order:
# a9d150b093327f10b513fa033bdecb52  sequenceserver-report.min.js
# 848136a70005574380212f8703a08739  sequenceserver-search.min.js
# 5897a982abe129ce7077ac760f65f5a2  css/app.min.css
# 7aa15e05c2c62660cac826de30e9083b  css/sequenceserver.min.css
```

Compare against the working tree's files instead of `git show`'s and three of
the four differ, because the checkout is on a branch whose bundles have been
rebuilt. The comparison only means anything when both sides name the same
commit.

Building with `--target=minify` does not get you out of this. It regenerates
the two `.min.js` files inside the image but not `app.min.css`, so the CSS
still comes from the repository either way, and the JavaScript either comes
from the repository or from a rebuild that had better match it.

So an uncommitted bundle is not a test-environment detail — the deployed site
serves the old code, in every mode, on every instance, and nothing anywhere
reports a mismatch. The workflow step that would have caught it
(`.github/workflows/tests.yml:60-68`, "Check assets were compiled and
checked-in", which exits 1 if `git diff -- public` is dirty after
`npm run build`) has never run, for the `master`/`main` reason above — and would
not fail the build even if it did, because it carries `continue-on-error: true`
and the final gate (`tests.yml:110-112`) looks only at the rspec and jest step
outcomes. This is enforced by hand or not at all.

```bash
npm run build          # webpack --mode production && tailwindcss --minify
git add public/sequenceserver-*.min.js public/css/app.min.css
```

## prod is fifteen merged pull requests behind

Prod runs `agr-blast:fda1db1f`, PR #23, merged 2026-09-29. `main` is
`effcac18`, PR #40, merged 2026-10-08. `git log --oneline fda1db1f..effcac18`
is fifteen commits, one per pull request:

```
effcac18  Keep genome browser links working when a database prefixes its ids (#40)
97d53cd5  Say when a result is incomplete, instead of guessing why (#39)
d92e0086  Name the organism a hit came from (#38)
51798959  Join the TSV to the XML by position, not by subject id (#37)
70f2006b  Make the ALLIANCE tests able to fail (#36)
c4441c47  Document the system, the deployment and the audit (#35)
a7fcccde  Let CI reach the tests (#32)
b435058e  Stop trusting request input that becomes a filesystem path (#31)
73e4a38a  Show a gene symbol as its database spells it (#30)
b2f4a6ad  Stop one database filling the gene search list, and say what the box matches (#29)
6f1dd06d  Say "Find a gene", then "or", then the paste box (#28)
91726df5  Make the gene search box findable: prefix search, a usable example, more room (#27)
80948cc8  Gene symbol search box, and remove cloud sharing (#26)
791919b0  Draw the database tree checkboxes instead of using jstree's sprite (#25)
b9d9de72  Alliance chrome, SGD fungal and FlyBase linkouts, and a concurrency fix (#24)
```

Count the history, not the notes. `docs/ARCHITECTURE.md` and the capture notes
this file was first written from say "four merged PRs behind"; it was seven when
this section was written and fifteen now, and the bundle md5 above pins prod to
`fda1db1f` exactly, so the `git log` range is the number that can be trusted.

The eight PRs added since this section was first written change what the gap
costs. #31 is four request-handling defects where request input became a
filesystem path, all of them live on prod right now. #37 fixes a join that
attributed the wrong organism and coverage figures to hits, #38 and #39 make
what a result is and is not explicit, and #40 keeps genome browser links
working for the databases that now prefix their sequence ids — which prod's
config volume already carries (all thirteen `seqid_prefix` values are deployed
in `/var/sequenceserver-data/config`), so prod is serving prefixed databases
with code that does not know to strip the prefix.

Most of that gap is visible to a visitor. The gene search box does not exist at
all — `GET /blast/:mod/:version/gene_search` returns 404 on 4568 and 200 on
4569 and 4570, so PRs #26 through #30 are simply missing. The Alliance chrome,
nav and footer are absent, and so is the drawn database-tree checkbox. And prod
carries the concurrency bug fixed by PR #24: the search POST did not load its
own databases, and `Database.collection` was one process-wide Hash, so a
WormBase search validating just after an SGD request matched none of its own
database ids and was rejected with HTTP 400 "Database id should be one of …".
Two people searching two different MODs at the same moment can break each
other's searches. Main's fix is both halves — `handle_blast_request` now scans
first (`lib/sequenceserver/routes.rb:238-247`: a seven-line comment explaining
why, then the three lines that do it at :245-247) and the collection is thread-local
(`lib/sequenceserver/database.rb:150-167`).

The HTTP smoke suite measures the gap directly:

```
bash test/manual/smoke-test.sh http://localhost:4569     # 50 passed, 0 failed     (dev)
bash test/manual/smoke-test.sh http://localhost:4568     # 47-48 passed, 2-3 failed (prod)
```

Two of prod's failures are deterministic: "SGD fungal defline handling" and
"MOD gene linkout". The third, "concurrent searches rejected each other",
appears on most runs but not all — three consecutive runs gave 47/3, 47/3, 48/2
— because it only reproduces the request-scoped-database bug when two MODs'
requests actually interleave inside the window. An occasional 48/2 is not prod
being fixed.

**Closing this gap needs an image rebuild and a job rescue, and nothing else.**
The data is shared: prod mounts the same `/var/sequenceserver-data/blast`, so
every `*.names.json` and `*.names.display.json` index the gene search box needs
is already on disk and already being read by dev. Prod serves the same 200
FlyBase FB2026_03 databases that dev and test do. The config is shared too, in
content if not in path: `diff -rq /var/sequenceserver-data/config
/var/sequenceserver-data/config-dev` is currently empty, so no config promotion
is owed before this deploy — but check it rather than assume, because the two
are separate directories that drift (see the `CONFIG_DEPLOY_ROOT` note under
"The config volume split").

What is *not* free is the job history, because it lives in the container. Run
the prod block under "Rebuilding and redeploying an instance" above **including
its `docker cp` step**, then the job-id curl, the two curl checks and the smoke
suite against `http://localhost:4568`, and expect 50/0.

Build the image ahead of time and the deploy window is only as long as a
container restart: `agr-blast:effcac18` is already built, and is the same image
id as `agr-blast:restyle`, so the test instance on 4570 has been exercising
exactly this code.

## The hazard that will take a MOD offline: `copy_to_production`

`copy_to_production` in the manager removes its destination before copying into
it (`agr_blastdb_manager/src/utils.py:57-128`). Read it before you run a build:

```python
dest_path = Path(f"/var/sequenceserver-data/blast/{mod}/{environment}/databases")
...
if dest_path.exists():
    shutil.rmtree(dest_path)          # utils.py:124
shutil.copytree(source_path, dest_path)   # utils.py:128
```

The granularity is the whole `databases` directory of one MOD/release, not one
database. `create_blast_db.py:1105-1193` builds the copy queue from
`../data/blast`, but only for the `(mod, environment)` pairs this run actually
processed (`PROCESSED_DATABASES`, `create_blast_db.py:1126`) — so the blast
radius is exactly the releases you asked it to build, and a release you did not
name is untouched. It prints a dry run of each queued copy and then performs
them unconditionally. No flag lets you build and withhold the publish: the
publish block is guarded only by `if not check_parse_seqids:`
(`create_blast_db.py:1106`), and `-c/--check-parse-seqids`
(`create_blast_db.py:986-992`) is a check-only mode that does not build either —
it gates the Slack, validate and S3 steps the same way (`:1098`, `:1211`,
`:1274`). Once a build runs, the copy runs. The destination is hard-coded, with
no override; contrast `CONFIG_DEPLOY_ROOT` (`utils.py:151`), where the config half of the
same operation does take an `AGR_CONFIG_ROOT` environment variable.

Two consequences.

**The release is offline for the duration of the copy.** Every route that
touches a database goes through `database_dir_for`
(`lib/sequenceserver/routes.rb:646-653`), and its only existence check is
`File.directory?('/db/:mod/:version/databases')` — the exact path `rmtree`
deletes. So between the `rmtree` and the `copytree` recreating it, the search
page and `searchdata.json` for that release both return a bare 404, the same
way a release that was never published does:

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4569/blast/FB/FB9999_99/
404
```

`/var/sequenceserver-data/blast/FB/FB2026_03/databases` is 8.5 GB, so that
window is however long it takes to delete and re-copy 8.5 GB on this
filesystem. It was not timed, and timing it on the live volume is not worth the
outage.

**Worse, the copy restores only what is in the staging tree, so an incomplete
staging tree silently deletes live databases.** The staging tree persists
between runs and is not required to match what is live. It does not match right
now:

```bash
STAGE=/home/ec2-user/gitroot/agr_blastdb_manager/data/blast/FB/FB2026_03/databases
LIVE=/var/sequenceserver-data/blast/FB/FB2026_03/databases

diff <(find "$STAGE" \( -name '*.nin' -o -name '*.pin' \) -printf '%P\n' | sort) \
     <(find "$LIVE"  \( -name '*.nin' -o -name '*.pin' \) -printf '%P\n' | sort)
```

199 index files staged against 200 live, and the diff names the one that is
only live:

```
96a97
> Drosophila/melanogaster/D_melanogaster_Transcripts_6_69/dmel-transcriptdb.nin
```

Running the manager on FB/FB2026_03 today would therefore delete the live
directory and restore 199 of its 200 databases, dropping
`D_melanogaster_Transcripts_6_69` — the exact database whose earlier
disappearance curators reported as "the option to search annotated transcripts
has disappeared". It is live on all three instances today, and that diff is the
only thing standing between it and a second disappearance:

```bash
for p in 4568 4569 4570; do
  curl -s "http://localhost:$p/blast/FB/FB2026_03/searchdata.json" |
  python3 -c 'import sys,json; d=json.load(sys.stdin)["database"];
print(len(d), [x["title"] for x in d if "ranscript" in x["title"]])'
done
# 200 ['D_melanogaster_Transcripts_6_69']     (all three)
```

Note also that `../data/blast` is relative to the *working directory*, so both
the build output and the publish source follow wherever you launched
`create_blast_db.py` from. Runs have been made from `src/`, which is why
`agr_blastdb_manager/data/blast` is the populated tree and
`/home/ec2-user/gitroot/data` is empty. Launching from the repository root
instead does not make the publish safe; it just points the whole operation at a
different, emptier staging tree.

**So: build to a staging directory and install one directory.** Before any run
that touches a release which is live, compare the staging tree against the live
one file by file, and only let the manager publish when the staging tree is a
superset. For a single new or rebuilt database, do not invoke the publish step
at all — copy that one database's directory into place yourself:

```bash
cp -a /home/ec2-user/gitroot/agr_blastdb_manager/data/blast/FB/FB2026_03/databases/Drosophila/melanogaster/<db_dir> \
      /var/sequenceserver-data/blast/FB/FB2026_03/databases/Drosophila/melanogaster/
```

A new directory appears to the server on the next request, with no deploy and
no window in which anything is missing, because the server discovers databases
by scanning. That asymmetry is the point: adding is safe and instant,
whole-directory replacement is neither.

## What this file does not cover

The other side of the shared volume — how a release is declared, built and
indexed — is `docs/ALLIANCE_BLAST_OVERVIEW.md` and
`agr_blastdb_manager/docs/PIPELINE.md`. How the app serves it is
`docs/ARCHITECTURE.md`, and the gene search box that prod is missing is
`docs/GENE_SEARCH.md`. The outstanding data defects (ALLIANCE/prod serving one
database instead of its full set; ZFIN GRCz11 built without `-parse_seqids`;
ZFIN and RGD deflines carrying no gene symbols, so gene search cannot answer for
them) are in `docs/ALLIANCE_WIDE_PLAN.md` and
`agr_blastdb_manager/docs/alliance_2024_build_failure.md`.

Two things are left explicitly unverified: whether a host reboot restores prod,
given `docker.service` is disabled, and whether the 41 non-fork RSpec failures
are genuine.

On disk headroom, since everything above shares one filesystem. Read it with
`df -h /` and `docker system df` rather than trusting a figure here — every
build moves it. On 2026-10-02: `/` is 250 GB with 80 GB free,
`/var/sequenceserver-data/blast` accounts for 82 GB of the 171 GB used, and
`docker system df` reports 47 images totalling 16.68 GB of which 16.54 GB (99%)
is reclaimable, plus 415.2 MB of build cache. An 8.5 GB `copytree` of FB2026_03
fits comfortably today; a few more releases, or a few more `agr-blast:<sha>`
tags, and it will not. `docker image prune` is the cheap lever, and the only
tags worth keeping are the ones a container is using plus the previous prod tag
to roll back to; the build cache is separate and needs `docker builder prune`,
which `docker image prune` will not touch. There is also a stale container `sstest`, created 2025-08-18 from
an image `agr-seqserv-test` and never started.
