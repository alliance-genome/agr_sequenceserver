// Cross-MOD regression suite.
//
// Every MOD/version pair the fork deploys is served by the SAME Sinatra app and
// the SAME two webpack bundles, but each gets its own database set, its own
// branding, its own environment.json and its own example sequences. So the
// interesting failures are not "does /blast/XX/ return 200" -- test/manual/smoke-test.sh
// already answers that in 35 HTTP checks, and this file deliberately does not
// repeat it -- but "does the page a browser actually renders for THIS MOD work".
// That is what is covered here:
//
//   * React boots (the query textarea exists and the jstree widgets rendered).
//     A page that served fine but whose CSS/JS never loaded fails here, which is
//     the single most valuable thing a browser test adds over curl.
//   * The database list is populated AND correctly typed. A MOD whose databases
//     fail to load renders an empty tree while still returning HTTP 200.
//   * Nothing throws and nothing 4xx/5xxs while the page comes up.
//   * The MOD's own branding rendered -- each deployment must show its own name,
//     its own data version and its own logo, not another MOD's.
//   * WormBase hits carry NO "NCBI:" linkout. WormBase accessions (F11C3.3,
//     CE09349, WBGene...) are not NCBI accessions; a loosened regex in
//     Links.ncbi_link would put a dead link on every WormBase hit.
//
// Shapes below were read off the live dev deployment on 2026-09-24.

const {
    gotoSearch, clickExample, databaseTitles, runBlast, selectDatabaseByTitle,
    checkedDatabaseTitles, S
} = require('./helpers/app');
const { test, expect } = require('@playwright/test');

// A PLAIN, string-only view of the selectors used inside page.evaluate.
// S itself carries helper FUNCTIONS (hitById, databaseCheckboxOfType) and
// Playwright refuses to serialise those into the page ("Attempting to serialize
// unexpected value"), so never hand S to evaluate wholesale.
const E = {
    header: S.header,
    memberLogo: S.memberLogo,
    anyTree: S.anyTree,
    treeAnchor: S.treeAnchor,
    treeHintText: S.treeHintText,
    databaseCheckbox: S.databaseCheckbox,
    databaseLabel: S.databaseLabel
};

// Third-party hosts whose failures say nothing about this app. Google Analytics
// fires on every page load and is regularly blocked/aborted at the network edge.
const THIRD_PARTY = /(google-analytics|googletagmanager|doubleclick)\./;

/**
 * Every deployment under test, with what its page is required to show.
 *
 * databaseFloor is a deliberately loose lower bound on the number of databases:
 * the exact counts observed on 2026-09-24 were WB 63, FB 199, SGD main 183,
 * SGD fungal 312, RGD 9, ZFIN 9, ALLIANCE 1. Floors sit well under those so that
 * a routine data release does not turn the suite red, but far enough above zero
 * that a MOD whose databases failed to load is caught.
 */
