import React from 'react';
import _ from 'underscore';
import Jstree from 'jstree';
import { Databases } from './databases';
import commonNames from '../configs/common_names.json';

/**
 * Shortest query that may consult the common-name table.
 *
 * One or two letters match a dozen alias keys at once ("a" is in "ant",
 * "aphid", "rat" and "yeast"), which would turn an early keystroke into a
 * match on most of the tree. Latin text matching is unaffected and still
 * applies from the first character.
 */
const MIN_ALIAS_QUERY = 3;

/**
 * Does this tree node answer the query?
 *
 * jstree's own search compares the query against node text, so a tree of
 * Latin binomials and build titles answers nothing for "zebrafish", "worm",
 * "fly" or "mouse". Text matching stays first; the alias table in
 * public/configs/common_names.json is consulted only when the text does not
 * match and the query is long enough to be meant.
 */
export function nodeMatchesQuery(query, text) {
    const q = (query || '').trim().toLowerCase();
    const label = (text || '').toLowerCase();
    if (!q) return false;
    if (label.includes(q)) return true;
    if (q.length < MIN_ALIAS_QUERY) return false;

    const aliases = commonNames.aliases || {};
    return Object.keys(aliases).some(function (alias) {
        if (!alias.includes(q)) return false;
        return aliases[alias].some(function (pattern) {
            return label.includes(pattern.toLowerCase());
        });
    });
}

export default class extends Databases {
    constructor(props) {
        super(props);
        this.state = Object.assign({}, this.state, { searchMisses: {} });
        this.searchMissBound = {};
        this.handleLoadTree = this.handleLoadTree.bind(this);
        this.handleTreeSearch = this.handleTreeSearch.bind(this);
        this.handleTreeExpansion = this.handleTreeExpansion.bind(this);
        this.renderDatabases = this.renderDatabases.bind(this);
        this.renderDatabaseSearch = this.renderDatabaseSearch.bind(this);
        this.renderDatabaseTree = this.renderDatabaseTree.bind(this);
    }

