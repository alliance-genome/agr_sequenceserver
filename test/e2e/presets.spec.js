// Option presets and the search-form parameter controls.
//
// Background: SGD's blastn used to come up preset to "blastn-short", and the
// whole Settings block used to be hidden for any method that ships only ONE
// preset (blastp, blastx, tblastn, tblastx all do). Both were fixed; these
// specs pin the fixed behaviour down.
//
// Everything here is driven from public/configs/sequenceserver.conf, whose
// :options: map is the source of truth for the preset names, their flags and
// their human-readable descriptions.

const { test, expect } = require('@playwright/test');
const { gotoSearch, selectDatabaseByTitle, S } = require('./helpers/app');

const SGD_MAIN = '/blast/SGD/R64-5-1m/';

// Real sequences pulled from the deployed databases, not invented:
//   blastdbcmd -db .../S288C_Reference_Strain_ORFs... -entry YFL039C
// ACT1 (YFL039C) coding sequence, first 240 nt.
const ACT1_DNA = [
    '>act1_cds_fragment',
    'ATGGATTCTGAGGTTGCTGCTTTGGTTATTGATAACGGTTCTGGTATGTGTAAAGCCGGT',
    'TTTGCCGGTGACGACGCTCCTCGTGCTGTCTTCCCATCTATCGTCGGTAGACCAAGACAC',
    'CAAGGTATCATGGTCGGTATGGGTCAAAAAGACTCCTACGTTGGTGATGAAGCTCAATCC',
    'AAGAGAGGTATCTTGACTTTACGTTACCCAATTGAACACGGTATTGTCACCAACTGGGAC'
].join('\n');

// Act1p (YFL039C) protein, first 150 aa.
const ACT1_PROTEIN = [
    '>act1p_fragment',
    'MDSEVAALVIDNGSGMCKAGFAGDDAPRAVFPSIVGRPRHQGIMVGMGQKDSYVGDEAQS',
    'KRGILTLRYPIEHGIVTNWDDMEKIWHHTFYNELRVAPEEHPVLLTEAPMNPKSNREKMT',
    'QIMFETFNVPAFYVSIQAVLSLYSSGRTTG'
].join('\n');

// Leaf database titles (matched by TITLE -- ids are per-deployment md5s).
const NUC_DB = 'Nuclear_chromosomes';
const PROT_DB = 'Protein_sequences';

/** Put the form into a given method: fill the query, then pick the database. */
async function arm(page, { sequence, database, tree }) {
    await page.locator(S.sequence).fill(sequence);
    await selectDatabaseByTitle(page, database, tree);
    // Presets are rendered by React only once a database is selected.
    await expect(page.locator(S.presetRadio).first()).toBeAttached();
}

const NUCLEOTIDE_QUERY = { sequence: ACT1_DNA, database: NUC_DB, tree: S.nucleotideTree };
const PROTEIN_QUERY = { sequence: ACT1_PROTEIN, database: PROT_DB, tree: S.proteinTree };