const MODS = [
    {
        label: 'WormBase',
        path: '/blast/WB/WS298/',
        heading: 'Alliance WormBase BLAST',
        dataVersion: 'WS298',
        trees: ['nucleotide_database_tree', 'protein_database_tree'],
        databaseFloor: 50,
        hasProtein: true,
        // Database titles the MOD's own "Try an example" entries target. The
        // examples feature matches databases BY TITLE, so a title that stops
        // existing here silently breaks the example button.
        exampleDatabases: ['C_elegans_Protein_Sequences']
    },
    {
        label: 'FlyBase',
        path: '/blast/FB/FB2026_03/',
        heading: 'Alliance FlyBase BLAST',
        dataVersion: 'FB2026_03',
        trees: ['nucleotide_database_tree', 'protein_database_tree'],
        databaseFloor: 150,
        hasProtein: true,
        exampleDatabases: ['D_melanogaster_Proteins_6_69']
    },
    {
        label: 'SGD (main)',
        path: '/blast/SGD/R64-5-1m/',
        heading: 'Alliance SGD BLAST',
        dataVersion: 'R64-5-1m',
        trees: ['nucleotide_database_tree', 'protein_database_tree'],
        databaseFloor: 150,
        hasProtein: true,
        exampleDatabases: ['ORF_coding', 'Protein_sequences']
    },
    {
        label: 'SGD (fungal)',
        path: '/blast/SGD/R64-5-1f/',
        heading: 'Alliance SGD Fungal BLAST',
        dataVersion: 'R64-5-1f',
        trees: ['nucleotide_database_tree', 'protein_database_tree'],
        databaseFloor: 250,
        hasProtein: true,
        // The fungal set shares no database titles with the main set, so it has
        // examples of its own. examples.js lists both and filters to the ones
        // this deployment actually loaded.
        exampleDatabases: ['S_cerevisiae_Coding_Sequences', 'S_cerevisiae_Protein_Sequences']
    },
    {
        label: 'RGD',
        path: '/blast/RGD/8.3.0/',
        heading: 'Alliance RGD BLAST',
        dataVersion: '8.3.0',
        // RGD, ZFIN and ALLIANCE ship nucleotide databases only, so the protein
        // tree is not rendered at all. Asserting the exact tree list keeps a
        // regression that drops (or spuriously adds) a tree visible.
        trees: ['nucleotide_database_tree'],
        databaseFloor: 5,
        hasProtein: false,
        exampleDatabases: ['GRCr8']
    },
    {
        label: 'ZFIN',
        path: '/blast/ZFIN/zfintest/',
        heading: 'Alliance ZFIN BLAST',
        dataVersion: 'zfintest',
        trees: ['nucleotide_database_tree'],
        databaseFloor: 5,
        hasProtein: false,
        exampleDatabases: ['Ensembl_Transcripts']
    },
    {
        label: 'ALLIANCE',
        path: '/blast/ALLIANCE/prod/',
        // The Alliance-wide deployment has no member name to interpolate, so the
        // heading collapses to "Alliance BLAST".
        heading: 'Alliance BLAST',
        dataVersion: 'prod',
        trees: ['nucleotide_database_tree'],
        databaseFloor: 1,
        hasProtein: false,
        exampleDatabases: ['ZFIN_GRCz11']
    }
];

/**
 * Attach listeners that record everything that went wrong while a page loaded.
 * Call BEFORE navigating. Returns the collectors so a test can assert on them.
 */
function watchForFailures(page, baseURL) {
    const origin = new URL(baseURL).origin;
    const state = { pageErrors: [], badResponses: [], failedRequests: [], okResponses: [] };

    page.on('pageerror', (err) => state.pageErrors.push(String(err)));

    page.on('response', (res) => {
        const url = res.url();
        if (res.status() >= 400 && !THIRD_PARTY.test(url)) {
            state.badResponses.push(`${res.status()} ${url}`);
        }
        if (res.status() < 400) state.okResponses.push(url);
    });

    // A request that never got a response at all (TLS failure, DNS, blocked by
    // CSP) produces no `response` event, so the status check above misses it.
    // Only same-origin failures matter -- analytics is aborted routinely.
    page.on('requestfailed', (req) => {
        if (req.url().startsWith(origin)) {
            const failure = req.failure();
            state.failedRequests.push(`${failure ? failure.errorText : 'failed'} ${req.url()}`);
        }
    });

    return state;
}

/** Read the per-MOD facts that matter off the rendered page in one round trip. */
function readPageFacts(page, selectors) {
    return page.evaluate((sel) => {
        const text = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
        const boxes = Array.from(document.querySelectorAll(sel.databaseCheckbox));
        const logo = document.querySelector(sel.memberLogo);

        return {
            headerText: text(document.querySelector(sel.header)),
            // naturalWidth is 0 for an <img> whose src failed to load, so this
            // distinguishes "logo tag present" from "logo actually rendered".
            logo: logo ? { src: logo.src, naturalWidth: logo.naturalWidth } : null,
            treeIds: Array.from(document.querySelectorAll(sel.anyTree)).map((t) => t.id),
            treeAnchorCount: document.querySelectorAll(`${sel.anyTree} ${sel.treeAnchor}`).length,
            emptyTreeAnchors: Array.from(document.querySelectorAll(`${sel.anyTree} ${sel.treeAnchor}`))
                .filter((a) => a.innerText.trim() === '').length,
            hintCount: Array.from(document.querySelectorAll('p'))
                .filter((p) => p.textContent.trim() === sel.treeHintText).length,
            databaseCount: boxes.length,
            nucleotideCount: boxes.filter((b) => b.dataset.type === 'nucleotide').length,
            proteinCount: boxes.filter((b) => b.dataset.type === 'protein').length,
            // The examples feature resolves databases by title, so an untitled
            // checkbox is a broken database entry even if the count looks fine.
            untitled: boxes.filter((b) => {
                const label = b.closest(sel.databaseLabel);
                return !label || label.textContent.trim() === '';
            }).length,
            databaseTitles: boxes.map((b) => {
                const label = b.closest(sel.databaseLabel);
                return label ? label.textContent.trim() : null;
            })
        };
    }, selectors);
}

