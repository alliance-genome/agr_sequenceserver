// The Alliance-wide deployment has to name the organism a hit came from.
//
// It is the one thing a cross-species search is for, and until NCBI's taxdb was
// installed in the image it was impossible: BLAST writes "N/A" into the
// sscinames column of every row when it cannot resolve a taxid, and the front
// end hid its Species column unless EVERY hit had a name. So a curator could
// run a nine-genome tblastn and get back 131 hits labelled only by chromosome
// -- and four of the nine genomes have a chromosome "1".

const { test, expect } = require('@playwright/test');
const {
    gotoSearch, selectDatabaseByTitle, runBlast, databaseTitles, BLAST_TIMEOUT, S
} = require('./helpers/app');

// Human beta-actin. Conserved far enough to hit every one of the nine genomes
// on its own, which is what makes it a usable probe for this.
const ACTB =
    'MDDDIAALVVDNGSGMCKAGFAGDDAPRAVFPSIVGRPRHQGVMVGMGQKDSYVGDEAQSKRGILTLKYPIEHG' +
    'IVTNWDDMEKIWHHTFYNELRVAPEEHPVLLTEAPLNPKANREKMTQIMFETFNTPAMYVAIQAVLSLYASGRT' +
    'TGIVMDSGDGVTHTVPIYEGYALPHAILRLDLAGRDLTDYLMKILTERGYSFTTTAEREIVRDIKEKLCYVALD' +
    'FENEMATAASSSSLEKSYELPDGQVITIGNERFRCPEALFQPSFLGMESCGIHETTFNSIMKCDVDIRKDLYAN' +
    'TVLSGGTTMYPGIADRMQKEITALAPSTMKIKIIAPPERKYSVWIGGSILASLSTFQQMWISKQEYDESGPSIV' +
    'HRKCF';

test.describe('ALLIANCE: a hit names its organism', () => {
    test('a single-genome tblastn labels its hits with that genome\'s species',
        async ({ page }) => {
            test.setTimeout(BLAST_TIMEOUT + 120 * 1000);
            await gotoSearch(page, '/blast/ALLIANCE/prod/');

            // Mouse on its own. Chosen deliberately: in a nine-genome search
            // mouse is crowded out of the result list entirely by
            // -max_target_seqs 100, which is a separate problem (the plan's
            // Step 11) and would make this test flaky if it searched all nine.
            await selectDatabaseByTitle(page, 'Mouse_GRCm39');
            await page.fill(S.sequence, `>ACTB\n${ACTB}`);
            await runBlast(page);

            await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });

            // The Species column appears and says Mus musculus. Before taxdb
            // this column was absent, because no hit had a name.
            await expect(page.locator('table').first()).toContainText('Species');
            await expect(page.locator('table').first()).toContainText('Mus musculus');

            // ...and never the literal "N/A", which is what BLAST emits when it
            // cannot resolve the taxid and is not the name of an organism.
            await expect(page.locator('table').first()).not.toContainText('N/A');
        });

    test('the deployment holds nine genomes to search across', async ({ page }) => {
        await gotoSearch(page, '/blast/ALLIANCE/prod/');
        expect((await databaseTitles(page)).length).toBe(9);
    });

    test('a per-MOD deployment still labels its species', async ({ page }) => {
        // taxdb affects every deployment, not only ALLIANCE, so this checks the
        // change did not stop at the one it was made for.
        test.setTimeout(BLAST_TIMEOUT + 120 * 1000);
        await gotoSearch(page, '/blast/WB/WS298/');

        await selectDatabaseByTitle(page, 'C_elegans_Genome_Assembly');
        await page.fill(S.sequence, `>ACTB\n${ACTB}`);
        await runBlast(page);

        await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });
        await expect(page.locator('table').first()).toContainText('Caenorhabditis elegans');
    });
});
