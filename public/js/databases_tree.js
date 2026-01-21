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

        // Expand specific nodes after tree is loaded for WormBase, FlyBase, and RGD
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

            // Check if this is RGD
            const isRGD = window.location.hostname.includes('rgd') ||
                         window.location.pathname.includes('/RGD/') ||
                         document.querySelector('img[alt*="rgd" i]') ||
                         document.querySelector('img[src*="rgd" i]');

            // Check if this is SGD fungal (pathname contains SGD and ends with 'f')
            const isSGDFungal = (window.location.pathname.includes('/SGD/') ||
                                window.location.hostname.includes('sgd') ||
                                document.querySelector('img[alt*="sgd" i]') ||
                                document.querySelector('img[src*="sgd" i]')) &&
                               /\/[^/]+f$/.test(window.location.pathname.replace(/\/$/, ''));

            // Check if this is ZFIN
            const isZFIN = window.location.hostname.includes('zfin') ||
                          window.location.pathname.includes('/ZFIN/') ||
                          document.querySelector('img[alt*="zfin" i]') ||
                          document.querySelector('img[src*="zfin" i]');

            if (!isWormBase && !isFlyBase && !isRGD && !isSGDFungal && !isZFIN) {
                return; // Only run on WormBase, FlyBase, RGD, SGD fungal, or ZFIN pages
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

                    // RGD: Expand R. norvegicus nodes
                    if (isRGD) {
                        // 1. Rattus genus folder
                        if (nodeText === 'rattus' ||
                            nodeText.startsWith('rattus (')) {
                            treeInstance.open_node(node.id);
                        }
                        // 2. R. norvegicus species folder
                        else if (nodeText === 'r. norvegicus' ||
                                 nodeText === 'norvegicus' ||
                                 nodeText.includes('r. norvegicus (') ||
                                 nodeText.includes('norvegicus (')) {
                            treeInstance.open_node(node.id);
                        }
                    }

                    // SGD Fungal: Expand S. cerevisiae nodes
                    if (isSGDFungal) {
                        // 1. Saccharomyces genus folder
                        if (nodeText === 'saccharomyces' ||
                            nodeText.startsWith('saccharomyces (')) {
                            treeInstance.open_node(node.id);
                        }
                        // 2. S. cerevisiae species folder
                        else if (nodeText === 's. cerevisiae' ||
                                 nodeText === 'cerevisiae' ||
                                 nodeText.includes('s. cerevisiae (') ||
                                 nodeText.includes('cerevisiae (')) {
                            treeInstance.open_node(node.id);
                        }
                    }

                    // ZFIN: Expand D. rerio nodes
                    if (isZFIN) {
                        // 1. Danio genus folder
                        if (nodeText === 'danio' ||
                            nodeText.startsWith('danio (')) {
                            treeInstance.open_node(node.id);
                        }
                        // 2. D. rerio species folder
                        else if (nodeText === 'd. rerio' ||
                                 nodeText === 'rerio' ||
                                 nodeText.includes('d. rerio (') ||
                                 nodeText.includes('rerio (')) {
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
