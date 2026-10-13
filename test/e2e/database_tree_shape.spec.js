const { test, expect } = require('@playwright/test');
const { gotoSearch } = require('./helpers/app');
const S = require('./helpers/selectors');

const DEPLOYMENTS = [
    ['/blast/ALLIANCE/9.1.0/', 9],
    ['/blast/WB/WS298/', null],
    ['/blast/SGD/R64-5-1m/', null],
];

for (const [path, leaves] of DEPLOYMENTS) {
    test(`tree is open and two deep at ${path}`, async ({ page }) => {
        test.setTimeout(120 * 1000);
        await gotoSearch(page, path);

        // Nothing closed anywhere once the page has loaded.
        await expect(page.locator('.jstree-closed')).toHaveCount(0);

        // Every leaf is visible without clicking, which is the point.
        const checkboxes = await page.locator(S.databaseCheckbox).count();
        expect(checkboxes).toBeGreaterThan(0);
        if (leaves) expect(checkboxes).toBe(leaves);

        // Depth: a database's row sits one folder down, not three.
        const depth = await page.evaluate(() => {
            const anchors = [...document.querySelectorAll('.jstree-anchor')];
            const leafRows = anchors.filter((a) => a.closest('li').classList.contains('jstree-leaf'));
            return Math.max(...leafRows.map((a) => {
                let d = 0;
                let li = a.closest('li');
                while (li) { li = li.parentElement.closest('li'); if (li) d += 1; }
                return d;
            }));
        });
        expect(depth).toBe(1);

        console.log(`PATH=${path} checkboxes=${checkboxes} depth=${depth}`);
    });
}

test('the Alliance example is offered and fills the box', async ({ page }) => {
    test.setTimeout(120 * 1000);
    await gotoSearch(page, '/blast/ALLIANCE/9.1.0/');

    await expect(page.locator(S.exampleRow)).toBeVisible();
    const label = await page.locator(`${S.exampleRow} button`).first().innerText();
    // A protein, so that selecting a genome resolves to tblastn, which is what
    // a nine-genome deployment is for. A nucleotide example found zebrafish
    // and nothing else.
    expect(label).toMatch(/protein|histone|H4/i);
    await page.locator(`${S.exampleRow} button`).first().click();
    await expect(page.locator(S.sequence)).not.toHaveValue('');
    // And selects nothing. This deployment serves nine organisms and exists to
    // search across them, so picking the example's own genome would defeat it
    // and would discard a selection the user had already made.
    await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(0);
    console.log(`EXAMPLE=${label}`);
});

test('the Alliance example leaves a selection the user already made', async ({ page }) => {
    test.setTimeout(120 * 1000);
    await gotoSearch(page, '/blast/ALLIANCE/9.1.0/');

    // Tick two genomes, then click the example. Leaf anchors only: clicking a
    // species folder drives jstree's own cascade rather than one database.
    const leaves = page.locator('#nucleotide_database_tree li.jstree-leaf > a.jstree-anchor');
    await leaves.nth(0).click();
    await leaves.nth(1).click();
    await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(2);

    await page.locator(`${S.exampleRow} button`).first().click();
    await expect(page.locator(S.sequence)).not.toHaveValue('');
    await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(2);
});

test('the Alliance example is a protein, so a genome resolves to tblastn', async ({ page }) => {
    test.setTimeout(120 * 1000);
    await gotoSearch(page, '/blast/ALLIANCE/9.1.0/');

    await page.locator(`${S.exampleRow} button`).first().click();
    await expect(page.locator(S.sequence)).not.toHaveValue('');

    // Tick one genome. The query is protein and the subjects are nucleotide,
    // so the only sensible method is tblastn.
    await page.locator('#nucleotide_database_tree li.jstree-leaf > a.jstree-anchor').first().click();
    await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(1);
    // The submit button carries the resolved method as its value attribute.
    // Its visible text is decorated, and toHaveValue only works on inputs.
    await expect(page.locator(S.submit)).toBeEnabled();
    await expect(page.locator(S.submit)).toHaveAttribute('value', 'tblastn');
});
