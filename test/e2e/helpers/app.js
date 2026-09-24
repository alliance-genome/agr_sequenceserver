// Shared page drivers for the AGR SequenceServer browser suite.
//
// Use these instead of hand-rolling interactions: the jstree and BLAST-timing
// details below are easy to get subtly wrong, and a spec that gets them wrong
// tends to pass for the wrong reason.

const { expect } = require('@playwright/test');
const S = require('./selectors');

// A BLAST run on dev takes 10-20s; allow a lot more headroom than that.
const BLAST_TIMEOUT = 180 * 1000;

/**
 * Load a MOD search page and wait until React has actually booted.
 * Always use this rather than a bare page.goto -- it is what distinguishes
 * "the app works" from "the server returned some HTML".
 */
async function gotoSearch(page, path) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(S.sequence)).toBeVisible();
    // jstree has rendered once anchors exist.
    await expect(page.locator(`${S.anyTree} ${S.treeAnchor}`).first()).toBeVisible();
    return page;
}

/** Click a "Try an example" button by its visible label (string or RegExp). */
async function clickExample(page, name) {
    await page.locator(S.exampleRow).getByRole('button', { name }).click();
    // The example fills the textarea and selects a database; wait for both.
    await expect(page.locator(S.sequence)).not.toHaveValue('');
    await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(1);
}

/** Fully expand a tree so every leaf is reachable. jstree lazily renders. */
async function expandTree(page, treeSelector) {
    // Expanding can reveal further closed nodes, so iterate to a fixed point.
    for (let i = 0; i < 6; i++) {
        const opened = await page.evaluate(({ tree, toggle }) => {
            const nodes = document.querySelectorAll(`${tree} ${toggle}`);
            nodes.forEach((n) => n.click());
            return nodes.length;
        }, { tree: treeSelector, toggle: S.treeClosedToggle });
        if (opened === 0) break;
        await page.waitForTimeout(400);
    }
}

/**
 * Click one jstree LEAF by its visible title, inside one specific tree.
 * Assumes the leaf is already rendered -- call expandTree first, or use
 * selectDatabaseByTitle, which does that for you.
 *
 * Clicking the jstree anchor is the only reliable way to toggle a selection:
 * clicking the hidden databases[] input does not drive jstree's model and
 * leaves the visible widget out of sync with the form.
 *
 * Scope to ONE tree. jstree reuses node ids across both trees (a "Brugia" <li>
 * exists in the nucleotide tree AND the protein tree), so an unscoped lookup is
 * ambiguous.
 */
async function clickDatabaseLeaf(page, treeSelector, title) {
    const clicked = await page.evaluate(({ tree, leafAnchor, want }) => {
        const a = Array.from(document.querySelectorAll(`${tree} ${leafAnchor}`))
            .find((x) => x.innerText.trim() === want);
        if (!a) return false;
        a.click();
        return true;
    }, { tree: treeSelector, leafAnchor: S.treeLeafAnchor, want: title });
    expect(clicked, `database titled "${title}" not found in ${treeSelector}`).toBe(true);
    // handleLoadTree debounces the jstree -> form sync through two 100ms timers;
    // give it room before reading the hidden checkboxes back.
    await page.waitForTimeout(1200);
}

/**
 * Select a database by its VISIBLE TITLE (e.g. 'Nuclear_chromosomes').
 * Databases are matched by title, not by id -- ids are per-deployment md5s.
 * Expands the tree first, because jstree renders leaves lazily.
 */
async function selectDatabaseByTitle(page, title, treeSelector = S.nucleotideTree) {
    await expandTree(page, treeSelector);
    await clickDatabaseLeaf(page, treeSelector, title);
}

/**
 * Deselect every currently checked database.
 * Works by title: read each checked box's label, then click the matching
 * jstree anchor -- clicking the hidden input itself would not update jstree.
 */
