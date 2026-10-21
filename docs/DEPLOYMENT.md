# Running the three BLAST instances

Everything below was read off the host on 2026-10-02, and the figures were
re-read on 2026-10-16. None of it was written down anywhere before this file,
which is the main reason it exists.

**State on 2026-10-16.** All three instances run `agr-blast:72efdceb`, `main`
after the Phase 3 merges (#56, #57, #58). Production holds 3,053 job
directories in `/var/sequenceserver-data/jobs-prod`, a bind mount, so a
redeploy no longer risks them. `:job_lifetime` is 129,600, which is minutes,
so 90 days. The local registry holds two `agr-blast` tags, `72efdceb` and
`6772fbc8` to roll back to, and no `agr-blast-prod-pre-*` containers; the
numbers in this file that counted 19 tags or 47 images are from before the
2026-10-15 cleanup.

The topology is three `docker run` invocations and two nginx `server` blocks.
The invocations survive nowhere but in the containers themselves — the shell
histories hold only an older form of the prod one, against a differently-named
image — so the commands here were reconstructed from `docker inspect`. The
nginx blocks do not route the way the hostnames suggest, and that part has cost
people time.

Line numbers below are against `main`, and `main` is what every instance runs.
The working copy on this host is routinely parked on a feature branch, and a
branch's bundles are not the ones any instance serves, so `md5sum public/...`
in the working tree will not reproduce the figures here while
`git show main:public/...` will.

Measured figures are dated where they appear, because several were taken at
`73e4a38a` before #31 merged. The one that matters most is the asset digest
used below as a fingerprint: dev moved from `279b24bc…` to `d2a25f6a…` when it
was rebuilt onto `b435058e`. Read a digest off the instance rather than
trusting one written down here.

Nothing here is automated. There is no CI deploy, no orchestration, no image
registry, and no image is pushed anywhere — the tags below exist only in this
host's local Docker. `deploy.sh` in the repository root looks like the deploy
script and is not: it builds an image called `agr-blast-prod-container`, and the
container actually serving production runs `agr-blast:72efdceb`. Running it
would redeploy prod from an untagged image and lose the one record of which
commit is live, so treat it as historical. That image was deleted on
2026-10-15 and the script would rebuild it, which is one more reason not to run
it. `monitor.sh` beside it is harmless —
an interactive menu of `docker logs`, `restart`, `stop`, `exec` against
`agr-blast-prod` — but it only knows about prod. The same goes for
`docker-compose.yaml`, which describes four per-MOD services on ports 5001-5004;
none of the three running containers carries a `com.docker.compose.*` label, so
nothing on this host was started from it.

## The three instances

| | test | dev | prod |
|---|---|---|---|
| container | `agr-blast-restyle` | `agr-blast-dev` | `agr-blast-prod` |
| image | `agr-blast:72efdceb` | `agr-blast:72efdceb` | `agr-blast:72efdceb` |
| host port | 4570 | 4569 | 4568 |
| reached at | `http://172.31.3.193:4570` | `https://blast-dev.alliancegenome.org` | `https://blast.alliancegenome.org` |
| `public/environments` from | `/var/sequenceserver-data/config-dev` | `/var/sequenceserver-data/config-dev` | `/var/sequenceserver-data/config` |
| `/root/.sequenceserver` from | the container | the container | `/var/sequenceserver-data/jobs-prod` |
| `HTTPS` | unset | `on` | `on` |
| restart policy | `no` | `no` | `unless-stopped` |

The three rows after `image` used to sit below two paragraphs of prose, which
broke the table in every renderer; they are part of it again.

All three run `72efdceb`, `main` after the Phase 3 merges. The three releases
before it were `8c8bcba4` on 2026-10-11, which closed a gap of 17 merged pull
requests open since 2026-09-29, then `941e2440`, `6772fbc8` and this one. Read
the image off the container rather than trusting a tag written here: four tags
in this file went stale inside a week.

The config volumes are in step as well: `config` was promoted from `config-dev`
during the 2026-10-11 release, so the split described below is currently latent
again. Only `environment_info.json` differs by intent, and it does not: the
ALLIANCE entry added on 2026-10-15 went into both.

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
href="http://localhost:4570/blast/css/app.min.css?v=<digest of the built asset>"
```

The first of those — any `HTTPS=on` container reached over plain HTTP — is a
page that returns HTTP 200 with valid HTML and then loads zero CSS and zero
JavaScript, because nothing serves `https://localhost:4568`. React never boots
and nothing on the page works, while a status-code check passes. That is the
one constraint the browser suite documents at length (`test/e2e/README.md`):
never point Playwright at `http://localhost:4569` either.

Note incidentally that the `?v=` value is the first 12 hex digits of the
SHA-256 of the asset file (`lib/sequenceserver/routes.rb:903-921`, `asset_version`), so it is a
reliable fingerprint of which bundle a given container is serving. All three
instances serve `main` at `72efdceb`, so all three answer the same digest;
before the 2026-10-11 release production answered `651d65fe…`, its
`app.min.css` as committed at `fda1db1f`, and dev `d2a25f6a…` at
`b435058e` (and `279b24bc…` at `73e4a38a`, which is the kind of drift that
makes this a useful check rather than a constant). No digest is quoted for the
current build on purpose: it changes with every frontend merge, and a value
written here goes stale faster than anyone rereads it.
`sha256sum public/css/app.min.css | cut -c1-12` in the tree you built from is
the other half of the check, and the two agreeing is how you confirm an
instance is running the commit you think it is.

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

Images are tagged with the 8-character `agr_sequenceserver` `main` commit they
were built from: `git rev-parse --short=8 HEAD`. That is the whole convention,
and it is the only record of what is deployed. All three instances carry a
commit tag now; the floating `agr-blast:restyle` tag that test used to run is
gone, and the procedure below builds one image for all three. Use a floating
tag only for a branch that is not on `main`, and check the image id or the
asset fingerprint rather than the tag when you do.

You can check a tag rather than trust it. The bundle inside the image matches
the one committed at that commit, so:

```bash
docker run --rm --entrypoint sh agr-blast:72efdceb \
  -c 'md5sum /sequenceserver/public/sequenceserver-search.min.js'
# 0db2c206137697a6e89a2bb394b52ab4

git show 72efdceb:public/sequenceserver-search.min.js | md5sum
# 0db2c206137697a6e89a2bb394b52ab4
```

Worth running in the other direction too, before the build: `npm run build` on
a clean `main` must leave `git status` clean. If it does not, the committed
bundles are not the source's, and the image will carry whichever the build
produced rather than what was reviewed.

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

**Production runs `agr-blast:72efdceb`, released 2026-10-15.** The steps below
are a record of what was run as much as instructions for next time. Check any
tag written here against `git rev-parse --short=8 main`: four went stale inside
a week while these releases were being prepared.

The last release, in order, and what it measured:

| step | result |
|---|---|
| `npm run build` on clean `main` | all three bundles byte-identical to what is committed |
| `docker build -t agr-blast:72efdceb` | 1.76 GB, two bundles md5-matched against the repo |
| recreate test and dev | up in 5 s |
| `test/manual/smoke-test.sh` on 4570 | 57 passed, 0 failed |
| `npx playwright test` on 4570 | 111 passed |
| baseline a prod job URL | HTTP 200, 3,041 job directories |
| `docker stop` and rename to `agr-blast-prod-pre-72efdceb` | kept for rollback |
| recreate prod on `72efdceb` | up in 5 s |
| the same job URL, and the count | HTTP 200, 3,041 unchanged |
| `test/manual/smoke-test.sh` on 4568 | 57 passed, 0 failed |

The job rescue two releases ago is the step that needs no repeating. New jobs
land in `/var/sequenceserver-data/jobs-prod`, which the container mounts, so
the writable layer holds none. Verified before the 2026-10-15 cleanup:
`docker diff` on all six parked `agr-blast-prod-pre-*` containers reported zero
changes each, so none of them was holding a job anyone could still reach.

**`:job_lifetime` is 129,600, and the unit is minutes.** `job_remover.rb:16`
multiplies by 60, so that is 90 days, raised from 43,200 (30 days) in #55. A
result URL someone shared survives a redeploy and three months, not the 12
hours an earlier version of this file claimed.

**Promote the config in the same window.** Production reads
`/var/sequenceserver-data/config`, which is behind `config-dev` twice over: its
ALLIANCE entries still name the assemblies retired on 2026-10-09, so they match
none of the rebuilt databases, and it lacks the six WB WS298 `ref_name` entries
deployed on 2026-10-11. The deploy is therefore two copies, not one:

```bash
cp -a /var/sequenceserver-data/config-dev/. /var/sequenceserver-data/config/
```

Measured on this image against the real database tree, with one cross-species
search of 152 hits:

| config | links | correct refName | wrong |
|---|---|---|---|
| production's current config | 6 | 6 | 0 |
| after the copy above | 152 | 152 | 0 |

So forgetting the copy costs 146 links and breaks nothing. Doing the copy
without the new image is the combination to avoid: the older code ignores
`ref_name` and answers `Chr1` for rat, which GRCr8 does not contain.

**The job rescue is historical, and the reason is worth keeping.** Before the
`jobs-prod` bind mount existed, prod kept its jobs in `/root/.sequenceserver`
*inside the container's writable layer*, so the `docker rm -f` that the
documented procedure opened with deleted every one of them. Each is a result
URL someone may have shared; there were 1,841 of them, 3.6 GB, by the release
that rescued them. The rescue was:

```bash
# Point-in-time copy, so it had to run IMMEDIATELY before the swap -- anything
# submitted after it ran and before the container stopped was lost.
mkdir -p /var/sequenceserver-data/jobs-prod
docker cp agr-blast-prod:/root/.sequenceserver/. /var/sequenceserver-data/jobs-prod/

# Must match, and must not be zero.
docker exec agr-blast-prod sh -c 'find /root/.sequenceserver -name job.yaml | wc -l'
find /var/sequenceserver-data/jobs-prod -name job.yaml | wc -l
```

Run it only against a prod container that has no `jobs-prod` mount, which
`docker inspect` will tell you. Against the current one it copies the mount
onto itself.

Record a job id and the directory count anyway, as a before-and-after on the
redeploy rather than a rescue:

```bash
JID=$(sudo ls -t /var/sequenceserver-data/jobs-prod | head -1)
sudo ls /var/sequenceserver-data/jobs-prod | wc -l
```

Then recreate, with that directory mounted:

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

Same image as dev and prod, and with **no** `HTTPS` variable so the page is
usable over `http://172.31.3.193:4570`. That absence is what makes test the
only instance the browser suite can be pointed at:

```bash
docker rm -f agr-blast-restyle
docker run -d --name agr-blast-restyle \
  -p 4570:4567 \
  -v /var/sequenceserver-data/blast:/db \
  -v /var/sequenceserver-data/config-dev:/sequenceserver/public/environments \
  agr-blast:$TAG \
  sequenceserver -c /sequenceserver/public/configs/sequenceserver.conf
```

For a branch that is not on `main`, build it under a name that cannot be
mistaken for a release tag and deploy only test from it:

```bash
git checkout <branch>
docker build . -t agr-blast:branch-<name>
```

**A `docker cp` of a bundle into a running test container shortens the loop and
costs you the tag.** It works, and the instance is then ahead of its own
image, so the next person to read the tag is told something false. It was done
several times while the Phase 3 branches were under review, and the fix each
time was to rebuild and recreate before trusting any measurement. If you do
it, say so, and rebuild before the instance is handed to anyone else.

Those three `docker run` lines were reconstructed from `docker inspect` of the
containers running now, not copied from a script, because no script produces
them.

The tag is only as honest as the working tree. `docker build` sends the working
tree, not the commit, so building with a dirty tree produces an image tagged
with a commit it does not contain — and since the tag is the only record of what
is deployed, that is a lie you cannot detect later. Check `git status` before
building for dev or prod, and name a branch build `agr-blast:branch-<name>`
rather than giving it a commit tag it does not contain.

`NODE_ENV=production` on prod is inherited from `deploy.sh` and does nothing at
runtime: nothing under `lib/`, `views/` or `config.ru` reads it, the only
reference anywhere is `public/js/sidebar.js:10`, and that is resolved when
webpack runs, which is not in a running container. It is listed anyway because
it is what prod actually has, and a redeploy that silently drops an environment
variable is the kind of difference nobody later believes was accidental.

A redeploy of **test or dev** loses that container's job history, and only
prod is spared. Their finished jobs live inside the container at
`/root/.sequenceserver`, not on the shared volume, so every result URL anyone
holds against test or dev stops resolving when it is recreated. Prod mounts
`/var/sequenceserver-data/jobs-prod` there instead. `:job_lifetime` is 129,600
minutes, 90 days (`public/configs/sequenceserver.conf`), so on prod a shared
URL now outlives both the deploy and the quarter.

Rolling back is the same `docker run` with the previous tag, and it works only
as long as that image is still on the host. **Keep exactly one predecessor
tag, and keep it until the release after next replaces it.** The alternative
was 19 of them, and clearing that surplus took `docker system df` from
12.38 GB to 5.04 GB; the alternative in the other direction is a rollback that
needs a build first.

One wrinkle, which cost three releases to notice. A docs-only release produces
a **byte-identical image**: `.dockerignore` excludes `docs/`, `test/` and
`CLAUDE.md`, so `docker build` reuses every layer and the new tag lands on the
same image id. `72efdceb`, `aa62a2bf` and `021cd840` were all
`9e795864e9a1`. A predecessor tag pointing at the same id as the running one
is not a rollback target, so the tag worth keeping is the last one whose image
id **differs** from the current one.

```bash
# What a predecessor tag is actually worth: compare ids, not names.
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^agr-blast:'
```

**There is no rollback image on the host as of 2026-10-21.** Only
`agr-blast:021cd840`, which all three instances run. The three tags before it
were the same image id and were untagged; the last genuinely different one,
`6772fbc8`, was deleted on 2026-10-15. Nothing was rebuilt to fill the gap, so
the policy starts at the next release: keep `021cd840` when it is displaced.
Until then a rollback means `git checkout <sha> && docker build`, a few
minutes rather than a container swap.

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
bash test/manual/smoke-test.sh http://172.31.3.193:4570  # 59 passed, 0 failed
E2E_BASE_URL=http://172.31.3.193:4570 npx playwright test  # 111 passed (8.1m)
```

The browser figure is from the 2026-10-15 release against test. The smoke
suite grew from 50 to 59 as checks were added for the ALLIANCE deployment and
its manifest entry, then for SGD's two releases; the browser suite from 83 to
111.

Four of the 59 read `environment_info.json`, which is hand-maintained on the
config volume and in no repository, so a test is the only thing that notices
when it drifts. Two of the four exist because it had drifted: the fungal entry
named the main set's release and date, copied from the row above it.

The browser suite asserts on UI copy, so "111 passed" holds only when the spec
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

`npx playwright test --list` reports **111 tests in 14 files** as of
2026-10-16, against 85 static `test(` blocks; the gap is data-driven specs,
where `cross_mod.spec.js`'s 5 declarations list as 17 tests.
`test/e2e/README.md:88` still says 64 tests with one known failure, and both
halves of that are stale. The known failure — SGD fungal offering examples for
databases the fungal release does not have — is fixed: `examplesForCurrentMod`
filters the offered examples against the databases the deployment actually
returned (`public/js/examples.js:95-104`).

Three of the 14 files are slow enough to notice, because they run real BLAST
jobs: `alliance_species.spec.js` takes 6.2 minutes and `organism_filter.spec.js`
about 3. A nine-genome `tblastn` for human ACTB takes **4m56** on this host,
past the suite's 180s BLAST timeout, which is why no spec runs one; the
per-organism distribution over all nine is measured through the JSON API
instead and recorded in `docs/ALLIANCE_WIDE_PLAN.md`.

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
you build it as `agr-blast:branch-<name>`, redeploy test, and run the suite with
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

At `72efdceb`: 7 suites, 38 tests, **1 failing**, in about 11 seconds. The
totals move with whatever spec files a branch adds or deletes, but the one
failure is the durable part, and it is a node version difference rather than a
defect:

```
FAIL public/js/tests/report.spec.js  REPORT PAGE › SIDEBAR › DOWNLOAD LINKS › ALIGNMENT DOWNLOAD › …
```

**It passes on CI and fails here.** CI runs node 22, this host has node 18, so
a local `npm test` shows one failure the pull request does not. The bar locally
is "still exactly this one"; the bar on CI is zero.

The `form.spec.js` failure this file used to pair it with is fixed, as is the
behaviour behind it: the advanced-parameters link is not offered until an
algorithm is known, which `test/e2e/advanced_options.spec.js` now asserts in a
browser as well.

### RSpec

The suite passes: **376 examples, 0 failures**, measured at `72efdceb` in
`agr-blast:6772fbc8`. It did not until recently, and the history is worth
keeping, because most of the failures were specs that a fork-wide change left
behind rather than anything broken in the app.

214 of the 376 come from `spec/blast_versions`; see "`spec/blast_versions/` is
live coverage" below before excluding it.

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
docker run --rm -v "$PWD:/work" -w /work --entrypoint bash agr-blast:72efdceb -c '
  bundle config unset without
  bundle install --quiet
  bundle exec bin/sequenceserver -s -d spec/database/v5/sample
  bundle exec rspec spec
'
# 376 examples, 0 failures
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

`spec/blast_versions/` is live coverage, and an earlier version of this note
said the opposite. It claimed none of its files is named `*_spec.rb` and that
the directory is inert. Both were wrong. Each of the ten release directories
holds a `blast_<version>_spec.rb` alongside the importer, those ten are
collected, and they contribute **214 of the suite's 376 examples**, all
passing. They read the same report fixtures through nine BLAST releases from
2.2.30 to 2.9.0 plus DIAMOND 0.9.24, by the nested fixture ids
`blast_2.9.0/blastn` that `Job.valid_id?` exists to permit. Exclude them and
you lose 57% of the suite.

What was genuinely dead, and is now deleted, is the other file in each
directory: `import_spec_capybara_local_<version>.rb`, 5,499 lines across ten
files. Those were Capybara feature specs, `type: :feature, js: true`, and
`rspec` never collected them, their names not ending in `_spec.rb`. They
navigated with `visit "/#{url}"`, the upstream root-level job URL this fork
replaced with `/blast/:mod/:version/:jid` in November 2023, so they could not
have passed here either. They went the same way as `spec/features`, and for the
same reason.

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

## the gap production used to carry, closed 2026-10-11

Production ran `agr-blast:fda1db1f`, PR #23, merged 2026-09-29, until the
release on 2026-10-11 moved it to `8c8bcba4`. `git log --oneline
fda1db1f..main` was 22 commits by then, and the fifteen below are what the gap
looked like when this section was written, at `effcac18` on 2026-10-08. The
section is kept because what the gap cost is the useful part, and because the
counting mistake in it is worth not repeating:

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
# Measured while the gap was open. Both answer 57 of 57 now, and the suite has
# grown from 50 checks to 57.
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
container restart. Deploy the same image to test first and run the suites
there, which is how every release since has been done: the test instance on
4570 is then exercising exactly the code prod is about to run.

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
`docs/ARCHITECTURE.md`, and the gene search box is `docs/GENE_SEARCH.md`. The
outstanding data defects are in `docs/ALLIANCE_WIDE_PLAN.md` and
`agr_blastdb_manager/docs/alliance_2024_build_failure.md`. Two of the ones
this section used to list are closed: ALLIANCE serves all nine of its declared
genomes since #63, and ZFIN's zebrafish is built on GRCz12tu. Still open and
not ours to fix: ZFIN and RGD deflines carry no gene symbols, so gene search
cannot answer for them, ZFIN ships no protein databases, and three ZFIN URIs
404.

One thing is left explicitly unverified: whether a host reboot restores prod,
given `docker.service` is disabled. The 41 non-fork RSpec failures this
section also listed are resolved; the suite is 376 of 376.

On disk headroom, since everything above shares one filesystem. Read it with
`df -h /` and `docker system df` rather than trusting a figure here — every
build moves it. On 2026-10-16, after the cleanup: `/` is 250 GB with 74 GB
free, `/var/sequenceserver-data/blast` accounts for most of the 177 GB used,
and `docker system df` reports 5 images totalling 5.04 GB, 3 containers and an
empty build cache. On 2026-10-02 the same command reported 47 images and
16.68 GB, of which 99% was reclaimable.

An 8.5 GB `copytree` of FB2026_03 fits today; a few more releases and it will
not. `docker image prune` is the cheap lever, and the only tags worth keeping
are the one each container is using plus one predecessor whose image id
differs from it, per the rollback policy above. The build cache is separate
and needs `docker builder prune`, which `docker image prune` will not touch.

Two tags at 1.76 GB each is not two images' worth of disk: they share every
layer but the last, so a second `agr-blast` tag costs far less than
`docker images` suggests. That is why one predecessor is cheap and nineteen
were not.

A parked `agr-blast-prod-pre-<tag>` container is free to delete once the new
one is trusted, but check it first: before the `jobs-prod` bind mount existed,
such a container held the only copy of its job history. `docker diff
<container>` reporting zero changes is the proof that it holds nothing, and
that is what all six were on 2026-10-15.

Deleting the parked container is not the same decision as deleting its
**image tag**. The container is a convenience, since a rollback can start from
`docker run` with the tag; the tag is the rollback itself. So the cleanup after
a release is: delete the parked container once the new one is trusted, and
delete only the tag that the predecessor policy has displaced.