test.describe('cross-MOD: every deployment boots and renders its own databases', () => {
    for (const mod of MODS) {
        test(`${mod.label} at ${mod.path}`, async ({ page, baseURL }) => {
            const failures = watchForFailures(page, baseURL);

            // gotoSearch only returns once #sequence AND a jstree anchor exist,
            // i.e. once React has genuinely booted -- not merely once HTML arrived.
            await gotoSearch(page, mod.path);

            // --- the search bundle really was fetched and executed -------------
            // If the page referenced unreachable asset URLs (the classic
            // localhost/HTTPS-mismatch failure) there would be no 200 here.
            const searchBundle = failures.okResponses
                .filter((u) => /sequenceserver-search\.min\.js/.test(u));
            expect(searchBundle.length,
                'the search bundle did not load with a 2xx/3xx status').toBeGreaterThan(0);

            await expect(page.locator(S.sequence)).toBeEditable();
            // Nothing is queryable yet, so the submit button must still be off.
            // This proves React's own state logic ran, not just that markup exists.
            await expect(page.locator(S.submit)).toBeDisabled();

            const facts = await readPageFacts(page, E);

            // --- branding is this MOD's, not a neighbour's ---------------------
            expect(facts.headerText).toContain(mod.heading);
            expect(facts.headerText).toContain(`Data Version: ${mod.dataVersion}`);
            // "Powered by <semver>" is part of the shipped header chrome.
            expect(facts.headerText).toMatch(/Powered by\s+\d+\.\d+\.\d+/);
            // No other MOD's name may appear in this MOD's header.
            for (const other of MODS) {
                if (other.heading === mod.heading) continue;
                // "Alliance BLAST" is a prefix of nothing, but "Alliance SGD BLAST"
                // is a distinct string from "Alliance SGD Fungal BLAST" -- compare
                // against the heading only when it is not a substring relationship.
                if (mod.heading.includes(other.heading) || other.heading.includes(mod.heading)) continue;
                expect(facts.headerText,
                    `${mod.label} header shows ${other.label}'s branding`).not.toContain(other.heading);
            }

            // --- the MOD logo resolved -----------------------------------------
            expect(facts.logo, 'no img#alliance-member-logo rendered').not.toBeNull();
            expect(facts.logo.src).not.toBe('');
            expect(facts.logo.naturalWidth,
                `logo did not load: ${facts.logo.src}`).toBeGreaterThan(0);

            // --- exactly the right trees, each actually rendered by jstree ------
            expect(facts.treeIds).toEqual(mod.trees);
            expect(facts.treeAnchorCount,
                'jstree rendered no anchors: the tree is empty').toBeGreaterThan(0);
            expect(facts.emptyTreeAnchors, 'jstree rendered unlabelled nodes').toBe(0);
            // The hint ships once per tree, so its count is a second, independent
            // witness that the expected number of trees was rendered.
            expect(facts.hintCount).toBe(mod.trees.length);

            // --- the database list is populated and correctly typed -------------
            expect(facts.databaseCount,
                `${mod.label} rendered ${facts.databaseCount} databases`)
                .toBeGreaterThanOrEqual(mod.databaseFloor);
            // Every checkbox must declare a type; the form picks the BLAST method
            // from data-type, so an untyped database silently breaks the search.
            expect(facts.nucleotideCount + facts.proteinCount).toBe(facts.databaseCount);
            expect(facts.nucleotideCount).toBeGreaterThan(0);
            if (mod.hasProtein) {
                expect(facts.proteinCount).toBeGreaterThan(0);
            } else {
                expect(facts.proteinCount,
                    `${mod.label} is nucleotide-only but rendered protein databases`).toBe(0);
            }
            expect(facts.untitled, 'databases rendered without a title').toBe(0);

            // --- nothing broke on the way up ------------------------------------
            expect(failures.pageErrors,
                `uncaught page errors:\n${failures.pageErrors.join('\n')}`).toEqual([]);
            expect(failures.badResponses,
                `requests failed:\n${failures.badResponses.join('\n')}`).toEqual([]);
            expect(failures.failedRequests,
                `same-origin requests never completed:\n${failures.failedRequests.join('\n')}`).toEqual([]);
        });
    }
});

