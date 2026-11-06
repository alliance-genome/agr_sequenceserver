// The genes panel on a hit, and its orthologue expander.
//
// Phase 4 of docs/ALLIANCE_WIDE_PLAN.md: a cross-species BLAST whose hits
// reach coordinates and never a gene is a coordinate lookup. The genes arrive
// on the hit from a per-assembly index; the orthologues are fetched from the
// Alliance API when a gene is expanded.
//
// Needs the gene_index files on the instance's environments volume. Without
// them every hit reports no genes, which is also the correct behaviour for a
// deployment that publishes no index, so the first test distinguishes the two.

const { test, expect } = require('@playwright/test');
const {
    gotoSearch, selectDatabaseByTitle, runBlast, waitForHitsToSettle, BLAST_TIMEOUT, S
} = require('./helpers/app');

// Human beta-actin. Lands on chromosome 5 and 2 among others, both annotated
// in the Alliance human GFF, so it reaches real genes rather than scaffolds.
const ACTB =
    'MDDDIAALVVDNGSGMCKAGFAGDDAPRAVFPSIVGRPRHQGVMVGMGQKDSYVGDEAQSKRGILTLKYPIEHG' +
    'IVTNWDDMEKIWHHTFYNELRVAPEEHPVLLTEAPLNPKANREKMTQIMFETFNTPAMYVAIQAVLSLYASGRT' +
    'TGIVMDSGDGVTHTVPIYEGYALPHAILRLDLAGRDLTDYLMKILTERGYSFTTTAEREIVRDIKEKLCYVALD' +
    'FENEMATAASSSSLEKSYELPDGQVITIGNERFRCPEALFQPSFLGMESCGIHETTFNSIMKCDVDIRKDLYAN' +
    'TVLSGGTTMYPGIADRMQKEITALAPSTMKIKIIAPPERKYSVWIGGSILASLSTFQQMWISKQEYDESGPSIV' +
    'HRKCF';

const PANEL = '.hit-genes';
const ORTHO_BUTTON = 'button[data-orthologues]';

async function searchHumanGenome(page) {
    await gotoSearch(page, '/blast/ALLIANCE/9.2.0/');
    await selectDatabaseByTitle(page, 'Human_GRCh38');
    await page.fill(S.sequence, `>ACTB\n${ACTB}`);
    await runBlast(page);
    await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });
    await waitForHitsToSettle(page);
}

test('a hit on an annotated chromosome names its genes', async ({ page }) => {
    test.setTimeout(BLAST_TIMEOUT + 300 * 1000);
    await searchHumanGenome(page);

    const panels = await page.locator(PANEL).count();
    const hits = await page.locator('div.hit').count();
    // Some hits land on scaffolds the Alliance GFFs do not annotate, so not
    // every hit gets a panel. At least one must, or the index is not loaded.
    expect(panels, 'no genes panel at all: is gene_index on the volume?')
        .toBeGreaterThan(0);
    expect(panels).toBeLessThanOrEqual(hits);

    // Each panel names a gene and its span.
    const first = page.locator(PANEL).first();
    await expect(first).toContainText(/Genes? at this location:/);
    await expect(first).toContainText(/\d{1,3}(,\d{3})*\.\.\d{1,3}(,\d{3})*/);
    console.log(`GENES hits=${hits} panels=${panels}`);
});

test('a gene with a curie links to its Alliance page', async ({ page }) => {
    test.setTimeout(BLAST_TIMEOUT + 300 * 1000);
    await searchHumanGenome(page);

    const link = page.locator(`${PANEL} a[href*="/gene/"]`).first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    // The curie is what joins the two halves: the index carries it and the
    // orthologue API takes it.
    expect(href).toMatch(/alliancegenome\.org\/gene\/HGNC(%3A|:)\d+/);
    console.log(`GENE_LINK ${href}`);
});

