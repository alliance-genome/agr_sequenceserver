// Results page: NCBI linkouts, JBrowse linkouts and the sequence viewer.
//
// Covers shipped features #3 (NCBI /protein/ vs /nuccore/ routing), #4 (SGD
// JBrowse linkout with real chromosome names) and #8 (sequence viewer modal,
// and the absence of the "Unexpected token '<'" JSON-parse regression).
//
// These specs run REAL BLAST searches through the UI against the dev
// deployment -- 10-20s each -- so each describe block runs one search in a
// beforeAll and several assertions against that one result page.
//
// WHICH DATABASE YIELDS WHAT (all read off live dev on 2026-09-24; picking the
// wrong one makes a spec silently vacuous):
//
//   SGD R64-5-1m / Nuclear_chromosomes (nucleotide)
//       -> hits carry BOTH a JBrowse link and an NCBI /nuccore/ link,
//          because the deflines are ref|NC_001138| RefSeq chromosomes.
//       -> "Sequence" is DISABLED ("Sequence too long"): a yeast chromosome is
//          270kb, so the viewer refuses it. Not a bug; see the assertion below.
//   SGD R64-5-1m / ORF_coding (nucleotide, what the ACT1 example selects)
//       -> NO linkouts at all: SGD-native deflines (YFL039C ...) carry no
//          RefSeq accession, so links.rb correctly declines to invent one.
//       -> short sequences, so "Sequence" is enabled. This is where the
//          sequence-viewer spec belongs.
//   SGD R64-5-1f / S_cerevisiae_Protein_Sequences (protein)
//       -> hits are ref|NP_116614.1| -> NCBI /protein/ links.
//       NOTE: the R64-5-1m protein example DB ("Protein_sequences") is SGD's
//       own ORF protein set with no RefSeq accessions and therefore produces
//       NO NCBI link at all -- it cannot be used to test /protein/ routing.

const { test, expect } = require('@playwright/test');
const {
    gotoSearch, clickExample, clearDatabases, selectDatabaseByTitle,
    checkedDatabaseTitles, runBlast, S
} = require('./helpers/app');

const SGD_MAIN = '/blast/SGD/R64-5-1m/';
const SGD_FUNGAL = '/blast/SGD/R64-5-1f/';

const SGD_NUCLEOTIDE_EXAMPLE = 'ACT1 / YFL039C coding sequence';

// S. cerevisiae Act1p. Pasted rather than taken from the example row because
// the fungal deployment (R64-5-1f) does not carry the database the SGD example
// points at, and this spec needs a protein DB with RefSeq deflines.
const ACT1_PROTEIN = [
    '>YFL039C ACT1 actin',
    'MDSEVAALVIDNGSGMCKAGFAGDDAPRAVFPSIVGRPRHQGIMVGMGQKDSYVGDEAQS',
    'KRGILTLRYPIEHGIVTNWDDMEKIWHHTFYNELRVAPEEHPVLLTEAPMNPKSNREKMT',
    'QIMFETFNVPAFYVSIQAVLSLYSSGRTTGIVLDSGDGVTHVVPIYAGFSLPHAILRIDL',
    'AGRDLTDYLMKILSERGYSFSTTAEREIVRDIKEKLCYVALDFEQEMQTAAQSSSIEKSY',
    'ELPDGQVITIGNERFRAPEALFHPSVLGLESAGIDQTTYNSIMKCDVDVRKELYGNIVMS',
    'GGTTMFPGIAERMQKEITALAPSSMKVKIIAPPERKYSVWIGGSILASLTTFQQMWISKQ',
    'EYDESGPSIVHHKCF'
].join('\n');

// The only sequence names S. cerevisiae has in JBrowse: 16 nuclear chromosomes
// in Roman numerals, plus the mitochondrion. Anything else -- in particular a
// RefSeq accession such as chrNC_001138 or NC_001138 -- is the bug this
// linkout work fixed.
const SGD_CHROMOSOMES = [
    'chrI', 'chrII', 'chrIII', 'chrIV', 'chrV', 'chrVI', 'chrVII', 'chrVIII',
    'chrIX', 'chrX', 'chrXI', 'chrXII', 'chrXIII', 'chrXIV', 'chrXV', 'chrXVI',
    'chrmt'
];

// A RefSeq accession, e.g. NC_001138 or NC_001138.5. Used as a NEGATIVE
// assertion against JBrowse sequence names.
const REFSEQ_ACCESSION = /\b[A-Z]{2}_\d+(\.\d+)?\b/;

/**
 * Every link inside a hit, as {text, href} -- read straight off the DOM so the
 * href is the raw attribute, not a browser-normalised one.
 */
