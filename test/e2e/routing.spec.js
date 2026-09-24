// URL ROUTING, as a browser experiences it.
//
// Covers the permanent-URL work (/blast/:mod/ -> newest release, and the named
// SGD aliases /yeast/ and /fungal/) and the ?name= deep links that prefill the
// query box.
//
// These are deliberately NOT HTTP-status checks -- test/manual/smoke-test.sh
// already curls the redirects. What only a browser can tell you is that the
// page you LAND on is the right dataset and that React then did the right thing
// with it: the correct databases are in the form, the header agrees with the
// URL, and ?name= actually ends up as text inside #sequence.
//
// Every assertion below is on a shipped string or a dataset fact that differs
// between the two SGD releases, so a test cannot pass while the feature is
// broken. See the "discrimination" notes on the alias tests.

const { test, expect } = require('@playwright/test');
const { gotoSearch, databaseTitles, S } = require('./helpers/app');

// Directory names the route must never publish (NON_PUBLIC_VERSION_DIR).
// /db/WB really does contain a "dev" directory alongside WS295..WS298, so a
// broken filter would be visible here, not hypothetical.
const NON_PUBLIC = /\/(dev|test|staging)\/?$/i;

// The ACT1 / YFL039C record that a ?name= lookup resolves to on R64-5-1m.
const ACT1_HEADER = /^>YFL039C ACT1 SGDID:S000001855/;

/** The "Data Version: X" string the layout renders in the page chrome. */
function dataVersionText(page) {
    return page.locator('body').innerText().then((t) => {
        const m = t.match(/Data Version:\s*(\S+)/);
        return m ? m[1] : null;
    });
}