test('orthologues are fetched only when asked, and grouped by species', async ({ page }) => {
    test.setTimeout(BLAST_TIMEOUT + 300 * 1000);
    await searchHumanGenome(page);

    // Pin the gene by its curie. `has:` ignores a nested .first(), so filtering
    // divs by the generic button selector matches every gene's div and reads
    // back whichever one happens to be last, which is not the one clicked.
    const curie = await page.locator(ORTHO_BUTTON).first().getAttribute('data-orthologues');
    const button = page.locator(`button[data-orthologues="${curie}"]`);
    const gene = page.locator('div', { has: button }).last();
    await expect(button).toBeVisible();
    // Nothing fetched yet: the label offers, it does not report.
    await expect(button).toHaveText('orthologues');

    await button.click();
    // Either orthologues arrive, or the gene has none, or the API did not
    // answer. All three are legitimate and none may throw.
    await expect(button).toHaveText(/hide \d+ orthologues|orthologues unavailable/, {
        timeout: 60 * 1000,
    });

    const label = await button.innerText();
    if (/unavailable/.test(label)) {
        // The Alliance API is a third party; its being down is not this
        // page's bug, and the page has to say so rather than hang.
        console.log('ORTHO api did not answer, message shown');
        return;
    }

    const text = (await gene.innerText()).replace(/\s+/g, ' ');

    // "hide 0 orthologues" is a legitimate answer and the regex above accepts
    // it, so the zero case is separated here rather than asserted away. The
    // Alliance returns HTTP 200 with total=0 for a gene it holds no orthology
    // for, which is why the status code cannot be the signal.
    if (/hide 0 orthologues/.test(label)) {
        expect(text).toContain('No orthologues recorded.');
        console.log(`ORTHO none for ${curie} | ${text.slice(0, 100)}`);
        return;
    }

    // Species names are the grouping, because the question a cross-species
    // result raises is which organisms carry a counterpart.
    await expect(gene.locator('em')).not.toHaveCount(0);
    expect(text).toMatch(/Mus musculus|Rattus norvegicus|Danio rerio|Homo sapiens|Caenorhabditis|Drosophila|Saccharomyces|Xenopus/);
    console.log(`ORTHO ${label} | ${text.slice(0, 140)}`);

    // And it collapses again.
    await button.click();
    await expect(button).toHaveText('orthologues');
});

test('a gene with orthologues groups them by species', async ({ page }) => {
    test.setTimeout(BLAST_TIMEOUT + 300 * 1000);
    await searchHumanGenome(page);

    // The test above happened to land on RMEL3, a lncRNA the Alliance holds no
    // orthology for, so it exercised the zero path and not the grouping. This
    // one names a gene that has orthologues: ACTBL2 reports 3 (mouse, rat,
    // yeast) and PLEKHB2 reports 6 across five species, measured 2026-11-06.
    const WITH_ORTHOLOGUES = ['HGNC:17780', 'HGNC:19236'];

    let opened = null;
    for (const curie of WITH_ORTHOLOGUES) {
        const button = page.locator(`button[data-orthologues="${curie}"]`);
        if (await button.count() === 0) continue;
        await button.first().click();
        await expect(button.first()).toHaveText(
            /hide \d+ orthologues|orthologues unavailable/, { timeout: 60 * 1000 }
        );
        const label = await button.first().innerText();
        if (/unavailable/.test(label)) {
            console.log(`ORTHO_GROUP api did not answer for ${curie}`);
            return;
        }
        if (!/hide 0 orthologues/.test(label)) {
            opened = { curie, button: button.first(), label };
            break;
        }
    }

    expect(opened, `none of ${WITH_ORTHOLOGUES.join(', ')} is on this result`)
        .not.toBeNull();

    const gene = page.locator('div', { has: opened.button }).last();
    const text = (await gene.innerText()).replace(/\s+/g, ' ');
    // One <em> per species, which is the grouping that answers "which
    // organisms carry a counterpart".
    expect(await gene.locator('em').count()).toBeGreaterThan(0);
    expect(text).toMatch(/Mus musculus|Rattus norvegicus|Danio rerio|Saccharomyces|Xenopus|Drosophila/);
    // Every orthologue is a link to its own Alliance gene page.
    expect(await gene.locator('a[href*="/gene/"]').count()).toBeGreaterThan(1);
    console.log(`ORTHO_GROUP ${opened.curie} ${opened.label} | ${text.slice(0, 150)}`);
});

test('a protein hit gets no genes panel', async ({ page }) => {
    test.setTimeout(BLAST_TIMEOUT + 300 * 1000);
    // Protein coordinates are amino acid offsets. A genomic interval query on
    // those reports whichever gene sits at that base pair, which is why the
    // lookup is off for protein hits, matching the existing gene_track rule.
    await gotoSearch(page, '/blast/WB/WS298/');
    await selectDatabaseByTitle(page, 'C_elegans_Protein_Sequences', S.proteinTree);
    await page.fill(S.sequence, `>ACTB\n${ACTB}`);
    await runBlast(page);
    await expect(page.locator(S.hitById(1, 1))).toBeVisible({ timeout: BLAST_TIMEOUT });

    await expect(page.locator(PANEL)).toHaveCount(0);
});
