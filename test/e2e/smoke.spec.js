// Stack smoke test.
//
// The whole point of this spec is to prove that the browser really loaded the
// page's CSS and JavaScript and that the React app BOOTED. If assets fail to
// load (the classic symptom of pointing the suite at http://localhost:4569,
// where layout.erb emits unreachable https://localhost:4569/... asset URLs),
// #sequence and the database trees never appear and this spec fails loudly --
// which is exactly what we want, rather than a green suite full of hollow
// HTTP-200 assertions.
//
// If this spec fails, do not bother debugging any other spec: the harness
// itself is broken.

const { test, expect } = require('@playwright/test');

const SGD_MAIN = '/blast/SGD/R64-5-1m/';

test.describe('stack smoke: React boots on dev', () => {
    test('SGD main page boots React, renders query box and database trees', async ({ page }) => {
        // Fail the test if a page asset 404s or the page throws.
        const failedAssets = [];
        const pageErrors = [];
        page.on('response', (res) => {
            if (res.status() >= 400 && /\/blast\/(css|js)\//.test(res.url())) {
                failedAssets.push(`${res.status()} ${res.url()}`);
            }
        });
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        await page.goto(SGD_MAIN, { waitUntil: 'domcontentloaded' });

        // 1. The React-rendered query textarea exists and is usable.
        const sequence = page.locator('#sequence');
        await expect(sequence).toBeVisible();
        await expect(sequence).toBeEditable();

        // 2. The search form and the submit button rendered. The button starts
        //    disabled -- nothing to BLAST yet -- which is itself proof that
        //    React's state logic is running, not just that HTML was served.
        await expect(page.locator('form#blast')).toBeVisible();
        await expect(page.locator('button#method')).toBeVisible();
        await expect(page.locator('button#method')).toBeDisabled();

        // 3. Both jstree instances rendered. jstree REPLACES the container's
        //    contents with its own markup, so .jstree-anchor nodes prove that
        //    jQuery + jstree actually ran -- a plain div would not have them.
        for (const treeId of ['#nucleotide_database_tree', '#protein_database_tree']) {
            const tree = page.locator(treeId);
            await expect(tree).toHaveClass(/jstree/);
            await expect(tree.locator('.jstree-anchor').first()).toBeVisible();
        }

        // 4. Real, selectable database leaves exist (not just group nodes).
        const dbCheckboxes = page.locator('input.checkbox-database[name="databases[]"]');
        expect(await dbCheckboxes.count()).toBeGreaterThan(0);

        // 5. Stylesheets actually parsed. With no CSS the page still has DOM
        //    but zero usable rules, which is the localhost failure mode.
        const ruleCount = await page.evaluate(() => Array.from(document.styleSheets)
            .reduce((n, s) => {
                try { return n + (s.cssRules ? s.cssRules.length : 0); } catch (e) { return n + 1; }
            }, 0));
        expect(ruleCount).toBeGreaterThan(100);

        expect(failedAssets, `assets failed to load:\n${failedAssets.join('\n')}`).toEqual([]);
        expect(pageErrors, `page threw:\n${pageErrors.join('\n')}`).toEqual([]);
    });
});