async function clearDatabases(page) {
    const titles = await checkedDatabaseTitles(page);
    for (const title of titles) {
        await page.evaluate(({ leafAnchor, want }) => {
            const a = Array.from(document.querySelectorAll(leafAnchor))
                .find((x) => x.innerText.trim() === want);
            if (a) a.click();
        }, { leafAnchor: `${S.anyTree} ${S.treeLeafAnchor}`, want: title });
        await page.waitForTimeout(300);
    }
    await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(0);
}

/**
 * Every database the form offers, as its TITLE, in DOM order.
 * Read from the hidden source list (ul.databases > li > label.database), which
 * holds the real form controls; the jstree widget is only a mirror of it.
 * Titles, not ids: ids are per-deployment md5 hashes and worthless as fixtures.
 */
function databaseTitles(page) {
    return page.evaluate(
        (labelSel) => Array.from(document.querySelectorAll(labelSel)).map((l) => l.textContent.trim()),
        S.databaseLabel
    );
}

/**
 * Read the checked databases back as their titles.
 * The title is the text of the enclosing label.database in the hidden source
 * list -- checked boxes are NOT inside the jstree widget.
 */
function checkedDatabaseTitles(page) {
    return page.evaluate(({ checkedSel, labelSel }) => Array.from(document.querySelectorAll(checkedSel))
        .map((cb) => {
            const label = cb.closest(labelSel);
            return label ? label.textContent.trim() : null;
        }), { checkedSel: S.databaseCheckboxChecked, labelSel: S.databaseLabel });
}

/**
 * The checked databases as {title, type} -- type being data-type, i.e.
 * "nucleotide" or "protein". The form picks the BLAST method from that
 * attribute, so it is the cheapest way to assert which KIND of database a
 * click actually selected.
 */
function checkedDatabases(page) {
    return page.evaluate(({ checkedSel, labelSel }) => Array.from(document.querySelectorAll(checkedSel))
        .map((cb) => {
            const label = cb.closest(labelSel);
            return { title: label ? label.textContent.trim() : null, type: cb.dataset.type };
        }), { checkedSel: S.databaseCheckboxChecked, labelSel: S.databaseLabel });
}

/**
 * Submit the search and wait for real hits to render.
 * On success the URL becomes /blast/:mod/:version/<job-uuid>.
 */
async function runBlast(page) {
    await expect(page.locator(S.submit)).toBeEnabled();
    await page.locator(S.submit).click();
    // S.hit is "div.hit": a bare ".hit" would also match <polygon class="hit">
    // in the graphical-overview SVG, which appears before the hit list.
    await page.waitForSelector(S.hit, { timeout: BLAST_TIMEOUT });
    await waitForHitsToSettle(page);
    await expect(page).toHaveURL(/\/blast\/[^/]+\/[^/]+\/[0-9a-f-]{36}$/);
}

/**
 * Wait until the hit list stops growing.
 *
 * hits.js renders in 25ms batches, so waitForSelector('.hit') returns on the
 * FIRST hit and any count taken straight afterwards is racy and low. Poll until
 * the count holds steady rather than sleeping a guessed interval -- a fixed
 * sleep is simultaneously too long for a 3-hit result and too short for a
 * 100-hit one.
 */
async function waitForHitsToSettle(page, { stableFor = 3, interval = 300 } = {}) {
    let last = -1;
    let stable = 0;
    const deadline = Date.now() + 60 * 1000;
    while (Date.now() < deadline) {
        const count = await page.locator(S.hit).count();
        stable = count === last ? stable + 1 : 0;
        last = count;
        if (count > 0 && stable >= stableFor) return count;
        await page.waitForTimeout(interval);
    }
    return last;
}

module.exports = {
    BLAST_TIMEOUT,
    gotoSearch,
    clickExample,
    expandTree,
    clickDatabaseLeaf,
    selectDatabaseByTitle,
    clearDatabases,
    databaseTitles,
    checkedDatabaseTitles,
    checkedDatabases,
    runBlast,
    waitForHitsToSettle,
    S
};