function hitLinks(page, hitSelector) {
    return page.locator(hitSelector).evaluate((hit) => Array.from(hit.querySelectorAll('a'))
        .map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') || '' })));
}

/** Pull the JBrowse `loc` sequence name (the part before the ':') out of an href. */
function jbrowseLocus(href) {
    const url = new URL(href);
    // searchParams decodes %3A etc. for us; loc looks like "chrVI:52608..55558".
    const loc = url.searchParams.get('loc');
    if (!loc) return { seqName: null, loc: null };
    return { seqName: loc.split(':')[0], loc };
}

/** The seq_id values inside the URL-encoded addFeatures JSON blob. */
function jbrowseFeatureSeqIds(href) {
    const raw = new URL(href).searchParams.get('addFeatures');
    if (!raw) return [];
    return JSON.parse(raw).map((f) => f.seq_id);
}

/** Assert the whole results page is free of the JSON-parse regression. */
async function expectNoUnexpectedToken(page) {
    const body = await page.locator('body').innerText();
    expect(body, 'results page must never surface a raw JSON parse error')
        .not.toMatch(/Unexpected token/i);
}

// ---------------------------------------------------------------------------
// Nucleotide hits on Nuclear_chromosomes: JBrowse + NCBI /nuccore/
// ---------------------------------------------------------------------------

test.describe.serial('Results linkouts on SGD chromosome hits', () => {
    // The beforeAll below runs a real BLAST. dev is a single shared container,
    // so a search that normally takes 10-20s can queue behind another one;
    // configure() raises the budget for the hook as well as the tests (a
    // test.setTimeout() inside beforeAll does not).
    //
    // The retries are for that queueing only: when the container is busy the
    // submit can outlast even the 180s wait in runBlast, and the whole block
    // (beforeAll included) is re-run. They do not paper over an assertion --
    // every expectation below was verified to fail when its expected value was
    // mutated, and a broken feature fails all three attempts.
    test.describe.configure({ timeout: 300 * 1000, retries: 2 });

    let page;

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await gotoSearch(page, SGD_MAIN);

        // The example gives us a known-good ACT1 coding sequence, but points at
        // ORF_coding, whose SGD-native deflines carry no linkouts. Swap the
        // database for the RefSeq chromosomes, which do.
        await clickExample(page, SGD_NUCLEOTIDE_EXAMPLE);
        await clearDatabases(page);
        await selectDatabaseByTitle(page, 'Nuclear_chromosomes');
        expect(await checkedDatabaseTitles(page)).toEqual(['Nuclear_chromosomes']);

        await runBlast(page);
    });

    test.afterAll(async () => {
        if (page) await page.close();
    });

    test('the top hit is a RefSeq chromosome and carries both linkouts', async () => {
        const first = page.locator(S.hitById(1, 1));
        await expect(first).toBeVisible();
        // ACT1 lives on chromosome VI; the defline is the RefSeq chromosome record.
        await expect(first).toContainText('NC_001138');
        await expect(first).toContainText('[chromosome=VI]');

        const links = await hitLinks(page, S.hitById(1, 1));
        const texts = links.map((l) => l.text);
        expect(texts, 'top hit should offer a JBrowse linkout').toContain('JBrowse');
        expect(texts.some((t) => t.startsWith('NCBI:')),
            `top hit should offer an NCBI linkout, got ${JSON.stringify(texts)}`).toBe(true);
    });

    test('the JBrowse link targets yeastgenome with a Roman-numeral chromosome, not a RefSeq accession', async () => {
        const links = await hitLinks(page, S.hitById(1, 1));
        const jbrowse = links.find((l) => l.text === 'JBrowse');
        expect(jbrowse, 'no JBrowse link on the top hit').toBeTruthy();

        expect(new URL(jbrowse.href).hostname).toBe('jbrowse.yeastgenome.org');

        const { seqName, loc } = jbrowseLocus(jbrowse.href);
        // ACT1 is on chromosome VI, so this is exact, not just "some chromosome".
        expect(seqName, `loc= was "${loc}"`).toBe('chrVI');
        // The regression this guards: an unmapped RefSeq id leaking into loc=.
        expect(seqName).not.toMatch(REFSEQ_ACCESSION);
        // loc is the padded view window, e.g. chrVI:52608..55558 -- assert the
        // shape (two coordinates), not the exact padding.
        expect(loc).toMatch(/^chrVI:\d+\.\.\d+$/);

        // The highlighted feature must sit on the same sequence as the view.
        const seqIds = jbrowseFeatureSeqIds(jbrowse.href);
        expect(seqIds.length).toBeGreaterThan(0);
        for (const id of seqIds) expect(id).toBe('chrVI');
    });

    test('every JBrowse link on the page names a real S. cerevisiae chromosome', async () => {
        const hrefs = await page.locator(S.jbrowseLink).evaluateAll(
            (as) => as.map((a) => a.getAttribute('href')));
        // The ACT1 query hits several chromosomes; if this is empty the spec is
        // asserting nothing, so require real coverage.
        expect(hrefs.length, 'expected JBrowse links on the chromosome hits').toBeGreaterThan(1);

        for (const href of hrefs) {
            const { seqName, loc } = jbrowseLocus(href);
            expect(seqName, `bad JBrowse loc= "${loc}"`).not.toMatch(REFSEQ_ACCESSION);
            expect(SGD_CHROMOSOMES, `bad JBrowse loc= "${loc}"`).toContain(seqName);
            for (const id of jbrowseFeatureSeqIds(href)) {
                expect(SGD_CHROMOSOMES, `bad addFeatures seq_id in ${loc}`).toContain(id);
            }
        }
    });

    test('NCBI links on nucleotide hits route to /nuccore/, never /protein/', async () => {
        const links = await hitLinks(page, S.hitById(1, 1));
        const ncbi = links.find((l) => l.text.startsWith('NCBI:'));
        expect(ncbi, 'no NCBI link on the top hit').toBeTruthy();

        const url = new URL(ncbi.href);
        expect(url.hostname).toBe('www.ncbi.nlm.nih.gov');
        expect(url.pathname).toBe('/nuccore/NC_001138');
        expect(ncbi.text).toBe('NCBI: NC_001138');

        // And nothing anywhere on this nucleotide result mis-routes to /protein/.
        await expect(page.locator(S.ncbiProteinLink)).toHaveCount(0);
        const nuccoreCount = await page.locator(S.ncbiNuccoreLink).count();
        expect(nuccoreCount).toBeGreaterThan(1);
        expect(nuccoreCount).toBe(await page.locator(S.ncbiLink).count());
    });

    test('the sequence viewer refuses a 270kb chromosome instead of hanging', async () => {
        // Shipped guard: chromosome records are too large to render, so the
        // button is disabled with an explanatory title rather than firing a
        // fetch that would stall the browser.
        const button = page.locator(S.hitById(1, 1)).locator(S.viewSequenceButton);
        await expect(button).toHaveText('Sequence');
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute('title', /too long/i);
    });

    test('the results page never surfaces a raw JSON parse error', async () => {
        await expectNoUnexpectedToken(page);
    });
});

