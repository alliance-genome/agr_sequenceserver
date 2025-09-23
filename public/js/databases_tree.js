import React from 'react';
import _ from 'underscore';
import Jstree from 'jstree';
import { Databases } from './databases';

export default class extends Databases {
    constructor(props) {
        super(props);
        this.handleLoadTree = this.handleLoadTree.bind(this);
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


        $(tree_id).jstree({
            'core': {
                'data': this.props.tree[category]
            },
            'plugins': ['checkbox', 'search', 'sort'],
            'checkbox': {
                'keep_selected_style': false
            }
        });

        // Expand specific nodes after tree is loaded for WormBase and FlyBase
        $(tree_id).on('ready.jstree', function () {
            // Check if this is WormBase
            const isWormBase = window.location.hostname.includes('wormbase') ||
                              window.location.pathname.includes('/WB/') ||
                              document.querySelector('img[alt*="wormbase" i]') ||
                              document.querySelector('img[src*="wormbase" i]');

            // Check if this is FlyBase
            const isFlyBase = window.location.hostname.includes('flybase') ||
                             window.location.pathname.includes('/FB/') ||
                             document.querySelector('img[alt*="flybase" i]') ||
                             document.querySelector('img[src*="flybase" i]');

            if (!isWormBase && !isFlyBase) {
                return; // Only run on WormBase or FlyBase pages
            }

            // Use setTimeout to ensure tree is fully rendered
            setTimeout(function() {
                const treeInstance = $(tree_id).jstree(true);
                if (!treeInstance) {
                    return;
                }

                const allNodes = treeInstance.get_json('#', { flat: true });

                allNodes.forEach(function(node) {
                    const nodeText = node.text ? node.text.toLowerCase() : '';

                    // WormBase: Expand C. elegans nodes
                    if (isWormBase) {
                        // 1. Caenorhabditis genus folder
                        if (nodeText === 'caenorhabditis' ||
                            nodeText.startsWith('caenorhabditis (')) {
                            treeInstance.open_node(node.id);
                        }
                        // 2. C. elegans species folder (but not other species)
                        else if ((nodeText === 'c. elegans' ||
                                 nodeText === 'elegans' ||
                                 nodeText.includes('c. elegans (') ||
                                 nodeText.includes('elegans (')) &&
                                !nodeText.includes('briggsae') &&
                                !nodeText.includes('brenneri') &&
                                !nodeText.includes('remanei') &&
                                !nodeText.includes('japonica')) {
                            treeInstance.open_node(node.id);
                        }
                    }

                    // FlyBase: Expand D. melanogaster nodes
                    if (isFlyBase) {
                        // 1. Drosophila genus folder
                        if (nodeText === 'drosophila' ||
                            nodeText.startsWith('drosophila (')) {
                            treeInstance.open_node(node.id);
                        }
                        // 2. D. melanogaster species folder (but not other species)
                        else if ((nodeText === 'd. melanogaster' ||
                                 nodeText === 'melanogaster' ||
                                 nodeText.includes('d. melanogaster (') ||
                                 nodeText.includes('melanogaster (')) &&
                                !nodeText.includes('simulans') &&
                                !nodeText.includes('yakuba') &&
                                !nodeText.includes('pseudoobscura') &&
                                !nodeText.includes('virilis') &&
                                !nodeText.includes('mojavensis')) {
                            treeInstance.open_node(node.id);
                        }
                    }
                });
            }, 500);
        });
    }

    selectDatabases(databases) {
        this.setState({ currentlySelectedDatabases: databases });
    }

    handleTreeSearch(category, tree_id, search_id) {
        var search_for = $('#' + search_id).val();
        $('#' + tree_id).jstree(true).search(search_for);
    }

    renderDatabases(category) {
        // Panel name and column width.
        var panelTitle = category[0].toUpperCase() +
            category.substring(1).toLowerCase() + ' databases';
        var columnClass = this.categories().length === 1 ? 'col-span-2' : '';

        // Toggle button.
        var toggleState = '[Select all]';
        var toggleClass = 'px-2 text-base md:text-lg hidden';
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

    renderDatabaseSearch(category) {
        var tree_id = category + '_database_tree';
        var search_id = tree_id + '_search';

        return (
            <input type='text' id={search_id} className='border rounded px-1' placeholder='Search...'
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
        );
    }

}