test.describe('Option presets', () => {
    test('Settings block is empty until a database is selected', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);

        // #options-presets exists from first render but must hold nothing:
        // no heading, no presets, and an empty blast_params.
        await expect(page.locator(S.presets)).toBeAttached();
        await expect(page.locator(S.presets)).toHaveText('');
        await expect(page.locator(S.presetRadio)).toHaveCount(0);
        await expect(page.locator(S.hiddenInput('blast_params'))).toHaveValue('');

        // Selecting a database is what brings it to life.
        await page.locator(S.sequence).fill(ACT1_DNA);
        await selectDatabaseByTitle(page, NUC_DB, S.nucleotideTree);

        await expect(page.locator(S.presetsHeading)).toHaveText('Settings');
        await expect(page.locator(S.presetsSubhead))
            .toHaveText('Choose a predefined setting or customize parameters.');
        await expect(page.locator(S.presetRadio)).toHaveCount(2);
    });

    test('blastn preselects "default", NOT "short-seq"', async ({ page }) => {
        // This is the SGD regression that prompted the whole change: the page
        // used to come up with blastn-short checked.
        await gotoSearch(page, SGD_MAIN);
        await arm(page, NUCLEOTIDE_QUERY);

        const checked = page.locator(S.presetRadioChecked);
        await expect(checked).toHaveCount(1);
        await expect(checked).toHaveValue('-task blastn -evalue 1e-5 -max_target_seqs 100');

        // The checked one is the row labelled "default", and it is not the
        // short-seq row.
        const checkedLabel = page.locator(S.presetLabel).filter({ has: page.locator(':checked') });
        await expect(checkedLabel).toHaveCount(1);
        await expect(checkedLabel).toContainText('default:');
        await expect(checkedLabel).toContainText('Standard nucleotide BLAST (E-value: 1e-5, Max hits: 100)');
        await expect(checkedLabel).not.toContainText('short-seq');
        await expect(checkedLabel).not.toContainText('blastn-short');

        // ...and the parameters that will actually be submitted agree.
        await expect(page.locator(S.hiddenInput('blast_params')))
            .toHaveValue('-task blastn -evalue 1e-5 -max_target_seqs 100');
        await expect(page.locator(S.hiddenInput('task'))).toHaveValue('blastn');
        await expect(page.locator(S.hiddenInput('evalue'))).toHaveValue('1e-5');
        await expect(page.locator(S.hiddenInput('max_target_seqs'))).toHaveValue('100');
    });

    test('Task dropdown reads blastn, not blastn-short', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);
        await arm(page, NUCLEOTIDE_QUERY);

        const task = page.locator(S.taskSelect);
        await expect(task).toHaveValue('blastn');
        // blastn-short is offered, it is simply not the default -- so this
        // assertion is about which one is selected, not about what exists.
        await expect(task.locator('option[value="blastn-short"]')).toHaveCount(1);
        await expect(page.locator(S.maxTargetSeqs)).toHaveValue('100');
    });

    test('both blastn presets are listed with human-readable descriptions', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);
        await arm(page, NUCLEOTIDE_QUERY);

        const labels = page.locator(S.presetLabel);
        await expect(labels).toHaveCount(2);

        await expect(labels.nth(0)).toContainText('default:');
        await expect(labels.nth(0)).toContainText('Standard nucleotide BLAST (E-value: 1e-5, Max hits: 100)');
        await expect(labels.nth(1)).toContainText('short-seq:');
        await expect(labels.nth(1)).toContainText('Short sequences under 50bp (E-value: 0.1)');

        // The description must be prose, not the raw flag string. options.js
        // falls back to `description || attributes.join(' ')`, so a config that
        // lost its descriptions would render "-task blastn -evalue 1e-5 ..."
        // here -- that fallback is exactly what this asserts against.
        await expect(labels.nth(0)).not.toContainText('-evalue');
        await expect(labels.nth(0)).not.toContainText('-max_target_seqs');
        await expect(labels.nth(1)).not.toContainText('-evalue');

        await expect(page.locator(S.presetRadio).nth(1))
            .toHaveValue('-task blastn-short -evalue 1e-1');
    });

    test('selecting "short-seq" rewrites the submitted parameters, and switching back restores them', async ({ page }) => {
        await gotoSearch(page, SGD_MAIN);
        await arm(page, NUCLEOTIDE_QUERY);

        const shortSeq = page.locator(`${S.presetRadio}[value="-task blastn-short -evalue 1e-1"]`);
        const dflt = page.locator(`${S.presetRadio}[value="-task blastn -evalue 1e-5 -max_target_seqs 100"]`);

        await shortSeq.check();

        await expect(shortSeq).toBeChecked();
        await expect(dflt).not.toBeChecked();
        // The whole point of a preset: it drives the advanced parameters.
        await expect(page.locator(S.hiddenInput('blast_params')))
            .toHaveValue('-task blastn-short -evalue 1e-1');
        await expect(page.locator(S.hiddenInput('task'))).toHaveValue('blastn-short');
        await expect(page.locator(S.hiddenInput('evalue'))).toHaveValue('1e-1');
        // short-seq carries no -max_target_seqs, so that input must go away
        // rather than linger at the previous preset's 100.
        await expect(page.locator(S.hiddenInput('max_target_seqs'))).toHaveCount(0);
        await expect(page.locator(S.taskSelect)).toHaveValue('blastn-short');
        await expect(page.locator(S.maxTargetSeqs)).toHaveValue('');

        // Switching back is not a one-way door.
        await dflt.check();
        await expect(dflt).toBeChecked();
        await expect(page.locator(S.hiddenInput('blast_params')))
            .toHaveValue('-task blastn -evalue 1e-5 -max_target_seqs 100');
        await expect(page.locator(S.taskSelect)).toHaveValue('blastn');
        await expect(page.locator(S.hiddenInput('max_target_seqs'))).toHaveValue('100');
    });

    // The single-preset regression. blastp/blastx/tblastn each ship exactly one
    // preset; the Settings block used to render nothing at all unless a method
    // had more than one, so these three methods showed no parameters whatsoever.
    const singlePresetMethods = [
        {
            method: 'blastp',
            query: PROTEIN_QUERY,
            description: 'Standard protein BLAST (E-value: 1e-5, Max hits: 100)',
            params: '-task blastp -evalue 1e-5 -max_target_seqs 100'
        },
        {
            method: 'blastx',
            // nucleotide query against a protein database
            query: { sequence: ACT1_DNA, database: PROT_DB, tree: S.proteinTree },
            description: 'Translated nucleotide vs protein (E-value: 1e-5, Max hits: 100)',
            params: '-task blastx -evalue 1e-5 -max_target_seqs 100'
        },
        {
            method: 'tblastn',
            // protein query against a nucleotide database
            query: { sequence: ACT1_PROTEIN, database: NUC_DB, tree: S.nucleotideTree },
            description: 'Protein vs translated nucleotide (E-value: 1e-5, Max hits: 100)',
            params: '-task tblastn -evalue 1e-5 -max_target_seqs 100'
        }
    ];

    for (const m of singlePresetMethods) {
        test(`Settings renders for ${m.method}, which has only ONE preset`, async ({ page }) => {
            await gotoSearch(page, SGD_MAIN);
            await arm(page, m.query);

            // The method really did resolve to the one under test.
            await expect(page.locator(S.hiddenInput('task'))).toHaveValue(m.method);

            // The block that used to be hidden.
            await expect(page.locator(S.presetsHeading)).toHaveText('Settings');
            await expect(page.locator(S.presetsSubhead))
                .toHaveText('Choose a predefined setting or customize parameters.');

            const labels = page.locator(S.presetLabel);
            await expect(labels).toHaveCount(1);
            await expect(labels).toContainText('default:');
            await expect(labels).toContainText(m.description);
            await expect(labels).not.toContainText('-evalue');

            // The preset's parameters are the ones the form will submit.
            await expect(page.locator(S.hiddenInput('blast_params'))).toHaveValue(m.params);
            await expect(page.locator(S.hiddenInput('evalue'))).toHaveValue('1e-5');
            await expect(page.locator(S.hiddenInput('max_target_seqs'))).toHaveValue('100');
        });
    }

    // ---------------------------------------------------------------------
    // KNOWN BUG, not a flaky test. See public/js/options.js:
    //
    //   presetListJSX(): checked={textValue === this.state.textValue}
    //       textValue         = config.attributes.join(' ')
    //   componentDidUpdate(): if the preset carries no "-task" flag it PREPENDS
    //       one, so state.textValue = "-task blastp -evalue 1e-5 -max_target_seqs 100"
    //       while the radio's own value stays "-evalue 1e-5 -max_target_seqs 100".
    //
    // The strings therefore never match and the radio renders unchecked. Only
    // blastn escapes this, because blastn's preset is the one that spells out
    // "-task blastn" in sequenceserver.conf. Net effect: for blastp, blastx,
    // tblastn and tblastx the Settings block shows a radio group with NOTHING
    // selected, even though those exact parameters are in force (blast_params
    // is correct -- searches run with the right flags, it is the UI that lies).
    //
    // Marked test.fail() so the suite stays honest without going permanently
    // red: Playwright will FAIL this loudly the moment the bug is fixed, which
    // is the signal to delete the annotation.
    // ---------------------------------------------------------------------
    test('BUG: single-preset methods show no preset selected (options.js checked= comparison)', async ({ page }) => {
        test.fail(true, 'options.js prepends -task to state.textValue but not to the radio value');

        await gotoSearch(page, SGD_MAIN);
        await arm(page, PROTEIN_QUERY);

        await expect(page.locator(S.hiddenInput('task'))).toHaveValue('blastp');
        await expect(page.locator(S.presetRadio)).toHaveCount(1);

        // What SHOULD hold: the sole preset, whose parameters are demonstrably
        // in effect, is the one shown as selected.
        await expect(page.locator(S.hiddenInput('blast_params')))
            .toHaveValue('-task blastp -evalue 1e-5 -max_target_seqs 100');
        // Short timeout on purpose: this assertion is known to fail, and the
        // default 30s retry window would add half a minute to every run for a
        // state that is settled the moment the presets render.
        await expect(page.locator(S.presetRadioChecked)).toHaveCount(1, { timeout: 5000 });
    });
});
