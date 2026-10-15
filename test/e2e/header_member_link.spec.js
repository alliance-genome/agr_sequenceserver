// The member logo in the page header, and where it points.
//
// layout.erb builds the href from the URL's MOD segment through a seven-entry
// map, and its else branch used to answer the segment itself. So the
// Alliance-wide deployment linked alliancegenome.org/members/ALLIANCE, a
// member page for something that is not a member, under the Alliance's own
// logo, on every page it serves.
//
// Asserted here rather than in cross_mod.spec.js because this is about one
// element's href on every deployment, including the two that are not members.

const { test, expect } = require('@playwright/test');
const { gotoSearch } = require('./helpers/app');
const S = require('./helpers/selectors');

const DEPLOYMENTS = [
    ['/blast/WB/WS298/', 'https://www.alliancegenome.org/members/wormbase'],
    ['/blast/FB/FB2026_03/', 'https://www.alliancegenome.org/members/flybase'],
    ['/blast/SGD/R64-5-1m/', 'https://www.alliancegenome.org/members/sgd'],
    ['/blast/SGD/R64-5-1f/', 'https://www.alliancegenome.org/members/sgd'],
    ['/blast/RGD/8.3.0/', 'https://www.alliancegenome.org/members/rgd'],
    ['/blast/ZFIN/zfintest/', 'https://www.alliancegenome.org/members/zfin'],
    // Not a member. It is all of them.
    ['/blast/ALLIANCE/9.1.0/', 'https://www.alliancegenome.org'],
];

for (const [path, href] of DEPLOYMENTS) {
    test(`the header logo at ${path} links ${href}`, async ({ page }) => {
        test.setTimeout(120 * 1000);
        await gotoSearch(page, path);

        const link = page.locator(`a:has(${S.memberLogo})`);
        await expect(link).toHaveCount(1);
        await expect(link).toHaveAttribute('href', href);
    });
}

test('no deployment links a member page built from its URL segment', async ({ page }) => {
    test.setTimeout(180 * 1000);
    // The seven member slugs are lowercase words. A segment leaking through
    // would show as an uppercase MOD code in the path.
    for (const [path] of DEPLOYMENTS) {
        await gotoSearch(page, path);
        const href = await page.locator(`a:has(${S.memberLogo})`).getAttribute('href');
        expect(href, path).not.toMatch(/\/members\/[A-Z]/);
    }
});
