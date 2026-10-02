// The gene search box on the search form.
//
// What makes this worth testing is not that a lookup returns something -- the
// ?name= specs already cover that -- but the two things the box exists to fix:
//
//   * A gene symbol is ambiguous. Sixteen of SGD's fungal databases carry an
//     "act1", and ?name= resolved that by taking the first database it found,
//     which handed a curator typing ACT1 the Candida albicans record. The box
//     lists candidates with their organism so the user chooses, and the test
//     below asserts that choosing S. cerevisiae really loads the yeast record
//     rather than merely "a record".
//
//   * Both sequence types are searched. WormBase carries gene symbols only on
//     its protein databases, so a box that followed the selected type would
//     find nothing there.

const { test, expect } = require('@playwright/test');
const { gotoSearch, S } = require('./helpers/app');

const BOX = '#gene-search-input';
const RESULTS = '.gene-search-results li';

// S. cerevisiae's own ACT1, as it appears in the fungal coding set. Candida's
// is NC_032089.x -- a different organism under the same symbol, which is the
// whole point of the list.
const YEAST_ACT1 = /^>NC_001138\.5_cds_NP_116614\.1_1760\b/;

async function search(page, symbol) {
    await page.fill(BOX, symbol);
    await page.waitForSelector(RESULTS, { timeout: 30 * 1000 });
}

