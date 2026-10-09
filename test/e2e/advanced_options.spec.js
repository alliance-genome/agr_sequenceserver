// The advanced-options reference dialog.
//
// Worth a spec because the dialog had become unreachable and nothing noticed.
// views/search.erb rendered it, search.js wired its close button, and
// Options#showAdvancedOptionsHelp picked the right algorithm's block and called
// showModal -- but no element called showAdvancedOptionsHelp, so there was no
// way to open it from the UI at all. Only the constructor's `bind` was left to
// suggest a trigger had ever existed.
//
// public/js/tests/form.spec.js asserts the trigger renders, but it renders
// <Form> alone: the dialog lives in the ERB layout, so a unit test cannot tell
// whether clicking the trigger actually opens anything. That is what this
// covers.

const { test, expect } = require('@playwright/test');
const { gotoSearch, selectDatabaseByTitle, databaseTitles } = require('./helpers/app');
const S = require('./helpers/selectors');

const TRIGGER = '[data-target="#help"]';
const DIALOG = 'dialog.advanced-modal';
const METHOD_BLOCKS = ['blastn', 'blastp', 'blastx', 'tblastn', 'tblastx'];

// `dialog` has no visible/hidden class to assert on -- open-ness is the
// element's own property.
const isOpen = (page) => page.locator(DIALOG).evaluate((d) => d.open);

// Which per-algorithm option blocks are currently shown. The dialog holds one
// per method and hides all but the selected one.
const visibleBlocks = (page) => page.evaluate((ids) => ids.filter(
    (id) => document.getElementById(id)
        && !document.getElementById(id).classList.contains('hidden')
), METHOD_BLOCKS);

test.describe('advanced options dialog', () => {
    test('is not offered until an algorithm is known', async ({ page }) => {
        await gotoSearch(page, '/blast/WB/WS298/');

        // No query and no database means no method, and the dialog would have
        // nothing to show, so the trigger must be absent...
        await expect(page.locator(TRIGGER)).toHaveCount(0);
        // ...while the dialog itself is in the page, closed.
        await expect(page.locator(DIALOG)).toHaveCount(1);
        expect(await isOpen(page)).toBe(false);
    });

    test('opens on the selected algorithm, and closes again', async ({ page }) => {
        test.setTimeout(120 * 1000);
        await gotoSearch(page, '/blast/WB/WS298/');

        // A nucleotide query against a nucleotide database resolves to blastn.
        await page.fill(S.sequence, 'ATGCGTAAAGGTGAACGTCTGAAAGAAGCTGAAGAACGTGCTGAAGCTGCT');
        const titles = await databaseTitles(page, 'nucleotide');
        await selectDatabaseByTitle(page, titles[0], S.nucleotideTree);
        await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(1);

        // The trigger names the method, so it is wrong if it appears before one
        // is known or names the wrong one.
        await expect(page.locator(TRIGGER)).toBeVisible({ timeout: 30 * 1000 });
        await expect(page.locator(TRIGGER)).toHaveText(/blastn/i);

        await page.locator(TRIGGER).click();
        expect(await isOpen(page)).toBe(true);
        // Exactly the selected algorithm's options, not all five.
        expect(await visibleBlocks(page)).toEqual(['blastn']);

        await page.locator('button.advanced-modal-close').click();
        expect(await isOpen(page)).toBe(false);
    });
});
