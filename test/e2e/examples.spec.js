// "Try an example" -- the per-MOD example sequences offered under the query box.
//
// This feature (public/js/examples.js + query.js ExampleSequences + form.js
// handleExampleSelected) had never been exercised in a browser, so these specs
// are its first real verification. They assert the whole chain a click sets off:
//
//     label clicked -> FASTA lands in #sequence
//                   -> the database named by the example is selected BY TITLE
//                   -> jstree's visible widget ticks the same node
//                   -> sequence type + database type resolve a BLAST method
//                   -> the submit button becomes usable
//
// Doubles as the reference spec for authors: it shows the intended use of the
// helpers in test/e2e/helpers/app.js.
//
// Everything asserted here was read off the live dev deployment on 2026-09-24.

const { test, expect } = require('@playwright/test');
const { gotoSearch, clickExample, checkedDatabaseTitles, S } = require('./helpers/app');

const SGD_MAIN = '/blast/SGD/R64-5-1m/';

// Labels are the accessible names of the example buttons; they are also the
// only stable handle on an example (the buttons carry no id or data attribute).
const SGD_NUCLEOTIDE = 'ACT1 / YFL039C coding sequence';
const SGD_PROTEIN = 'Act1p protein';

/** The exact example labels a MOD ships, in render order. */
function exampleLabels(page) {
    return page.locator(S.exampleButtons).evaluateAll(
        (buttons) => buttons.map((b) => b.textContent.trim()));
}

/**
 * The id (md5) of the single checked database, plus whether jstree's visible
 * widget shows that same node as selected. The two live in parallel DOM trees
 * (hidden form list vs jstree widget), so agreement is worth asserting.
 */
function checkedDatabase(page) {
    return page.evaluate(({ checkedSel, labelSel }) => {
        const boxes = Array.from(document.querySelectorAll(checkedSel));
        return boxes.map((cb) => {
            // Database ids are md5s and often start with a digit, so "#<id>"
            // is not a valid CSS selector -- always address them by attribute.
            const anchor = document.querySelector(`[id="${cb.value}_anchor"]`);
            return {
                id: cb.value,
                title: cb.closest(labelSel).textContent.trim(),
                type: cb.dataset.type,
                jstreeAnchorFound: !!anchor,
                jstreeTicked: !!anchor && anchor.classList.contains('jstree-clicked')
            };
        });
    }, { checkedSel: S.databaseCheckboxChecked, labelSel: S.databaseLabel });
}

/**
 * Assert that exactly one database is selected and it is the one named.
 *
 * Polls, because selecting a database of the other type runs through jstree
 * and a deferred "uncheck the other tree" handler: for a moment after the
 * click the old selection can still be the only one checked. Reading once,
 * immediately, is the difference between this spec testing replacement and it
 * testing how fast the machine is.
 */
async function expectOnlySelectedDatabase(page, title) {
    await expect.poll(() => checkedDatabaseTitles(page), {
        timeout: 30 * 1000,
        message: `expected exactly one selected database, titled "${title}"`
    }).toEqual([title]);
}

