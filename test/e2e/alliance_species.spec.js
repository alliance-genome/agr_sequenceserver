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

test.describe('ALLIANCE: an incomplete result says so', () => {
    test('human and mouse together now return both, and are not called incomplete',
        async ({ page }) => {
            test.setTimeout(BLAST_TIMEOUT + 180 * 1000);
            await gotoSearch(page, '/blast/ALLIANCE/prod/');

            // This test used to assert the opposite. Human and mouse both name
            // their chromosomes 1..n, so BLAST conflated the two genomes'
            // chromosome "1" and mouse never appeared at all: a nine-genome
            // tblastn returned 131 hits with no mouse or rat among them, while
            // mouse alone returned 20 at evalue 0.0.
            //
            // The databases are built with seqid_prefix now (GRCh38_1,
            // GRCm39_1), so the ids are distinct and both genomes answer.
            await selectDatabaseByTitle(page, 'Human_GRCh38');
            await selectDatabaseByTitle(page, 'Mouse_GRCm39');
            await page.fill(S.sequence, `>ACTB\n${ACTB}`);
            await runBlast(page);

            await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });

            // Nothing left to warn about.
            await expect(page.locator('#shared-accession-notice')).toHaveCount(0);

            // Both organisms are present, which is the whole point.
            const summary = page.locator('#organism-summary');
            await expect(summary).toContainText('Homo sapiens');
            await expect(summary).toContainText('Mus musculus');
        });

    test('ZFIN is not falsely called incomplete', async ({ page }) => {
        test.setTimeout(BLAST_TIMEOUT + 180 * 1000);
        // A regression this warning shipped with. ZFIN's databases were built
        // without -parse_seqids, so their name indexes hold synthetic
        // "BL_ORD_ID:N" ordinals, numbered from zero in every database.
        // Comparing those found 21 of ZFIN's 21 pairs "colliding" and told the
        // user 40,280 ids were shared, on a search that was complete. A false
        // warning is worse than none: it teaches people to ignore the real one.
        //
        // There is deliberately no test here that the warning DOES fire on
        // live data. Every deployment's real collisions have been fixed by
        // seqid_prefix, so such a test could only pass by finding a bug. The
        // firing behaviour is covered by spec/blast/shared_accessions_spec.rb,
        // which does not depend on a broken deployment existing.
        await gotoSearch(page, '/blast/ZFIN/prod/');

        const titles = await databaseTitles(page);
        await selectDatabaseByTitle(page, titles[0]);
        await selectDatabaseByTitle(page, titles[1]);
        await page.fill(S.sequence,
            '>q\nGATCTTAAACATTTATTCCCCCTGCAAACATTTTCAATCATTACATTGTCATTTCCCCTC' +
            'CAAATTAAATTTAGCCAGAGGCGCACAACATACGACCTCTAAAAAAGGTGCTGTAACATG');
        await runBlast(page);

        // The result may legitimately have no hits; what must not appear is the
        // notice. Waiting on the report container rather than a hit.
        await expect(page.locator('#results')).toBeVisible({ timeout: BLAST_TIMEOUT });
        await expect(page.locator('#shared-accession-notice')).toHaveCount(0);
    });

    test('a single database is never called incomplete', async ({ page }) => {
        test.setTimeout(BLAST_TIMEOUT + 120 * 1000);
        await gotoSearch(page, '/blast/ALLIANCE/prod/');

        await selectDatabaseByTitle(page, 'Human_GRCh38');
        await page.fill(S.sequence, `>ACTB\n${ACTB}`);
        await runBlast(page);

        await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });
        await expect(page.locator('#shared-accession-notice')).toHaveCount(0);
    });

    test('databases that do not share ids are not called incomplete', async ({ page }) => {
        // FlyBase's melanogaster set has no shared accessions at all, measured
        // across every pair. A false warning here would train people to ignore
        // the real one.
        test.setTimeout(BLAST_TIMEOUT + 180 * 1000);
        await gotoSearch(page, '/blast/FB/FB2026_03/');

        await selectDatabaseByTitle(page, 'D_melanogaster_Genome_Assembly_6_69');
        await selectDatabaseByTitle(page, 'D_melanogaster_Transcripts_6_69');
        await page.fill(S.sequence, `>ACTB\n${ACTB}`);
        await runBlast(page);

        await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });
        await expect(page.locator('#shared-accession-notice')).toHaveCount(0);
    });

    test('a multi-organism result lists which organisms answered', async ({ page }) => {
        test.setTimeout(BLAST_TIMEOUT + 180 * 1000);
        await gotoSearch(page, '/blast/ALLIANCE/prod/');

        // Three genomes whose chromosome vocabularies do not overlap, so the
        // result is complete and the summary can be trusted.
        await selectDatabaseByTitle(page, 'C_elegans_Genome_Assembly');
        await selectDatabaseByTitle(page, 'Yeast_R64');
        await page.fill(S.sequence, `>ACTB\n${ACTB}`);
        await runBlast(page);

        await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });
        const summary = page.locator('#organism-summary');
        await expect(summary).toBeVisible();
        await expect(summary).toContainText('Caenorhabditis elegans');
        await expect(summary).toContainText('Saccharomyces cerevisiae');
    });
});
