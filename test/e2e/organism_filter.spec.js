// Switching one organism's hits off a cross-species result.
//
// The summary line already said which organisms answered and with how many
// hits. What it could not do was get one of them out of the way: a result
// spanning nine genomes is read one organism at a time, and BLAST ranks
// globally, so the rows of any one genome are scattered through the list.
//
// Each switch hides rows that are already on the page. It changes nothing
// about the search and recovers nothing BLAST did not report, which matters
// because the two are easy to confuse on this deployment.

const { test, expect } = require('@playwright/test');
const {
    gotoSearch, selectDatabaseByTitle, runBlast, BLAST_TIMEOUT, S
} = require('./helpers/app');

// Human beta-actin, conserved far enough to answer in every genome here.
const ACTB =
    'MDDDIAALVVDNGSGMCKAGFAGDDAPRAVFPSIVGRPRHQGVMVGMGQKDSYVGDEAQSKRGILTLKYPIEHG' +
    'IVTNWDDMEKIWHHTFYNELRVAPEEHPVLLTEAPLNPKANREKMTQIMFETFNTPAMYVAIQAVLSLYASGRT' +
    'TGIVMDSGDGVTHTVPIYEGYALPHAILRLDLAGRDLTDYLMKILTERGYSFTTTAEREIVRDIKEKLCYVALD' +
    'FENEMATAASSSSLEKSYELPDGQVITIGNERFRCPEALFQPSFLGMESCGIHETTFNSIMKCDVDIRKDLYAN' +
    'TVLSGGTTMYPGIADRMQKEITALAPSTMKIKIIAPPERKYSVWIGGSILASLSTFQQMWISKQEYDESGPSIV' +
    'HRKCF';

const TOGGLE = '#organism-summary button[data-organism-toggle]';

/** Hits and HSPs the browser is actually laying out. */
async function visibleRows(page) {
    return page.evaluate(() => {
        const laid = (sel) => Array.from(document.querySelectorAll(sel))
            .filter((el) => el.offsetParent !== null);
        return { hits: laid('div.hit').length, hsps: laid('div.hsp').length };
    });
}

async function visibleHitsOf(page, organism) {
    return page.evaluate((name) => {
        return Array.from(document.querySelectorAll(`div.hit[data-organism="${name}"]`))
            .filter((el) => el.offsetParent !== null).length;
    }, organism);
}

test('one organism can be switched out of a cross-species result', async ({ page }) => {
    test.setTimeout(BLAST_TIMEOUT + 240 * 1000);
    await gotoSearch(page, '/blast/ALLIANCE/9.1.0/');

    // Human and mouse. Both name their chromosomes 1..n, so this pair was the
    // one BLAST used to conflate; they are built with seqid_prefix now and
    // both answer.
    await selectDatabaseByTitle(page, 'Human_GRCh38');
    await selectDatabaseByTitle(page, 'Mouse_GRCm39');
    await page.fill(S.sequence, `>ACTB\n${ACTB}`);
    await runBlast(page);
    await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });

    // Every hit carries its organism, which is what the filter selects on.
    const tagged = await page.locator('div.hit[data-organism]').count();
    const allHits = await page.locator('div.hit').count();
    expect(tagged).toBe(allHits);

    const before = await visibleRows(page);
    expect(before.hits).toBeGreaterThan(1);
    expect(before.hsps).toBeGreaterThan(0);

    const human = await visibleHitsOf(page, 'Homo sapiens');
    const mouse = await visibleHitsOf(page, 'Mus musculus');
    expect(human).toBeGreaterThan(0);
    expect(mouse).toBeGreaterThan(0);

    // Switch human off.
    await page.locator('#organism-summary button[data-organism-toggle="Homo sapiens"]').click();
    await expect(page.locator('#organism-filter-note')).toContainText('1 organism hidden');
    expect(await visibleHitsOf(page, 'Homo sapiens')).toBe(0);
    expect(await visibleHitsOf(page, 'Mus musculus')).toBe(mouse);

    // The HSP blocks go with it. They are siblings of their hit in the
    // rendered list, so a filter on hits alone would leave them behind.
    const filtered = await visibleRows(page);
    expect(filtered.hits).toBe(before.hits - human);
    expect(filtered.hsps).toBeLessThan(before.hsps);

    // And back again.
    await page.locator('#organism-summary button[data-organism-toggle="Homo sapiens"]').click();
    await expect(page.locator('#organism-filter-note')).toHaveCount(0);
    expect(await visibleRows(page)).toEqual(before);
    console.log(`FILTER human=${human} mouse=${mouse} hits=${before.hits} hsps=${before.hsps}`);
});

test('the switches are absent from a single-organism result', async ({ page }) => {
    test.setTimeout(BLAST_TIMEOUT + 180 * 1000);
    await gotoSearch(page, '/blast/ALLIANCE/9.1.0/');

    await selectDatabaseByTitle(page, 'Human_GRCh38');
    await page.fill(S.sequence, `>ACTB\n${ACTB}`);
    await runBlast(page);
    await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });

    // Nothing to compare against, so the summary does not render at all and
    // the report looks exactly as it did before this change.
    await expect(page.locator('#organism-summary')).toHaveCount(0);
    await expect(page.locator(TOGGLE)).toHaveCount(0);
    // The hits still carry the attribute; only the control is withheld.
    expect(await page.locator('div.hit[data-organism="Homo sapiens"]').count())
        .toBeGreaterThan(0);
});

// Not tested in a browser: the per-organism distribution over all nine
// genomes. That tblastn takes 4m56 on this host, measured 2026-10-15, which is
// well past this suite's 180s BLAST timeout. It was run through the JSON API
// instead and recorded in docs/ALLIANCE_WIDE_PLAN.md step 11: 124 hits, all
// nine organisms answering, the largest contributing 29. The human-and-mouse
// test above covers the filter itself, and that pair is the one BLAST used to
// conflate.