test.describe('Try an example', () => {
    test('the example row renders with the labels and database mapping SGD ships', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);

        const row = page.locator(S.exampleRow);
        await expect(row).toBeVisible();
        await expect(row).toContainText('Try an example:');

        // SGD ships exactly one nucleotide and one protein example, in this order.
        expect(await exampleLabels(page)).toEqual([SGD_NUCLEOTIDE, SGD_PROTEIN]);

        // Each button advertises the database it will select -- this is the
        // example -> database mapping made visible, and it must name real
        // databases of this deployment (asserted by the click specs below).
        const titles = await page.locator(S.exampleButtons).evaluateAll(
            (buttons) => buttons.map((b) => b.getAttribute('title')));
        expect(titles).toEqual([
            `Load ${SGD_NUCLEOTIDE} and select ORF_coding`,
            `Load ${SGD_PROTEIN} and select Protein_sequences`
        ]);
    });

    test('clicking a nucleotide example fills the query AND selects its database', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);

        // Preconditions: nothing selected, submit disabled. Without these the
        // assertions below could pass on a page that was never interacted with.
        await expect(page.locator(S.sequence)).toHaveValue('');
        await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(0);
        await expect(page.locator(S.submit)).toBeDisabled();

        await clickExample(page, /ACT1 \/ YFL039C coding sequence/);

        // 1. The query box holds the real ACT1 FASTA record -- a defline plus
        //    actual coding sequence, not merely "something non-empty".
        const seq = await page.locator(S.sequence).inputValue();
        expect(seq.startsWith('>YFL039C ACT1 SGDID:S000001855')).toBe(true);
        expect(seq).toContain('ATGGATTCTGAGGTTGCTGCT');
        expect(seq.length).toBeGreaterThan(500);

        // 2. Exactly one database got selected, and it is the one the example
        //    names, matched by TITLE (ids are per-deployment md5s).
        await expectOnlySelectedDatabase(page, 'ORF_coding');
        await expect(page.locator(S.databaseCheckedOfType('nucleotide'))).toHaveCount(1);
        await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(0);

        // 3. Sequence type + database type resolved to blastn, and the button
        //    became usable. Both are downstream of the example click.
        //    The label is uppercased by CSS but the TEXT is lowercase, so assert
        //    on the submitted value rather than on appearance.
        await expect(page.locator(S.submit)).toBeEnabled();
        await expect(page.locator(S.submit)).toHaveAttribute('value', 'blastn');
    });

    test('the visible jstree node ticks in step with the hidden form checkbox', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);
        await clickExample(page, /ACT1 \/ YFL039C coding sequence/);

        // The form control and the jstree widget are two parallel DOM copies.
        // A selection that updated only the checkbox would leave the user
        // looking at an unticked tree, so require both.
        await expect.poll(() => checkedDatabase(page), {
            timeout: 30 * 1000,
            message: 'the jstree widget and the hidden form checkbox disagree'
        }).toEqual([expect.objectContaining({
            title: 'ORF_coding',
            type: 'nucleotide',
            jstreeAnchorFound: true,
            jstreeTicked: true
        })]);

        // jstree opened the ancestors, so the ticked node is actually on screen.
        const [checked] = await checkedDatabase(page);
        await expect(page.locator(`[id="${checked.id}_anchor"]`)).toBeVisible();
    });

    test('nucleotide example yields blastn presets, defaulting to blastn (not blastn-short)', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);
        await clickExample(page, /ACT1 \/ YFL039C coding sequence/);

        // The Settings block is empty until a database is selected; the example
        // click is what populates it here.
        const presets = page.locator(S.presets);
        await expect(presets).toContainText('Settings');
        await expect(presets).toContainText('Standard nucleotide BLAST (E-value: 1e-5, Max hits: 100)');

        // The preselected preset is plain blastn, NOT blastn-short.
        const checked = page.locator(`${S.presetRadio}:checked`);
        await expect(checked).toHaveCount(1);
        await expect(checked).toHaveValue('-task blastn -evalue 1e-5 -max_target_seqs 100');
    });

    test('protein example selects a protein database and switches the method to blastp', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);
        await clickExample(page, /Act1p protein/);

        const seq = await page.locator(S.sequence).inputValue();
        expect(seq.startsWith('>YFL039C ACT1 SGDID:S000001855')).toBe(true);
        // Residues, not bases: this run of amino acids cannot be a nucleotide seq.
        expect(seq).toContain('MDSEVAALVIDNGSGMCKAGFAGDDAPR');

        // The database it selected must genuinely be a protein database.
        await expectOnlySelectedDatabase(page, 'Protein_sequences');
        await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(1);
        await expect(page.locator(S.databaseCheckedOfType('nucleotide'))).toHaveCount(0);

        await expect(page.locator(S.submit)).toBeEnabled();
        await expect(page.locator(S.submit)).toHaveAttribute('value', 'blastp');
    });

    test('a second example replaces the first, in both directions', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);

        await clickExample(page, /ACT1 \/ YFL039C coding sequence/);
        const first = await page.locator(S.sequence).inputValue();
        expect(first).toContain('ATGGATTCTGAGGTTGCTGCT');

        // --- nucleotide example -> protein example ---
        await clickExample(page, /Act1p protein/);
        const second = await page.locator(S.sequence).inputValue();
        // Replaced, not appended: one defline only, and no trace of the
        // nucleotide record that was in the box a moment ago.
        expect((second.match(/^>/gm) || []).length).toBe(1);
        expect(second).toContain('MDSEVAALVIDNGSGMCKAGFAGDDAPR');
        expect(second).not.toContain('ATGGATTCTGAGGTTGCTGCT');
        expect(second).not.toContain(first);

        // The database selection was replaced too -- the nucleotide database
        // must not still be checked alongside the protein one.
        await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(1);
        await expectOnlySelectedDatabase(page, 'Protein_sequences');
        await expect(page.locator(S.submit)).toHaveAttribute('value', 'blastp');

        // --- and back the other way: protein example -> nucleotide example ---
        await clickExample(page, /ACT1 \/ YFL039C coding sequence/);
        const third = await page.locator(S.sequence).inputValue();
        expect(third).toBe(first);
        expect(third).not.toContain('MDSEVAALVIDNGSGMCKAGFAGDDAPR');
        await expect(page.locator(S.databaseCheckboxChecked)).toHaveCount(1);
        await expectOnlySelectedDatabase(page, 'ORF_coding');
        await expect(page.locator(S.submit)).toHaveAttribute('value', 'blastn');
    });

    test('each MOD ships its own example labels, and no two MODs share one', async ({ page }) => {
        const expected = {
            [SGD_MAIN]: [SGD_NUCLEOTIDE, SGD_PROTEIN],
            '/blast/WB/WS298/': ['unc-54 protein (myosin heavy chain)'],
            '/blast/FB/FB2026_03/': ['white protein (eye colour)']
        };

        const seen = {};
        for (const [path, labels] of Object.entries(expected)) {
            await gotoSearch(page, path);
            await expect(page.locator(S.exampleRow)).toBeVisible();
            expect(await exampleLabels(page), `example labels on ${path}`).toEqual(labels);
            seen[path] = await exampleLabels(page);
        }

        // The labels are genuinely MOD-specific: nothing is shared between MODs.
        const all = Object.values(seen).flat();
        expect(new Set(all).size, 'the same example label appeared under two MODs').toBe(all.length);
    });

    test('WB example loads a C. elegans protein query against the C. elegans protein database', async ({ page }) => {
        await gotoSearch(page, '/blast/WB/WS298/');
        await clickExample(page, /unc-54 protein \(myosin heavy chain\)/);

        const seq = await page.locator(S.sequence).inputValue();
        expect(seq).toContain('locus=unc-54');
        expect(seq).toContain('MEHEKDPGWQYLRRTREQ');
        expect(seq.length).toBeGreaterThan(400);

        await expectOnlySelectedDatabase(page, 'C_elegans_Protein_Sequences');
        await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(1);
        await expect(page.locator(S.submit)).toBeEnabled();
        await expect(page.locator(S.submit)).toHaveAttribute('value', 'blastp');
    });

    test('FB example loads a D. melanogaster protein query against the Dmel protein database', async ({ page }) => {
        await gotoSearch(page, '/blast/FB/FB2026_03/');
        await clickExample(page, /white protein \(eye colour\)/);

        const seq = await page.locator(S.sequence).inputValue();
        expect(seq).toContain('FBpp0070468');
        expect(seq).toContain('MGQEDQELLIRGGSKHPS');
        expect(seq.length).toBeGreaterThan(400);

        await expectOnlySelectedDatabase(page, 'D_melanogaster_Proteins_6_69');
        await expect(page.locator(S.databaseCheckedOfType('protein'))).toHaveCount(1);
        await expect(page.locator(S.submit)).toBeEnabled();
        await expect(page.locator(S.submit)).toHaveAttribute('value', 'blastp');
    });

    test('a page with no MOD in its path renders no example row at all', async ({ page }) => {
        // /blast/ serves the search page with no MOD segment, so
        // examplesForCurrentMod() finds no entry and ExampleSequences must
        // render null rather than an empty "Try an example:" row.
        await page.goto('/blast/', { waitUntil: 'domcontentloaded' });

        // The search form itself did render -- otherwise "no row" would prove
        // nothing about the examples feature.
        await expect(page.locator(S.form)).toBeVisible();
        await expect(page.locator(S.sequence)).toBeVisible();
        await expect(page.locator(S.clearSequence)).toBeAttached();

        await expect(page.locator(S.exampleRow)).toHaveCount(0);
        await expect(page.locator(S.exampleButtons)).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('Try an example');
    });
});
