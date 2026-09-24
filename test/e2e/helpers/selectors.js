// Selector map for the AGR SequenceServer UI.
//
// EVERY selector here was read off the LIVE page at https://blast-dev.alliancegenome.org
// on 2026-09-24, not inferred from source. Prefer these over ad-hoc selectors so
// that a markup change breaks one file instead of twenty.
//
// Notes that cost time to discover -- read them before writing a spec:
//
//  * There are TWO database trees, not one: #nucleotide_database_tree and
//    #protein_database_tree. Neither is called "#databases_tree". Protein-only
//    MODs are real: RGD, ZFIN and ALLIANCE render ONLY the nucleotide tree, so
//    never assume both exist.
//  * THE DOM HOLDS TWO PARALLEL COPIES OF THE DATABASE LIST. The real form
//    controls live in a HIDDEN source list:
//        ul.databases.hidden > li > label.database > input.checkbox-database
//    jstree renders a SEPARATE visible widget that mirrors it. Consequences:
//      - the checkboxes are never visible; toBeVisible() on them always fails,
//        so assert on :checked / count, not visibility;
//      - a checkbox has no .jstree-anchor anywhere near it -- its title is the
//        text of its enclosing label.database;
//      - to change a selection, CLICK THE JSTREE ANCHOR, never the raw input.
//        Clicking the input does not drive jstree's model and desynchronises
//        the widget from the form.
//  * input.checkbox-database carries data-type="nucleotide" | "protein" --
//    the cheapest way to assert which kind of database a click selected.
//  * Hit action buttons are button.view-sequence / .download-fa / .download-aln.
//    There is no ".view" or ".down" class.
//  * The sequence viewer is a NATIVE <dialog class="sequence-viewer">. It is in
//    the DOM from page load and merely gains [open]; asserting on its mere
//    existence proves nothing. Assert on [open] or on visible content.
//  * A bare ".hit" also matches <polygon class="hit"> in the graphical-overview
//    SVG, which has no innerText and renders BEFORE the hit list does. Every
//    result selector here is therefore anchored on "div.hit".
//
// This module must stay free of anything that cannot cross into the page:
// helper FUNCTIONS live here too (hitById, databaseCheckboxOfType), and
// Playwright refuses to serialise a function into page.evaluate. Pass the
// individual STRINGS you need, never this object wholesale.

module.exports = {
    // ---- search page ----
    form: 'form#blast',
    header: 'header#header',
    memberLogo: 'img#alliance-member-logo',
    sequence: 'textarea#sequence',
    clearSequence: 'button#btn-sequence-clear',
    sequenceFileLabel: 'span#sequence-file',

    // "Try an example" row. Buttons carry no id/data attribute -- match them by
    // accessible name, e.g. page.getByRole('button', { name: /ACT1/ }).
    exampleRow: 'div#example-sequences',
    exampleButtons: 'div#example-sequences button',

    // Database trees.
    nucleotideTree: '#nucleotide_database_tree',
    proteinTree: '#protein_database_tree',
    anyTree: '.jstree_div',
    treeAnchor: '.jstree-anchor',
    treeLeafAnchor: '.jstree-leaf .jstree-anchor',
    treeClosedToggle: '.jstree-closed > i.jstree-ocl',
    // Hidden source list holding the real form controls (see note above).
    databaseSourceList: 'ul.databases',
    databaseLabel: 'label.database',
    databaseCheckbox: 'input.checkbox-database[name="databases[]"]',
    databaseCheckboxChecked: 'input.checkbox-database[name="databases[]"]:checked',
    databaseCheckboxOfType: (t) => `input.checkbox-database[data-type="${t}"]`,
    databaseCheckedOfType: (t) => `input.checkbox-database[data-type="${t}"]:checked`,
    treeSearchNucleotide: '#nucleotide_database_tree_search',
    treeSearchProtein: '#protein_database_tree_search',
    // Exact hint text shipped under each tree (appears once per tree).
    treeHintText: 'Click arrows to expand/collapse groups. Use checkboxes to select databases.',

    // Settings / presets block. Rendered empty until a database is selected.
    presets: 'div#options-presets',
    presetsHeading: 'div#options-presets h3',
    presetsSubhead: 'div#options-presets p',
    presetRadio: 'input[name="predefinedOption"]',
    presetRadioChecked: 'input[name="predefinedOption"]:checked',
    presetLabel: 'div#options-presets label',
    taskSelect: 'select#task',
    evalue: 'select#evalue',
    maxTargetSeqs: 'select#max_target_seqs',
    openInNewTab: 'input#toggleNewTab',
    // The values the form will actually SUBMIT. Several names exist twice in the
    // form -- "task" and "evalue" are each both a <select> and a hidden <input>
    // -- and it is the hidden input that gets posted. Always assert through this.
    hiddenInput: (name) => `form#blast input[type="hidden"][name="${name}"]`,

    // Submit. Disabled until there is both a query and a database.
    methodsBlock: 'div#methods',
    submit: 'button#method',

    // ---- results page ----
    results: 'div#results',
    // div.hit, NOT ".hit": the graphical-overview SVG contains
    // <polygon class="hit"> elements that render before the hit list and would
    // satisfy a wait or inflate a count.
    hit: 'div.hit',
    // Hit ids follow Query_<n>_hit_<m>, e.g. #Query_1_hit_1.
    hitById: (q, h) => `#Query_${q}_hit_${h}`,
    hitCheckbox: (q, h) => `#Query_${q}_hit_${h}_checkbox`,
    viewSequenceButton: 'button.view-sequence',
    downloadFastaButton: 'button.download-fa',
    downloadAlignmentButton: 'button.download-aln',
    exportSvg: 'a.export-to-svg',
    exportPng: 'a.export-to-png',

    // Sequence viewer dialog.
    sequenceViewer: 'dialog.sequence-viewer',
    sequenceViewerOpen: 'dialog.sequence-viewer[open]',
    sequenceViewerContent: 'dialog.sequence-viewer .sequence-viewer-content',
    sequenceViewerClose: 'button.sequence-viewer-close',

    // Linkouts. Match on href, the text is "NCBI: <acc>" / "JBrowse".
    ncbiLink: 'div.hit a[href*="ncbi.nlm.nih.gov"]',
    ncbiNuccoreLink: 'div.hit a[href*="ncbi.nlm.nih.gov/nuccore/"]',
    ncbiProteinLink: 'div.hit a[href*="ncbi.nlm.nih.gov/protein/"]',
    jbrowseLink: 'div.hit a[href*="jbrowse"]'
};
