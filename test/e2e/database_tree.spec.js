// Database tree regression tests (shipped feature #7).
//
// Covers what only a browser can see about the jstree database picker:
//   * the usage hint renders exactly once per database category, and is visible;
//   * collapsed groups really expand -- jstree renders children lazily, so the
//     child <li>s do not exist in the DOM at all until the arrow is clicked;
//   * ticking a node in the visible jstree widget checks the matching
//     databases[] input in the hidden source list (the two parallel DOM copies
//     stay in sync);
//   * cross-category constraint: the app enforces "one sequence type at a time"
//     by UNCHECKING the other category and DISABLING/greying its [Select all].
//
// Read the header of helpers/selectors.js first. The two facts that matter most
// here: the real form controls live in a hidden <ul class="databases hidden">,
// so they are never visible and must be asserted on :checked/count; and a
// selection can only be changed by clicking the jstree anchor, never the input.

const { test, expect } = require('@playwright/test');
const {
    gotoSearch, expandTree, clickDatabaseLeaf, checkedDatabases, S
} = require('./helpers/app');

// MODs that render BOTH a nucleotide and a protein tree. (RGD/ZFIN/ALLIANCE
// render only one, so the cross-category assertions below do not apply there.)
const MODS = [
    {
        name: 'SGD R64-5-1f',
        path: '/blast/SGD/R64-5-1f/',
        nucleotideDb: 'S_cerevisiae_Coding_Sequences',
        proteinDb: 'S_cerevisiae_Protein_Sequences',
        nucleotideCount: 208,
        proteinCount: 104
    },
    {
        name: 'WB WS298',
        path: '/blast/WB/WS298/',
        nucleotideDb: 'C_elegans_Genome_Assembly',
        proteinDb: 'C_elegans_Protein_Sequences',
        nucleotideCount: 32,
        proteinCount: 31
    }
];

/**
 * State of the per-category "[Select all]" buttons, in DOM order.
 *
 * `visible` matters: the class names below describe how the one-sequence-type-
 * at-a-time constraint is signalled, and that signal means nothing if the
 * button is not on screen. It used to be `display:none` in every state, because
 * databases_tree.js baked `hidden` into the base class.
 */
function selectAllButtons(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('button'))
        .filter((b) => /\[(Select|Deselect) all\]/.test(b.textContent))
        .map((b) => ({
            text: b.textContent.trim(),
            visible: b.offsetParent !== null,
            disabled: b.disabled,
            greyed: b.className.includes('text-gray-400'),
            blue: b.className.includes('text-seqblue')
        })));
}