test.describe('cross-MOD: example sequences target databases that exist in that deployment', () => {
    // examples.js keys its table on the MOD segment of the URL alone
    // (pathname.split('/')[2]) and matches the database BY TITLE. Two versions of
    // the same MOD therefore share one set of examples even when they carry
    // completely different databases. If the named title is absent the button
    // fills the textarea and selects nothing, leaving the user on a dead end with
    // the submit button greyed out and no error shown.
    for (const mod of MODS) {
        test(`${mod.label}: every offered example names a database this deployment has`, async ({ page }) => {
            await gotoSearch(page, mod.path);

            const titles = await databaseTitles(page);

            const buttons = page.locator(S.exampleButtons);
            const offered = await buttons.allInnerTexts();
            expect(offered.length,
                `${mod.label} offers no example sequences`).toBeGreaterThan(0);

            // Each button's tooltip names the database it will select
            // ("Load <label> and select <database>"), so the deployment states
            // its own targets and the test does not have to restate them.
            // Comparing counts instead -- buttons against a list of database
            // names -- only matched because every example currently happens to
            // target a different database.
            const targeted = [];
            for (let i = 0; i < offered.length; i += 1) {
                const tip = await buttons.nth(i).getAttribute('title');
                const target = (tip || '').match(/ and select (.+)$/);
                expect(target, `example "${offered[i]}" names no target database`).not.toBeNull();
                targeted.push(target[1]);
            }

            const dangling = targeted.filter((db) => !titles.includes(db));
            expect(dangling,
                `${mod.label} offers example(s) targeting ${dangling.join(', ')}, which `
                + 'this deployment does not load, so clicking the example selects nothing '
                + 'and the search cannot be run').toEqual([]);

            // And the examples we expect to be there have not quietly dropped
            // out -- the filter in examples.js removes an example whose database
            // is missing, which would leave the check above trivially satisfied.
            const absent = mod.exampleDatabases.filter((db) => !targeted.includes(db));
            expect(absent,
                `${mod.label} no longer offers an example for ${absent.join(', ')}`).toEqual([]);
        });
    }
});