    handleLoadTree(category) {
        var tree_id = '#' + category + '_database_tree';
        // hack that is needed to sync the selected tree db with the hidden main db
        window.jstree_node_change_timeout = null;
        window.jstree_rapid_timeout = null
        const _this = this;

        // Debug log
        console.log('handleLoadTree called for category:', category, 'tree_id:', tree_id);

        $(tree_id).on('select_node.jstree deselect_node.jstree', function (_, _data) {
            if (window.jstree_node_change_timeout) clearTimeout(window.jstree_node_change_timeout);
            if (window.jstree_rapid_timeout) clearTimeout(window.jstree_rapid_timeout);

            // Set a timeout to handle jsTree node changes with some delay to avoid rapid re-triggering
            window.jstree_rapid_timeout = setTimeout(function () {
                // Set another timeout to handle the retrieval and processing of selected nodes
                window.jstree_node_change_timeout = setTimeout(function () {
                    // Filter out the current category to get a list of other categories
                    const otherCategories = _this.categories().filter(item => item !== category);

                    // Uncheck all nodes in the trees of the other categories
                    otherCategories.forEach((value) => $(`#${value}_database_tree`).jstree('uncheck_all'));
                    // Get all selected nodes from the current tree.
                    // Note: This will also include folders. To filter only database nodes, ensure the ID length is 32.
                    // These IDs correspond to specific elements in the hidden main form.
                    const selected = $(tree_id).jstree('get_selected').filter(selected => selected.length === 32);

                    // Find database entries in the current category whose IDs match the selected nodes
                    const foundDatabases = _this.databases(category).filter(db => selected.includes(db.id));

                    // Update the selected databases in the view model with the found databases
                    _this.selectDatabases(foundDatabases);
                }, 100); // Delay to ensure jsTree updates are processed
            }, 100); // Delay to prevent rapid changes causing multiple triggers
        });


        const treeData = this.props.tree[category];
        const databaseOrder = this.props.databaseOrder || {};

        // Find matching config based on detection rules
        const findMatchingConfig = () => {
            const treeString = JSON.stringify(treeData);
            for (const [modName, config] of Object.entries(databaseOrder)) {
                if (config.detection && config.detection.titleContains) {
                    const hasMatch = config.detection.titleContains.some(term => treeString.includes(term));
                    if (hasMatch) {
                        return config;
                    }
                }
            }
            return null;
        };

        const matchedConfig = findMatchingConfig();

        const jstreeConfig = {
            'core': {
                'data': treeData
            },
            'plugins': ['checkbox', 'search', 'sort'],
            'checkbox': {
                'keep_selected_style': false
            },
            // Filter rather than highlight, and accept common names.
            //
            // The default search adds a class to matching anchors and leaves
            // the rest in place, which on SGD's 134 nucleotide rows means
            // hunting for a tint. show_only_matches hides the rest,
            // and show_only_matches_children keeps a matched species folder's
            // databases visible, since the folder is not the thing you select.
            'search': {
                'show_only_matches': true,
                'show_only_matches_children': true,
                'search_callback': function (str, node) {
                    return nodeMatchesQuery(str, node.text);
                }
            }
        };

        // Add custom sort if we have a matching config
        if (matchedConfig) {
            const strainGroups = matchedConfig.strainGroups || {};
            const typeOrder = matchedConfig.typeOrder || {};
            const defaultStrainOrder = matchedConfig.defaultStrainOrder || 99;
            const defaultTypeOrder = matchedConfig.defaultTypeOrder || 99;

            jstreeConfig.sort = function(a, b) {
                const nodeA = this.get_node(a);
                const nodeB = this.get_node(b);
                const textA = nodeA.text || '';
                const textB = nodeB.text || '';

                // Get strain group priority from config
                const getStrainGroup = (text) => {
                    for (const [strain, order] of Object.entries(strainGroups)) {
                        if (text.includes(strain)) return order;
                    }
                    return defaultStrainOrder;
                };

                // Get type priority from config
                const getTypeOrder = (text) => {
                    for (const [type, order] of Object.entries(typeOrder)) {
                        if (text.includes(type)) return order;
                    }
                    return defaultTypeOrder;
                };

                const groupA = getStrainGroup(textA);
                const groupB = getStrainGroup(textB);

                // First sort by strain group
                if (groupA !== groupB) {
                    return groupA - groupB;
                }

                // Then sort by database type within the same group
                const typeA = getTypeOrder(textA);
                const typeB = getTypeOrder(textB);

                if (typeA !== typeB) {
                    return typeA - typeB;
                }

                // If same group and type, sort alphabetically
                return textA.localeCompare(textB);
            };
        }

        $(tree_id).jstree(jstreeConfig);

        // Open the whole tree once it is ready.
        //
        // This replaced 140 lines that opened nodes by matching their text
        // against hardcoded names, one branch of ifs per MOD: the
        // Caenorhabditis folder and then the elegans folder for WormBase as
        // long as the text was not briggsae, brenneri, remanei or japonica,
        // and the same shape again for FlyBase, RGD, SGD fungal and ZFIN.
        // Every deployment it did not name was left collapsed, ALLIANCE among
        // them, and a renamed species silently stopped matching.
        //
        // Opening everything needs no such list. The trees are small enough
        // for it: the largest is FlyBase's 200 nucleotide nodes, and a
        // database now sits two levels down rather than four, since
        // Database.display_categories drops the leaf that repeated its parent
        // and joins a genus to its species epithet.
        $(tree_id).on('ready.jstree', function () {
            $(tree_id).jstree('open_all');
        });

        // Bind once. handleLoadTree runs on every click of the tree, and
        // off('search.jstree') would take jstree's own show_only_matches
        // handler with it, since that is bound to this same element under the
        // same event name.
        if (!this.searchMissBound[category]) {
            this.searchMissBound[category] = true;
            $(tree_id).on('search.jstree', function (_e, data) {
                if (data.str && data.res.length === 0) {
                    _this.handleSearchMiss(category, $(tree_id).jstree(true), data.str);
                }
            });
        }
    }

    selectDatabases(databases) {
        this.setState({ currentlySelectedDatabases: databases });
    }

    /**
     * Select or clear every database in a category.
     *
     * The inherited implementation only sets React state. That updates the
     * hidden checkboxes the form submits, but leaves jstree showing nothing
     * selected — and because the tree's own select handler rebuilds state from
     * jstree, the next click on any node silently undoes it. So drive the tree
     * as well, and set state directly rather than relying on the events jstree
     * fires for a bulk change.
     */
    handleToggle(toggleState, category) {
        const selectAll = toggleState === '[Select all]';
        const tree = $(`#${category}_database_tree`);

        if (tree.jstree(true)) {
            if (selectAll) {
                tree.jstree('select_all');
            } else {
                tree.jstree('deselect_all');
            }
        }

        this.selectDatabases(selectAll ? this.databases(category) : []);
    }

    handleTreeSearch(category, tree_id, search_id) {
        var search_for = ($('#' + search_id).val() || '').trim();
        var tree = $('#' + tree_id).jstree(true);
        if (!tree) return;

        // Undo a previous miss before searching again.
        //
        // jstree's show_only_matches acts only when something matched, so a
        // query matching nothing would leave the whole tree on display and
        // read as "everything matches". handleSearchMiss hides it instead,
        // and putting it back is ours to do for the same reason.
        if (this.state.searchMisses[category]) {
            tree.show_all();
            this.setState(function (prev) {
                return { searchMisses: Object.assign({}, prev.searchMisses, { [category]: false }) };
            });
        }

        // jstree treats an empty string as clear_search, so deleting the query
        // restores every node that show_only_matches hid.
        tree.search(search_for);
    }