for (const mod of MODS) {
    test.describe(`database tree - ${mod.name}`, () => {
        test(`hint text renders once per category and is visible (${mod.name})`, async ({ page }) => {
            await gotoSearch(page, mod.path);

            const hint = page.getByText(S.treeHintText, { exact: true });

            // Both MODs here render two categories, so the hint must appear
            // exactly twice -- once under each tree. A single occurrence would
            // mean one category lost its hint; three would mean duplication.
            await expect(hint).toHaveCount(2);
            await expect(page.locator(S.anyTree)).toHaveCount(2);

            for (let i = 0; i < 2; i++) {
                await expect(hint.nth(i)).toBeVisible();
            }

            // Structural proof of "once PER CATEGORY": every tree must be
            // immediately preceded by its own hint paragraph. This fails if the
            // hint is duplicated inside one category or hoisted above both.
            const pairing = await page.evaluate(({ treeSel, text }) => Array.from(document.querySelectorAll(treeSel))
                .map((tree) => {
                    const prev = tree.previousElementSibling;
                    return {
                        tree: tree.id,
                        precededByHint: !!prev && prev.tagName === 'P' && prev.textContent.trim() === text,
                        hintsInsideTree: Array.from(tree.querySelectorAll('p'))
                            .filter((p) => p.textContent.trim() === text).length
                    };
                }), { treeSel: S.anyTree, text: S.treeHintText });

            expect(pairing).toEqual([
                { tree: 'nucleotide_database_tree', precededByHint: true, hintsInsideTree: 0 },
                { tree: 'protein_database_tree', precededByHint: true, hintsInsideTree: 0 }
            ]);
        });

        test(`a collapsed group expands to reveal children that were not rendered before (${mod.name})`, async ({ page }) => {
            await gotoSearch(page, mod.path);

            const tree = page.locator(S.nucleotideTree);

            // Pick the first group that is collapsed AND has no children in the
            // DOM at all -- jstree renders lazily, which is the property under
            // test. Record the "before" picture.
            const before = await page.evaluate((treeSel) => {
                const t = document.querySelector(treeSel);
                const node = Array.from(t.querySelectorAll('li.jstree-closed'))
                    .find((n) => n.querySelectorAll('li').length === 0);
                if (!node) return null;
                return {
                    id: node.id,
                    title: node.querySelector('.jstree-anchor').innerText.trim(),
                    descendantItems: node.querySelectorAll('li').length,
                    anchorsInTree: t.querySelectorAll('.jstree-anchor').length
                };
            }, S.nucleotideTree);

            expect(before, 'expected at least one collapsed, unrendered group').not.toBeNull();
            expect(before.descendantItems).toBe(0);

            // NOTE: jstree reuses the same node id in both trees (e.g. a
            // "Brugia" <li> exists in #nucleotide_database_tree AND in
            // #protein_database_tree), so a bare `#id` locator is ambiguous.
            // Always scope group lookups to one tree.
            const group = page.locator(`${S.nucleotideTree} #${before.id}`);
            await expect(group).toHaveClass(/jstree-closed/);

            // Click the arrow itself, which is the affordance the hint tells
            // users about (and the one whose hit area was enlarged to 24px).
            await group.locator('> i.jstree-ocl').click();
            await expect(group).toHaveClass(/jstree-open/);

            const after = await page.evaluate(({ treeSel, id }) => {
                const t = document.querySelector(treeSel);
                const node = t.querySelector(`#${id}`);
                return {
                    descendantItems: node.querySelectorAll('li').length,
                    anchorsInTree: t.querySelectorAll('.jstree-anchor').length,
                    visibleChildTitles: Array.from(node.querySelectorAll(':scope > ul > li > .jstree-anchor'))
                        .filter((a) => a.offsetParent !== null)
                        .map((a) => a.innerText.trim())
                };
            }, { treeSel: S.nucleotideTree, id: before.id });

            // Children now exist AND are on screen; the tree grew by exactly
            // the number of newly rendered anchors.
            expect(after.descendantItems).toBeGreaterThan(0);
            expect(after.anchorsInTree).toBeGreaterThan(before.anchorsInTree);
            expect(after.visibleChildTitles.length).toBeGreaterThan(0);
            expect(after.anchorsInTree - before.anchorsInTree)
                .toBe(after.descendantItems);

            // Collapsing again hides them, so the arrow really is a toggle.
            await group.locator('> i.jstree-ocl').click();
            await expect(group).toHaveClass(/jstree-closed/);
            const stillVisible = await page.evaluate(({ treeSel, id }) => Array.from(
                document.querySelector(treeSel).querySelector(`#${id}`)
                    .querySelectorAll(':scope > ul > li > .jstree-anchor')
            ).filter((a) => a.offsetParent !== null).length, { treeSel: S.nucleotideTree, id: before.id });
            expect(stillVisible).toBe(0);
        });

        test(`every tree leaf mirrors exactly one databases[] checkbox (${mod.name})`, async ({ page }) => {
            await gotoSearch(page, mod.path);
            await expandTree(page, S.nucleotideTree);
            await expandTree(page, S.proteinTree);

            const counts = await page.evaluate(({ nucTree, protTree, leafAnchor }) => ({
                nucLeaves: document.querySelectorAll(`${nucTree} ${leafAnchor}`).length,
                protLeaves: document.querySelectorAll(`${protTree} ${leafAnchor}`).length,
                nucBoxes: document.querySelectorAll('input.checkbox-database[data-type="nucleotide"]').length,
                protBoxes: document.querySelectorAll('input.checkbox-database[data-type="protein"]').length
            }), { nucTree: S.nucleotideTree, protTree: S.proteinTree, leafAnchor: S.treeLeafAnchor });

            // The visible widget and the hidden form list are two parallel
            // copies of the same data; a mismatch means databases that cannot
            // be picked (or phantom leaves).
            expect(counts.nucLeaves).toBe(counts.nucBoxes);
            expect(counts.protLeaves).toBe(counts.protBoxes);
            expect(counts.nucBoxes).toBe(mod.nucleotideCount);
            expect(counts.protBoxes).toBe(mod.proteinCount);
        });

        test(`ticking a database in the tree checks its databases[] input (${mod.name})`, async ({ page }) => {
            await gotoSearch(page, mod.path);
            await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(0);

            await expandTree(page, S.nucleotideTree);
            await clickDatabaseLeaf(page, S.nucleotideTree, mod.nucleotideDb);

            // Exactly one database is selected, it is the one we clicked, and
            // it registered as a nucleotide database.
            await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(1);
            expect(await checkedDatabases(page)).toEqual([
                { title: mod.nucleotideDb, type: 'nucleotide' }
            ]);

            // Clicking it again clears the selection: the checkbox is a toggle,
            // not a one-way latch.
            await clickDatabaseLeaf(page, S.nucleotideTree, mod.nucleotideDb);
            await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(0);
        });

        test(`selecting one category constrains the other (${mod.name})`, async ({ page }) => {
            await gotoSearch(page, mod.path);

            // Baseline: neither category is constrained.
            expect(await selectAllButtons(page)).toEqual([
                { text: '[Select all]', visible: true, disabled: false, greyed: false, blue: true },
                { text: '[Select all]', visible: true, disabled: false, greyed: false, blue: true }
            ]);

            await expandTree(page, S.nucleotideTree);
            await expandTree(page, S.proteinTree);

            // --- pick a nucleotide database ---
            await clickDatabaseLeaf(page, S.nucleotideTree, mod.nucleotideDb);
            await expect(page.locator(S.databaseCheckedOfType('nucleotide'))).toHaveCount(1);
            await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(0);

            // The PROTEIN category is now greyed out and its control disabled.
            expect(await selectAllButtons(page)).toEqual([
                { text: '[Select all]', visible: true, disabled: false, greyed: false, blue: true },
                { text: '[Select all]', visible: true, disabled: true, greyed: true, blue: false }
            ]);

            // --- now pick a protein database ---
            await clickDatabaseLeaf(page, S.proteinTree, mod.proteinDb);

            // The nucleotide pick was dropped, not added to: the app enforces a
            // single sequence type by unchecking the other category outright.
            await expect(page.locator(S.databaseCheckedOfType('nucleotide'))).toHaveCount(0);
            await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(1);
            expect(await checkedDatabases(page)).toEqual([
                { title: mod.proteinDb, type: 'protein' }
            ]);

            // ...and the visible jstree widget was unchecked too, not just the
            // hidden form. (jstree counts parent folders as checked, so assert
            // "none" on the cleared side and "some" on the active side.)
            const widget = await page.evaluate(() => ({
                nuc: $('#nucleotide_database_tree').jstree('get_checked').length,
                prot: $('#protein_database_tree').jstree('get_checked').length
            }));
            expect(widget.nuc).toBe(0);
            expect(widget.prot).toBeGreaterThan(0);

            // The greying has flipped to the nucleotide category.
            expect(await selectAllButtons(page)).toEqual([
                { text: '[Select all]', visible: true, disabled: true, greyed: true, blue: false },
                { text: '[Select all]', visible: true, disabled: false, greyed: false, blue: true }
            ]);
        });
    });
}