test.describe('permanent URLs and named aliases', () => {
    test('/blast/SGD/yeast/ lands on R64-5-1m with the main-yeast databases loaded', async ({ page }) => {
        await gotoSearch(page, '/blast/SGD/yeast/');

        // Landed on the real release path, not left sitting on the alias.
        await expect(page).toHaveURL(/\/blast\/SGD\/R64-5-1m\/$/);
        // The page chrome agrees with the URL -- catches a redirect that moves
        // the address bar while the app loads some other dataset.
        expect(await dataVersionText(page)).toBe('R64-5-1m');

        // And the databases that arrived really are the main-yeast set.
        const titles = await databaseTitles(page);
        expect(titles.length).toBeGreaterThan(100);
        expect(titles).toContain('Nuclear_chromosomes');
        expect(titles).toContain('ORF_coding');
    });

    test('/blast/SGD/fungal/ lands on R64-5-1f with the fungal databases loaded', async ({ page }) => {
        await gotoSearch(page, '/blast/SGD/fungal/');

        await expect(page).toHaveURL(/\/blast\/SGD\/R64-5-1f\/$/);
        expect(await dataVersionText(page)).toBe('R64-5-1f');

        const titles = await databaseTitles(page);
        expect(titles.length).toBeGreaterThan(100);
        expect(titles).toContain('S_cerevisiae_Coding_Sequences');
    });

    test('the two SGD aliases resolve to genuinely different datasets', async ({ page }) => {
        // This is the test that makes the two above mean something: if both
        // aliases were wired to the same release, every other assertion here
        // would still pass. The discriminating fact is that
        // Nuclear_chromosomes exists ONLY on R64-5-1m and
        // S_cerevisiae_Coding_Sequences ONLY on R64-5-1f.
        await gotoSearch(page, '/blast/SGD/yeast/');
        const main = await databaseTitles(page);

        await gotoSearch(page, '/blast/SGD/fungal/');
        const fungal = await databaseTitles(page);

        expect(main).toContain('Nuclear_chromosomes');
        expect(main).not.toContain('S_cerevisiae_Coding_Sequences');

        expect(fungal).toContain('S_cerevisiae_Coding_Sequences');
        expect(fungal).not.toContain('Nuclear_chromosomes');

        // Not merely two different orderings of one list.
        expect(fungal.length).not.toBe(main.length);
        const onlyInFungal = fungal.filter((t) => !main.includes(t));
        expect(onlyInFungal.length).toBeGreaterThan(50);
    });

    test('/blast/SGD/ lands on a real published release', async ({ page }) => {
        await gotoSearch(page, '/blast/SGD/');

        // A published SGD release, never a scratch directory. The regex already
        // pins the final segment, so a separate NON_PUBLIC check here could
        // never fail and is deliberately not made.
        await expect(page).toHaveURL(/\/blast\/SGD\/R64-[\d-]+[mf]\/$/);

        // And it is a dataset that actually works: the version in the chrome
        // matches the URL and the form received databases.
        const version = page.url().match(/\/blast\/SGD\/([^/]+)\//)[1];
        expect(await dataVersionText(page)).toBe(version);
        expect((await databaseTitles(page)).length).toBeGreaterThan(0);
    });

    test('/blast/WB/ lands on the newest published WS release', async ({ page }) => {
        await gotoSearch(page, '/blast/WB/');

        // /db/WB holds a "dev" directory alongside the WS releases, and this
        // regex is what proves the redirect skipped it — a separate NON_PUBLIC
        // check would restate the same thing and could never fail.
        await expect(page).toHaveURL(/\/blast\/WB\/WS\d+\/$/);

        const version = page.url().match(/\/blast\/WB\/(WS\d+)\//)[1];
        expect(await dataVersionText(page)).toBe(version);
        expect((await databaseTitles(page)).length).toBeGreaterThan(0);

        // "Newest" is the actual claim, so prove nothing newer was skipped:
        // the next release number up must not be servable. This is what would
        // fail if the sort regressed to lexicographic, or to directory order,
        // once a new release lands.
        const next = `WS${Number(version.slice(2)) + 1}`;
        const res = await page.request.get(`/blast/WB/${next}/`, { failOnStatusCode: false });
        expect(res.status(), `${next} is servable, so ${version} is not the newest release`).not.toBe(200);
    });
});

test.describe('?name= deep links prefill the query box', () => {
    test('?name=YFL039C&type=dna prefills the ACT1 FASTA record', async ({ page }) => {
        // The lookup scans BLAST databases server-side and can take a moment;
        // toHaveValue retries for the configured expect timeout rather than
        // sampling the textarea once.
        await gotoSearch(page, '/blast/SGD/R64-5-1m/?name=YFL039C&type=dna');

        const sequence = page.locator(S.sequence);
        await expect(sequence).toHaveValue(ACT1_HEADER);

        const value = await sequence.inputValue();
        // A real FASTA record: a defline plus a substantial nucleotide body.
        expect(value.length).toBeGreaterThan(1000);
        const body = value.split('\n').slice(1).join('').trim();
        expect(body.length).toBeGreaterThan(1000);
        expect(body).toMatch(/^[ACGTNacgtn]+$/);
    });

    test('?name=ACT1 gene symbol prefills, and ?name=act1 is case-insensitive', async ({ page }) => {
        await gotoSearch(page, '/blast/SGD/R64-5-1m/?name=ACT1');
        await expect(page.locator(S.sequence)).toHaveValue(ACT1_HEADER);
        const upper = await page.locator(S.sequence).inputValue();

        await gotoSearch(page, '/blast/SGD/R64-5-1m/?name=act1');
        await expect(page.locator(S.sequence)).toHaveValue(ACT1_HEADER);
        const lower = await page.locator(S.sequence).inputValue();

        // Case-insensitive means the SAME record, not merely "some record".
        expect(lower).toBe(upper);
    });

    test('a nonsense ?name= leaves the query box empty and does not break the page', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        await gotoSearch(page, '/blast/SGD/R64-5-1m/?name=ZZZNOTAREALGENE123');

        // Empty box, not a stray error string or a partial record.
        await expect(page.locator(S.sequence)).toHaveValue('');
        // The rest of the app still came up, and submit is correctly disabled
        // because there is no query -- i.e. the form is usable, not wedged.
        expect((await databaseTitles(page)).length).toBeGreaterThan(100);
        await expect(page.locator(S.submit)).toBeDisabled();
        expect(pageErrors, `page threw:\n${pageErrors.join('\n')}`).toEqual([]);
    });
});