    /**
     * Nothing matched, so show nothing and say why.
     */
    handleSearchMiss(category, tree, query) {
        tree.hide_all();
        this.setState(function (prev) {
            return { searchMisses: Object.assign({}, prev.searchMisses, { [category]: query }) };
        });
    }

    /**
     * Open or close every node in one tree.
     *
     * The tree arrives fully open, so these exist for getting back to that
     * state after a few collapses, and for folding a long deployment down to
     * its species list. FlyBase is the case that wants collapsing: 134
     * nucleotide databases under 66 species folders, 200 rows on one page.
     */
    handleTreeExpansion(category, open) {
        var tree = $(`#${category}_database_tree`).jstree(true);
        if (!tree) return;
        tree[open ? 'open_all' : 'close_all']();
    }

    renderDatabases(category) {
        // Panel name and column width.
        var panelTitle = category[0].toUpperCase() +
            category.substring(1).toLowerCase() + ' databases';
        var columnClass = this.categories().length === 1 ? 'col-span-2' : '';

        // Toggle button.
        var toggleState = '[Select all]';
        var toggleClass = 'px-2 text-base md:text-lg';
        var toggleShown = this.databases(category).length > 1;
        var toggleDisabled = this.state.type && this.state.type !== category;
        if (toggleShown && toggleDisabled) {
            toggleClass += ' text-gray-400';
        } else {
            toggleClass += ' text-seqblue';
        }
        if (!toggleShown) toggleClass += ' hidden';
        if (this.nselected() === this.databases(category).length) {
            toggleState = '[Deselect all]';
        }

        // JSX.
        return (
            <div className={columnClass} key={'DB_' + category}>
                <div>
                    <div className="border-b border-seqorange mb-2" id="database_list">
                        <h4 className="font-medium text-base md:text-lg">{panelTitle}</h4>
                        {
                            this.renderDatabaseSearch(category)
                        }
                        <button
                            type="button"
                            className={toggleClass}
                            disabled={toggleDisabled}
                            onClick={function () {
                                this.handleToggle(toggleState, category);
                            }.bind(this)}
                        >
                            {toggleState}
                        </button>
                        {this.renderExpansionControls(category)}
                    </div>
                    <ul className={'databases hidden text-lg ' + category}>
                        {
                            _.map(this.databases(category), _.bind(function (database, index) {
                                return (
                                    <li key={'DB_' + category + index}>
                                        {this.renderDatabase(database)}
                                    </li>
                                );
                            }, this))
                        }
                    </ul>
                </div>
                {
                    this.renderDatabaseTree(category)
		}
		<link
		 rel="stylesheet"
		 media="screen,print"
		 type="text/css"
		 href={`${window.location.origin}/blast/vendor/github/vakata/jstree@3.3.8/dist/themes/default/style.min.css`}
		/>
            </div>
        );
    }

    renderExpansionControls(category) {
        // Pointless where no node has children, which is every deployment
        // whose species each hold one database.
        var tree = this.props.tree[category] || [];
        var hasFolders = tree.some(function (node) { return node.parent === '#'; }) &&
            tree.some(function (node) { return node.parent !== '#'; });
        if (!hasFolders) return null;

        return (
            <span id={`${category}_tree_expansion`}>
                <button
                    type="button"
                    className="px-2 text-base md:text-lg text-seqblue"
                    id={`${category}_expand_all`}
                    onClick={_.bind(function () {
                        this.handleTreeExpansion(category, true);
                    }, this)}
                >
                    [Expand all]
                </button>
                <button
                    type="button"
                    className="px-2 text-base md:text-lg text-seqblue"
                    id={`${category}_collapse_all`}
                    onClick={_.bind(function () {
                        this.handleTreeExpansion(category, false);
                    }, this)}
                >
                    [Collapse all]
                </button>
            </span>
        );
    }

    renderDatabaseSearch(category) {
        var tree_id = category + '_database_tree';
        var search_id = tree_id + '_search';

        return (
            <input type='text' id={search_id} className='border rounded px-1' placeholder='Search, e.g. zebrafish'
                onKeyUp=
                    {
                        _.bind(function () {
                            this.handleTreeSearch(category, tree_id, search_id);
                        }, this)
                    }
            ></input>
        );
    }

    renderDatabaseTree(category) {
        const tree_id = category + '_database_tree';
        const data = this.props.tree[category];

        return (
            <div>
                <p className="text-xs text-gray-500 mb-1 italic">Use checkboxes to select databases. Search accepts a common name (zebrafish, worm, yeast) or a Latin one.</p>
                {this.state.searchMisses[category] ?
                    <p className="text-sm my-2" id={`${category}_search_miss`}>
                        No database matches <strong>{this.state.searchMisses[category]}</strong>.
                    </p>
                    : null}
                <div
                    id={tree_id}
                    className={'jstree_div'}
                    onClick=
                        {
                            _.bind(function () {
                                this.handleLoadTree(category);
                            }, this)
                        }
                >
                </div>
            </div>
        );
    }

}