test.describe('WormBase hit linkouts', () => {
    test('a WormBase protein hit carries no "NCBI:" link', async ({ page }) => {
        // One real BLAST run: 10-20s on dev, plus batched hit rendering.
        test.setTimeout(240 * 1000);

        await gotoSearch(page, '/blast/WB/WS298/');
        // The shipped WB example is unc-54 protein against C_elegans_Protein_Sequences.
        await clickExample(page, /unc-54/);
        await runBlast(page);

        const found = await page.evaluate(() => {
            // CAUTION: ".hit" also matches <polygon class="hit"> inside the
            // graphical-overview SVG, which has no innerText. Restrict to div.hit.
            const hits = Array.from(document.querySelectorAll('div.hit'));
            return {
                hitCount: hits.length,
                firstHitText: hits.length ? hits[0].innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
                ncbiHrefs: Array.from(document.querySelectorAll('div.hit a[href*="ncbi.nlm.nih.gov"]'))
                    .map((a) => `${a.textContent.trim()} -> ${a.href}`),
                // Belt and braces: catch a linkout whose label is right but whose
                // host changed, anywhere in the results region.
                ncbiLabelled: Array.from(document.querySelectorAll('div#results a'))
                    .filter((a) => /^NCBI:/.test(a.textContent.trim()))
                    .map((a) => `${a.textContent.trim()} -> ${a.href}`)
            };
        });

        // Guard against a vacuous pass: there must BE hits, and they must really
        // be WormBase protein hits, before "no NCBI link" means anything.
        expect(found.hitCount, 'the WormBase search returned no hits').toBeGreaterThan(0);
        await expect(page.locator(S.hitById(1, 1))).toBeVisible();
        expect(found.firstHitText).toMatch(/wormpep=CE\d+/);
        expect(found.firstHitText).toMatch(/gene=WBGene\d+/);
        // The accession is a WormBase sequence name (e.g. F11C3.3), which is
        // exactly the shape a loosened NCBI regex would wrongly match.
        expect(found.firstHitText).toMatch(/locus=unc-54/);

        expect(found.ncbiHrefs,
            `WormBase hits must not link to NCBI -- these accessions are not NCBI `
            + `accessions, so every one of these links would be dead:\n${found.ncbiHrefs.join('\n')}`)
            .toEqual([]);
        expect(found.ncbiLabelled,
            `an "NCBI:" linkout was rendered on a WormBase hit:\n${found.ncbiLabelled.join('\n')}`)
            .toEqual([]);
    });

    // The two tests below are a matched pair and only mean something together:
    // the first says a WormBase protein hit offers no genome browser link, the
    // second says a WormBase GENOMIC hit still does. Run alone, the first is
    // satisfied by deleting JBrowse links from the app entirely.
    test('a WormBase protein hit carries no genome browser link', async ({ page }) => {
        test.setTimeout(240 * 1000);

        // WormBase's protein and genomic databases are both built as
        // "c_elegansdb" under project PRJNA13758, so the protein database used
        // to match the genomic environment.json entry and inherit its
        // genome_browser block. Every hit then got a JBrowse link addressed to
        // the first word of the protein defline -- loc=wormpep=CE09349:1..1678,
        // a sequence name WormBase has never heard of, at amino acid offsets.
        await gotoSearch(page, '/blast/WB/WS298/');
        await clickExample(page, /unc-54/);

        // Prove this really is a protein search before "no link" means anything.
        expect(await checkedDatabaseTitles(page)).toEqual(['C_elegans_Protein_Sequences']);
        await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(1);
        await expect(page.locator(S.databaseCheckedOfType('nucleotide'))).toHaveCount(0);

        await runBlast(page);

        await expect(page.locator(S.hitById(1, 1))).toBeVisible();
        const hitCount = await page.locator('div.hit').count();
        expect(hitCount, 'the WormBase protein search returned no hits').toBeGreaterThan(0);

        const jbrowseHrefs = await page.locator(S.jbrowseLink).evaluateAll(
            (as) => as.map((a) => a.getAttribute('href')));
        expect(jbrowseHrefs,
            `${hitCount} protein hit(s) carry a genome browser link. A protein hit is `
            + 'addressed by amino acid offset and has no position on a chromosome, so '
            + `these links cannot resolve:\n${jbrowseHrefs.slice(0, 5).join('\n')}`)
            .toEqual([]);

        // Specifically: no link may be addressed by a defline attribute pair.
        for (const href of jbrowseHrefs) {
            expect(decodeURIComponent(href)).not.toMatch(/loc=[A-Za-z_][A-Za-z0-9_]*=/);
        }
    });

    test('a WormBase genomic hit still carries a JBrowse link on a real chromosome', async ({ page }) => {
        test.setTimeout(240 * 1000);

        await gotoSearch(page, '/blast/WB/WS298/');
        await selectDatabaseByTitle(page, 'C_elegans_Genome_Assembly');
        expect(await checkedDatabaseTitles(page)).toEqual(['C_elegans_Genome_Assembly']);

        // 300 bp read off C. elegans chromosome III at 5,000,001 in this very
        // deployment (blastdbcmd -entry III -range 5000001-5000300), so the top
        // hit is chromosome III by construction and the expectation below is
        // exact rather than "some chromosome".
        await page.locator(S.sequence).fill([
            '>III:5000001-5000300',
            'TTGTCAGACGGAAGCAGATTCAATGTAGTTTTCGAGCAAACCAGGCTTCTAAAAAGCAAATTTTTGACGAAAAGATTTCA',
            'AGAAATGGCTTTTGATGGTGAACAAAACGTTGAGACTTTGATTTAGAATTATATTTCAGATGACATTTGCTGTGGTCACA',
            'ATGCAGAAAACATGAACGAAGCTGAAGATATTATTTGCTCATTCCGAGTTCCATCAATTCCATTGAGTCCTGTGGAAACT',
            'CTCACTCCATGTGTAAGATTTTAAAACCTTTGTTGCCTATAAAAATTAAATTATACAGGC'
        ].join('\n'));

        await runBlast(page);

        await expect(page.locator(S.hitById(1, 1))).toBeVisible();

        const jbrowseHrefs = await page.locator(S.jbrowseLink).evaluateAll(
            (as) => as.map((a) => a.getAttribute('href')));
        expect(jbrowseHrefs.length,
            'a WormBase genomic hit must still offer a JBrowse link -- if this is '
            + 'empty, genome browser links have been lost outright rather than '
            + 'confined to the databases that have coordinates').toBeGreaterThan(0);

        const loc = new URL(jbrowseHrefs[0]).searchParams.get('loc');
        expect(loc, `JBrowse link carries no loc=: ${jbrowseHrefs[0]}`).toBeTruthy();
        expect(loc).toMatch(/^III:\d+\.\.\d+$/);
    });
});