// The expand/collapse arrow hit area was enlarged to 24px when the hint was
// added (public/css/app.css: `.jstree-default .jstree-node > .jstree-ocl`).
// The worry was that this would knock the jstree sprite icons out of
// alignment. The vendored jstree 3.3.8 default theme already sizes every
// .jstree-icon at 24x24 with a 24px line-height, so the override should be a
// no-op. This test pins that down against the rendered page.
test('the 24px arrow hit area has not misaligned the jstree sprite icons', async ({ page }) => {
    await gotoSearch(page, '/blast/SGD/R64-5-1f/');

    const geom = await page.evaluate((treeSel) => {
        const node = document.querySelector(`${treeSel} li.jstree-closed`);
        const ocl = node.querySelector(':scope > i.jstree-ocl');
        const anchor = node.querySelector(':scope > a.jstree-anchor');
        const icon = anchor.querySelector('i.jstree-icon');
        const box = (el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
                top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
                width: r.width, height: r.height,
                lineHeight: cs.lineHeight,
                backgroundPosition: cs.backgroundPosition,
                hasSprite: cs.backgroundImage.includes('32px.png')
            };
        };
        return {
            ocl: box(ocl),
            anchor: box(anchor),
            icon: box(icon),
            rowHeight: node.getBoundingClientRect().height ? Math.round(
                node.querySelector(':scope > a.jstree-anchor').getBoundingClientRect().height) : null
        };
    }, S.nucleotideTree);

    // The enlarged hit area is exactly the theme's own cell size.
    expect(geom.ocl.width).toBe(24);
    expect(geom.ocl.height).toBe(24);
    expect(geom.ocl.lineHeight).toBe('24px');

    // The folder icon inside the anchor is still the same size and on the same
    // baseline as the arrow -- no vertical drift.
    expect(geom.icon.width).toBe(24);
    expect(geom.icon.height).toBe(24);
    expect(geom.icon.top).toBe(geom.ocl.top);
    expect(geom.anchor.top).toBe(geom.ocl.top);
    expect(geom.rowHeight).toBe(24);

    // The arrow sits flush against the anchor: no gap, no overlap. A hit area
    // larger than the theme's cell would push these apart.
    expect(geom.anchor.left).toBe(geom.ocl.right);

    // Both are drawn from the 32px sprite at the theme's standard offsets;
    // a changed cell size would have required different background-positions.
    expect(geom.ocl.hasSprite).toBe(true);
    expect(geom.icon.hasSprite).toBe(true);
    expect(geom.ocl.backgroundPosition).toBe('-100px -4px');
    expect(geom.icon.backgroundPosition).toBe('-164px -4px');
});
