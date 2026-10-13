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
    await page.locator(`${S.exampleRow} button`).first().click();
    await expect(page.locator(S.sequence)).not.toHaveValue('');
    await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(1);
    console.log(`EXAMPLE=${label}`);
});