test.describe('gene search', () => {
    test('the box is offered on the search form', async ({ page }) => {
        await gotoSearch(page, '/blast/SGD/R64-5-1m/');
        await expect(page.locator(BOX)).toBeVisible();
        // Empty by default: it must not run a search nobody asked for.
        await expect(page.locator(BOX)).toHaveValue('');
        await expect(page.locator(RESULTS)).toHaveCount(0);
    });

    test('an ambiguous symbol lists every organism that has it', async ({ page }) => {
        test.setTimeout(120 * 1000);
        await gotoSearch(page, '/blast/SGD/R64-5-1f/');
        await search(page, 'ACT1');

        const organisms = await page.locator(`${RESULTS} em`).allInnerTexts();
        // Several candidates, and they are genuinely different organisms rather
        // than one organism's several databases.
        expect(organisms.length).toBeGreaterThan(1);
        expect(new Set(organisms).size).toBeGreaterThan(1);
        expect(organisms).toContain('Saccharomyces cerevisiae');
        expect(organisms.some((o) => /^Candida /.test(o))).toBe(true);
    });

    test('choosing an organism loads that organism, not the first match', async ({ page }) => {
        test.setTimeout(120 * 1000);
        await gotoSearch(page, '/blast/SGD/R64-5-1f/');
        await search(page, 'ACT1');

        // The first candidate is NOT S. cerevisiae -- that is the bug this box
        // exists to fix, so assert it rather than assume the order.
        const first = await page.locator(`${RESULTS} em`).first().innerText();
        expect(first).not.toBe('Saccharomyces cerevisiae');

        await page.locator(RESULTS, { has: page.locator('em', { hasText: 'Saccharomyces cerevisiae' }) })
            .first().locator('button').click();

        await expect(page.locator(S.sequence)).toHaveValue(YEAST_ACT1, { timeout: 30 * 1000 });
        // ...and nothing is selected for them. The database a sequence came
        // FROM is rarely the one anyone wants to search it against, so choosing
        // a gene fills the query box and leaves the database choice alone.
        await expect(page.locator(`${S.databaseCheckboxChecked}`)).toHaveCount(0);
    });

    test('both sequence types are searched, not just the selected one', async ({ page }) => {
        test.setTimeout(120 * 1000);
        // WormBase carries symbols only on its protein databases; its
        // nucleotide sets are genome assemblies with no locus=.
        await gotoSearch(page, '/blast/WB/WS298/');
        await search(page, 'unc-54');

        const types = await page.locator(`${RESULTS} span.ml-auto`).allInnerTexts();
        expect(types).toContain('protein');
    });

    test('a single-character symbol is searchable', async ({ page }) => {
        test.setTimeout(120 * 1000);
        // FlyBase has 17 of them -- w, y, a, d, e, f and the rest. A minimum
        // query length would make them unreachable on the MOD that asked for
        // this box.
        await gotoSearch(page, '/blast/FB/FB2026_03/');
        await search(page, 'w');

        const organisms = await page.locator(`${RESULTS} em`).allInnerTexts();
        expect(organisms).toContain('Drosophila melanogaster');
    });

    test('a partial symbol finds the genes that start with it', async ({ page }) => {
        test.setTimeout(120 * 1000);
        // The box's first report: typing ACT on FlyBase said no such gene,
        // while Act5C, Actn and the rest sat in the index. Nobody types a
        // symbol exactly, so an exact-match-only lookup reads as broken.
        await gotoSearch(page, '/blast/FB/FB2026_03/');
        await search(page, 'ACT');

        const symbols = await page.locator(`${RESULTS} strong`).allInnerTexts();
        expect(symbols.length).toBeGreaterThan(0);
        expect(symbols.every((sym) => sym.toLowerCase().startsWith('act'))).toBe(true);
        // Something longer than the query, i.e. this really is a prefix search.
        expect(symbols.some((sym) => sym.length > 'act'.length)).toBe(true);
    });

    test('an exact match is listed before longer symbols that share its prefix', async ({ page }) => {
        test.setTimeout(120 * 1000);
        // WormBase has unc-5 as well as unc-50, unc-51, unc-54 and more. The
        // gene someone typed in full must not be pushed below the ones that
        // merely start the same way.
        await gotoSearch(page, '/blast/WB/WS298/');
        await search(page, 'unc-5');

        const symbols = await page.locator(`${RESULTS} strong`).allInnerTexts();
        expect(symbols.length).toBeGreaterThan(1);
        expect(symbols[0].toLowerCase()).toBe('unc-5');
    });

    test('one database cannot fill the list and crowd out the others', async ({ page }) => {
        test.setTimeout(120 * 1000);
        // Reported: searching "w" on FlyBase returned fifty protein hits and
        // never reached the transcripts, so the box looked as though FlyBase
        // had no nucleotide genes at all. The cap is per database now, and an
        // exact hit is exempt from it entirely.
        await gotoSearch(page, '/blast/FB/FB2026_03/');
        await search(page, 'w');

        const types = await page.locator(`${RESULTS} span.ml-auto`).allInnerTexts();
        expect(types).toContain('protein');
        expect(types).toContain('nucleotide');

        // Both exact matches survive, one per database, however many near
        // misses share the prefix.
        const symbols = await page.locator(`${RESULTS} strong`).allInnerTexts();
        expect(symbols.filter((sym) => sym.toLowerCase() === 'w').length).toBe(2);
    });

    test("a symbol is shown with the source database's own capitalisation", async ({ page }) => {
        test.setTimeout(120 * 1000);
        // Index keys are lower-cased so a lookup can be case-insensitive, and
        // the list was showing those keys: Dll came back as "dll", CG2759 as
        // "cg2759". The spellings live in a companion file beside each index.
        //
        // The rest of this suite compares symbols case-insensitively, so none
        // of it would notice this regressing.
        await gotoSearch(page, '/blast/FB/FB2026_03/');
        await search(page, 'Dll');

        const symbols = await page.locator(`${RESULTS} strong`).allInnerTexts();
        expect(symbols).toContain('Dll');
        expect(symbols).not.toContain('dll');
    });

    test('an all-caps symbol is not lower-cased either', async ({ page }) => {
        test.setTimeout(120 * 1000);
        // SGD writes its symbols in caps, so every one of them was affected:
        // the box answered ACT1 with "act1".
        await gotoSearch(page, '/blast/SGD/R64-5-1m/');
        await search(page, 'ACT1');

        const symbols = await page.locator(`${RESULTS} strong`).allInnerTexts();
        expect(symbols).toContain('ACT1');
    });

    test('a name the source spells in lower case stays lower case', async ({ page }) => {
        test.setTimeout(120 * 1000);
        // The companion file carries only the names whose spelling differs from
        // the key, so the fallback is the key itself. FlyBase's current name for
        // FBgn0003996 is "white", lower case, and it must not be title-cased on
        // the way out just because a "White" synonym also exists.
        await gotoSearch(page, '/blast/FB/FB2026_03/');
        await search(page, 'white');

        const symbols = await page.locator(`${RESULTS} strong`).allInnerTexts();
        expect(symbols).toContain('white');
        expect(symbols).not.toContain('White');
    });

    test('a symbol nothing carries says so rather than failing silently', async ({ page }) => {
        test.setTimeout(120 * 1000);
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        await gotoSearch(page, '/blast/SGD/R64-5-1m/');
        await page.fill(BOX, 'ZZZNOTAREALGENE123');

        await expect(page.locator('#gene-search')).toContainText('No gene starting with', { timeout: 30 * 1000 });
        // ...and says what the box does match. This used to assert the hint
        // "try the symbol rather than the full name", which was true when only
        // deflines were indexed and became wrong once FlyBase's synonym table
        // was joined in: full names are searchable now.
        await expect(page.locator('#gene-search')).toContainText('start of a gene');
        await expect(page.locator(RESULTS)).toHaveCount(0);
        // The query box is untouched and the page still works.
        await expect(page.locator(S.sequence)).toHaveValue('');
        expect(pageErrors).toEqual([]);
    });
});