// ---------------------------------------------------------------------------
// Sequence viewer -- needs a database of short records, so ORF_coding
// ---------------------------------------------------------------------------

test.describe.serial('Sequence viewer', () => {
    // Retries cover BLAST queueing on the shared dev container, not assertions.
    test.describe.configure({ timeout: 300 * 1000, retries: 2 });

    let page;
    const sequenceRequests = [];

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        page.on('response', (r) => {
            if (r.url().includes('/get_sequence/')) {
                sequenceRequests.push({ status: r.status(), url: r.url() });
            }
        });

        await gotoSearch(page, SGD_MAIN);
        // The example selects ORF_coding: short records, so the viewer is usable.
        await clickExample(page, SGD_NUCLEOTIDE_EXAMPLE);
        expect(await checkedDatabaseTitles(page)).toEqual(['ORF_coding']);
        await runBlast(page);
    });

    test.afterAll(async () => {
        if (page) await page.close();
    });

    test('clicking "Sequence" opens the modal and renders the real sequence', async () => {
        const dialog = page.locator(S.sequenceViewer);
        // The <dialog> ships in the DOM from page load, so its mere presence
        // proves nothing -- what matters is that it is not yet open.
        await expect(dialog).toHaveCount(1);
        expect(await dialog.evaluate((d) => d.hasAttribute('open'))).toBe(false);

        await page.locator(S.hitById(1, 1)).locator(S.viewSequenceButton).click();

        await expect(page.locator(S.sequenceViewerOpen)).toHaveCount(1);
        await expect(dialog.locator('h3')).toHaveText('View sequence');

        const content = page.locator(S.sequenceViewerContent);
        // The defline of the hit we clicked...
        await expect(content).toContainText('YFL039C');
        await expect(content).toContainText('SGDID:S000001855');
        // ...and actual residues, not a spinner or an error page. ACT1's coding
        // sequence starts ATGGATTCTGAGGTTGCTGCT.
        await expect(content).toContainText('ATGGATTCTGAGGTTGCTGCT');
        const text = await content.innerText();
        expect(text.replace(/\s/g, '')).toMatch(/[ACGTN]{200,}/);
    });

    test('the sequence fetch succeeded, so nothing was parsed as HTML', async () => {
        // The original SGD bug: get_sequence returned an HTML error page, the
        // client JSON.parse'd it, and the user saw "Unexpected token '<'".
        expect(sequenceRequests.length,
            'expected a /get_sequence/ request when the viewer opened').toBeGreaterThan(0);
        for (const r of sequenceRequests) {
            expect(r.status, `get_sequence returned ${r.status} for ${r.url}`).toBe(200);
        }
        await expectNoUnexpectedToken(page);
        await expect(page.locator(S.sequenceViewerContent)).not.toContainText('Unexpected token');
    });

    test('the close button dismisses the modal', async () => {
        await page.locator(S.sequenceViewerClose).click();
        await expect(page.locator(S.sequenceViewerOpen)).toHaveCount(0);
    });

    test('a failed fetch shows a readable message, not "Unexpected token"', async () => {
        // The tests above run against a 200 response, where the string could
        // not appear however the client behaved — they cannot fail if the
        // handling regresses. This supplies the condition the original bug
        // needed (an HTML error page where JSON was expected) and asserts on
        // what the app does with it.
        await page.route('**/get_sequence/**', (route) =>
            route.fulfill({
                status: 500,
                contentType: 'text/html',
                body: '<!DOCTYPE html><html><body><h1>Internal Server Error</h1></body></html>',
            }));

        try {
            await page.locator(S.hitById(1, 1)).locator(S.viewSequenceButton).click();

            // Whatever surfaces, it must be intelligible and must not be a
            // JSON parse error leaking through.
            await expect(page.locator('body')).toContainText(/Server error|Internal Server Error/i,
                { timeout: 15000 });
            await expect(page.locator('body')).not.toContainText('Unexpected token');
            await expect(page.locator('body')).not.toContainText('SyntaxError');
        } finally {
            await page.unroute('**/get_sequence/**');
        }
    });
});

