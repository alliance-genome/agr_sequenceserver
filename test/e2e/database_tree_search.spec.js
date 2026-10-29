// The tree widget, searched and folded in a real browser.
//
// The unit spec (public/js/tests/databases_tree.spec.js) covers the matcher.
// What only a browser can show is that jstree acts on the match: hides the
// rest of the tree, keeps a matched folder's databases, and puts everything
// back when the query is cleared.

const { test, expect } = require('@playwright/test');
const { gotoSearch } = require('./helpers/app');

const TREE = '#nucleotide_database_tree';
const SEARCH = '#nucleotide_database_tree_search';

// jstree hides a non-matching node rather than removing it, so count what is
// laid out, not what is in the DOM.
async function visibleLeafTitles(page) {
    return page.evaluate((tree) => {
        return Array.from(document.querySelectorAll(`${tree} li.jstree-leaf`))
            .filter((li) => li.offsetParent !== null)
            .map((li) => li.querySelector('a.jstree-anchor').innerText.trim());
    }, TREE);
}

/**
 * Put a query in the box the way a person does.
 *
 * The widget searches on keyup, so Playwright's fill() sets the value and
 * runs nothing. Type the characters, and clear with Backspace rather than
 * fill(''), which would leave the last search in place.
 */
async function typeQuery(page, query) {
    const box = page.locator(SEARCH);
    await box.click();
    await box.press('Control+a');
    await box.press('Backspace');
    if (query) await box.pressSequentially(query, { delay: 15 });
    await page.waitForTimeout(600);
}

test('a common name finds the genome on the Alliance deployment', async ({ page }) => {
    test.setTimeout(120 * 1000);
    await gotoSearch(page, '/blast/ALLIANCE/9.2.0/');

    const before = await visibleLeafTitles(page);
    expect(before.length).toBe(9);

    // Latin for this tree's folders is "Danio rerio". Nobody types that.
    await typeQuery(page, 'zebrafish');
    expect(await visibleLeafTitles(page)).toEqual(['ZFIN_GRCz12tu']);

    // Clearing the box restores every genome.
    await typeQuery(page, '');
    expect((await visibleLeafTitles(page)).sort()).toEqual(before.sort());
});

test('each Alliance common name finds exactly its own genome', async ({ page }) => {
    test.setTimeout(180 * 1000);
    await gotoSearch(page, '/blast/ALLIANCE/9.2.0/');

    const expected = {
        zebrafish: ['ZFIN_GRCz12tu'],
        human: ['Human_GRCh38'],
        mouse: ['Mouse_GRCm39'],
        rat: ['RGD_GRCr8'],
        yeast: ['Yeast_R64'],
        worm: ['C_elegans_Genome_Assembly'],
        fly: ['Fly_Release_6_plus_ISO1_MT'],
        frog: ['X_laevis_XENLA_10_1', 'X_tropicalis_UCB_Xtro_10_0'],
    };

    for (const [query, want] of Object.entries(expected)) {
        await typeQuery(page, query);
        const got = (await visibleLeafTitles(page)).sort();
        expect(got, `search "${query}"`).toEqual(want.sort());
    }
    console.log(`SEARCHED=${Object.keys(expected).length} queries, each found its genome`);
});

test('a common name finds a group on WormBase, through the species folder', async ({ page }) => {
    test.setTimeout(180 * 1000);
    await gotoSearch(page, '/blast/WB/WS298/');

    const before = await visibleLeafTitles(page);
    expect(before.length).toBeGreaterThan(20);

    // "worm" covers all nine genera WormBase serves (Caenorhabditis, Brugia,
    // Onchocerca, Oscheius, Panagrellus, Pristionchus, Steinernema,
    // Strongyloides, Trichuris), so on this deployment it matches everything.
    // Their databases follow from show_only_matches_children: a leaf titled
    // C_elegans_Genome_Assembly carries no genus name of its own.
    await typeQuery(page, 'worm');
    const worms = await visibleLeafTitles(page);
    expect(worms.sort()).toEqual(before.slice().sort());

    // A narrower common name picks out two genera and nothing else.
    await typeQuery(page, 'filarial worm');
    const filarial = await visibleLeafTitles(page);
    expect(filarial.length).toBeGreaterThan(0);
    expect(filarial.length).toBeLessThan(worms.length);

    // A species name still works, and is narrower again.
    await typeQuery(page, 'briggsae');
    const briggsae = await visibleLeafTitles(page);
    expect(briggsae.length).toBeGreaterThan(0);
    expect(briggsae.length).toBeLessThan(filarial.length + worms.length);

    // And a common name from another deployment matches nothing here, which
    // shows as an empty tree and a message, not as the whole tree.
    await typeQuery(page, 'zebrafish');
    expect(await visibleLeafTitles(page)).toEqual([]);
    await expect(page.locator('#nucleotide_search_miss')).toContainText('zebrafish');

    // Clearing it brings the tree back.
    await typeQuery(page, '');
    expect((await visibleLeafTitles(page)).sort()).toEqual(before.slice().sort());
    await expect(page.locator('#nucleotide_search_miss')).toHaveCount(0);
    console.log(`WB all=${before.length} worm=${worms.length} filarial=${filarial.length} briggsae=${briggsae.length}`);
});

test('expand all and collapse all drive the whole tree', async ({ page }) => {
    test.setTimeout(120 * 1000);
    await gotoSearch(page, '/blast/WB/WS298/');

    // The tree arrives open, which is what #51 changed.
    await expect(page.locator(`${TREE} .jstree-closed`)).toHaveCount(0);
    const before = await visibleLeafTitles(page);
    expect(before.length).toBeGreaterThan(20);

    await page.locator('#nucleotide_collapse_all').click();
    await page.waitForTimeout(600);
    expect(await page.locator(`${TREE} .jstree-closed`).count()).toBeGreaterThan(0);
    expect(await visibleLeafTitles(page)).toEqual([]);

    await page.locator('#nucleotide_expand_all').click();
    await page.waitForTimeout(600);
    await expect(page.locator(`${TREE} .jstree-closed`)).toHaveCount(0);
    expect((await visibleLeafTitles(page)).length).toBe(before.length);
});