// ---------------------------------------------------------------------------
// Protein hits: NCBI must route to /protein/
// ---------------------------------------------------------------------------

test.describe('Results linkouts on protein hits', () => {
    // Retries cover BLAST queueing on the shared dev container, not assertions.
    test.describe.configure({ timeout: 300 * 1000, retries: 2 });

    test('NCBI links on protein hits route to /protein/, never /nuccore/', async ({ page }) => {
        await gotoSearch(page, SGD_FUNGAL);
        await page.locator(S.sequence).fill(ACT1_PROTEIN);
        await selectDatabaseByTitle(page, 'S_cerevisiae_Protein_Sequences', S.proteinTree);

        // Prove we are really running a protein search: exactly one database,
        // of type protein, and the resolved method is blastp.
        expect(await checkedDatabaseTitles(page)).toEqual(['S_cerevisiae_Protein_Sequences']);
        await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(1);
        await expect(page.locator(S.databaseCheckedOfType('nucleotide'))).toHaveCount(0);
        // The button label is lowercase in the DOM; the capitals are CSS.
        await expect(page.locator(S.submit)).toHaveText(/blastp/i);

        await runBlast(page);

        const first = page.locator(S.hitById(1, 1));
        // Top hit is the RefSeq actin protein record.
        await expect(first).toContainText('NP_116614');

        const links = await hitLinks(page, S.hitById(1, 1));
        const ncbi = links.find((l) => l.text.startsWith('NCBI:'));
        expect(ncbi, `no NCBI link on the top protein hit, links were ${JSON.stringify(links)}`)
            .toBeTruthy();

        const url = new URL(ncbi.href);
        expect(url.hostname).toBe('www.ncbi.nlm.nih.gov');
        expect(url.pathname).toBe('/protein/NP_116614');
        expect(ncbi.text).toBe('NCBI: NP_116614');

        // Protein records must not be routed to the nucleotide database, and a
        // protein hit has no genome browser linkout.
        await expect(page.locator(S.ncbiNuccoreLink)).toHaveCount(0);
        await expect(page.locator(S.jbrowseLink)).toHaveCount(0);

        const proteinLinks = await page.locator(S.ncbiProteinLink).count();
        expect(proteinLinks).toBeGreaterThan(1);
        for (const href of await page.locator(S.ncbiProteinLink)
            .evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
            expect(new URL(href).pathname).toMatch(/^\/protein\/[NXYAZ]P_\d+/);
        }

        await expectNoUnexpectedToken(page);
    });
});
