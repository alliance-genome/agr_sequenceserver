import './jquery_world'; // for custom $.tooltip function
import React, { Component } from 'react';

import Sidebar from './sidebar';
import AlignmentExporter from './alignment_exporter';
import ReportPlugins from 'report_plugins';
import RunSummary from './report/run_summary';
import GraphicalOverview from './report/graphical_overview';
import AlignmentResults from './report/alignment_results';
import Utils from './utils';

/**
 * Renders entire report.
 *
 * Composed of Query and Sidebar components.
 */

class Report extends Component {
    constructor(props) {
        super(props);
        // Properties below are internal state used to render results in small
        // slices (see updateState).
        this.state = {
            user_warning: null,
            download_links: [],
            search_id: '',
            seqserv_version: '',
            program: '',
            program_version: '',
            submitted_at: '',
            results: [],
            queries: [],
            querydb: [],
            params: [],
            stats: [],
            alignment_blob_url: '',
            allQueriesLoaded: false,
        };
        this.prepareAlignmentOfAllHits = this.prepareAlignmentOfAllHits.bind(this);
        this.setStateFromJSON = this.setStateFromJSON.bind(this);
        this.plugins = new ReportPlugins(this);
    }

    /**
   * Fetch results.
   */
    fetchResults() {
        const path = location.pathname + '.json' + location.search;
        this.pollPeriodically(path, this.setStateFromJSON, this.props.showErrorModal);
    }

    pollPeriodically(path, callback, errCallback) {
    var intervals = [200, 400, 800, 1200, 2000, 3000, 5000];
        function poll() {
            fetch(path)
                .then(response => {
                    // Handle HTTP status codes
                    if (!response.ok) throw response;

                    return response.text().then(data => {
                        if (data) {
                            data = parseJSON(data);
                        };
                        return { status: response.status, data }
                    });
                })
                .then(({ status, data }) => {
                    switch (status) {
                        case 202:
                            var interval;
                            if (intervals.length === 1) {
                                interval = intervals[0];
                            } else {
                                interval = intervals.shift();
                            }
                            setTimeout(poll, interval);
                            break;
                        case 200:
                            callback(data);
                            break;
                    }
                })
                .catch(error => {
                    if (error.text) {
                        error.text().then(errData => {
                            errData = parseJSON(errData);
                            switch (error.status) {
                                case 400:
                                case 422:
                                case 500:
                                    errCallback(errData);
                                    break;
                                default:
                                    console.error("Unhandled error:", error.status);
                            }
                        });
                    } else {
                        console.error("Network error:", error);
                    }
                });
        }

        function parseJSON(str) {
            let parsedJson = str;
            try {
                parsedJson = JSON.parse(str);
            } catch (e) {
                console.error("Error parsing JSON:", e);
            }

            return parsedJson;
        }
        poll();
    }

    /**
   * Calls setState after any required modification to responseJSON.
   */
    setStateFromJSON(responseJSON) {
        this.lastTimeStamp = Date.now();
        // the callback prepares the download link for all alignments
        if (responseJSON.user_warning == 'LARGE_RESULT') {
            this.setState({user_warning: responseJSON.user_warning, download_links: responseJSON.download_links});
        } else {
            this.setState(responseJSON, this.prepareAlignmentOfAllHits);
        }
    }

    /**
   * Called as soon as the page has loaded and the user sees the loading spinner.
   * We use this opportunity to setup services that make use of delegated events
   * bound to the window, document, or body.
   */
    componentDidMount() {
        this.fetchResults();
        // This sets up an event handler which enables users to select text from
        // hit header without collapsing the hit.
        this.preventCollapseOnSelection();
        this.toggleTable();
    }

    /**
   * Called after all results have been rendered.
   */
    componentFinishedUpdating() {
        if (this.state.allQueriesLoaded) return;
        this.shouldShowIndex() && this.setupScrollSpy();
        this.setState({ allQueriesLoaded: true });
    }

    /**
   * Returns loading message
   */
    loadingJSX() {
        return (
            <div className="grid grid-cols-6 gap-4">
                <div className="col-start-1 col-end-7 text-center pt-3">
                    <h1 className="mb-8 text-4xl">
                        <i className="fa fa-cog fa-spin"></i>&nbsp; BLAST-ing
                    </h1>
                    <div className="mb-5 w-full">
                        <p className="m-auto w-full md:w-6/12 text-sm">This can take some time depending on the size of your query and
                        database(s). The page will update automatically when BLAST is done.</p>
                    </div>
                    <p className="mb-9 text-sm">
                        You can bookmark the page and come back to it later or share the
                        link with someone.
                    </p>
                    <p className="text-sm">
                        { process.env.targetEnv === 'cloud' && <b>If the job takes more than 10 minutes to complete, we will send you an email upon completion.</b> }
                    </p>
                </div>
            </div>
        );
    }

    /* eslint-disable */
    /**
   * Return results JSX.
   */
    /**
     * Says so when the result is known to be missing alignments.
     *
     * BLAST reports a hit once per sequence id across every database searched
     * together, so where two of them use the same ids the later one's
     * alignments are dropped from the output. Nothing in BLAST's output says
     * this happened. On the Alliance deployment it is the difference between
     * "mouse has no actin" and "mouse was never reported": a nine-genome
     * tblastn returned 131 hits with no mouse among them, while mouse on its
     * own returns 20 at evalue 0.0.
     *
     * This is deliberately a warning and not a list of absent organisms. The
     * plan this came from proposed rendering "no hits: Mus musculus", which
     * would state as fact the one thing that is false here.
     */
    incompleteResultNoticeJSX() {
        var shared = this.state.shared_accessions;
        if (!shared || !shared.count) return null;

        return (
            <div className="my-2 px-3 py-2 border border-amber-400 bg-amber-50 text-sm rounded"
                id="shared-accession-notice" role="alert">
                <strong>This result is incomplete.</strong>{' '}
                {shared.count === 1 ? 'One sequence id is' : shared.count + ' sequence ids are'}
                {' '}used by more than one of the databases searched
                ({shared.databases.join(', ')}){shared.examples && shared.examples.length
                    ? ' — for example ' + shared.examples.join(', ') : ''}.
                {' '}BLAST reports such a sequence once, so alignments from the
                other databases are missing from this page rather than absent
                from the data. Search those databases one at a time to see them.
            </div>
        );
    }

    /**
     * Which organisms answered, and how many hits each contributed.
     *
     * The first question a cross-species result raises, and one the hit list
     * does not answer at a glance: selecting nine genomes and hearing back
     * from seven IS the result. Shown only where more than one organism
     * replied, so single-organism reports are unchanged.
     */
    organismSummaryJSX() {
        var counts = {};
        (this.state.queries || []).forEach(function (query) {
            (query.hits || []).forEach(function (hit) {
                var name = Utils.speciesName(hit);
                if (name) counts[name] = (counts[name] || 0) + 1;
            });
        });
        var names = Object.keys(counts).sort(function (a, b) {
            return counts[b] - counts[a] || a.localeCompare(b);
        });
        if (names.length < 2) return null;

        return (
            <div className="my-2 text-sm" id="organism-summary">
                <span className="font-semibold">Organisms with hits:</span>{' '}
                {names.map(function (name, i) {
                    return (
                        <span key={name}>
                            {i > 0 ? ', ' : ''}
                            <em>{name}</em> ({counts[name]})
                        </span>
                    );
                })}
            </div>
        );
    }

    resultsJSX() {
        return (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 print:grid-cols-1" id="results">
                <div className="hidden md:col-span-1 md:block print:hidden">
                    <Sidebar
                        data={this.state}
                        atLeastOneHit={this.atLeastOneHit()}
                        shouldShowIndex={this.shouldShowIndex()}
                        allQueriesLoaded={this.state.allQueriesLoaded}
                    />
                </div>
                <div className="col-span-1 md:col-span-3 print:col-span-1">
                    <RunSummary
                        seqserv_version={this.state.seqserv_version}
                        program_version={this.state.program_version}
                        submitted_at={this.state.submitted_at}
                        querydb={this.state.querydb}
                        stats={this.state.stats}
                        params={this.state.params}
                    />
                    {this.incompleteResultNoticeJSX()}
                    {this.organismSummaryJSX()}
                    <GraphicalOverview
                        queries={this.state.queries}
                        prorgam={this.state.program}
                        plugins={this.plugins}
                    />
                    <AlignmentResults
                        state={this.state}
                        populate_hsp_array={this.populate_hsp_array.bind(this)}
                        componentFinishedUpdating={(_) => this.componentFinishedUpdating(_)}
                        plugins={this.plugins}
                        {...this.props}
                    />
                </div>
            </div>
        );
    }
    /* eslint-enable */


    warningJSX() {
        return(
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div className="grid grid-cols-6 gap-4">
                    <div className="col-start-1 col-end-7 text-center">
                        <h1 className="mb-4 text-4xl">
                            <i className="fa fa-exclamation-triangle"></i>&nbsp; Warning
                        </h1>
                        <p className="mb-2">
                            The BLAST result might be too large to load in the browser. If you have a powerful machine you can try loading the results anyway. Otherwise, you can download the results and view them locally.
                        </p>
                        <p className="mb-2">
                            {this.state.download_links.map((link, index) => {
                                return (
                                    <a href={link.url} className="btn btn-secondary" key={'download_link_' + index} >
                                        {link.name}
                                    </a>
                                );
                            })}
                        </p>
                        <p>
                            <a href={location.pathname + '?bypass_file_size_warning=true'} className="py-2 px-3 border border-transparent rounded-md shadow-sm text-white bg-seqblue hover:bg-seqorange focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-seqorange">
                                View results in browser anyway
                            </a>
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // Controller //

    /**
   * Returns true if results have been fetched.
   *
   * A holding message is shown till results are fetched.
   */
    isResultAvailable() {
        return this.state.queries.length >= 1;
    }

    /**
     * Indicates the response contains a warning message for the user
     * in which case we should not render the results and render the
     * warning instead.
     **/
    isUserWarningPresent() {
        return this.state.user_warning;
    }

    /**
   * Returns true if we have at least one hit.
   */
    atLeastOneHit() {
        return this.state.queries.some((query) => query.hits.length > 0);
    }

    /**
   * Returns true if index should be shown in the sidebar. Index is shown
   * only for 2 and 8 queries.
   */
    shouldShowIndex() {
        var num_queries = this.state.queries.length;
        return num_queries >= 2 && num_queries <= 12;
    }

    /**
   * Prevents folding of hits during text-selection.
   */
    preventCollapseOnSelection() {
        $('body').on('mousedown', '.hit > .section-header > h4', function (event) {
            var $this = $(this);
            $this.on('mouseup mousemove', function handler(event) {
                if (event.type === 'mouseup') {
                    // user wants to toggle
                    var hitID = $this.parents('.hit').attr('id');
                    $(`div[data-parent-hit=${hitID}]`).toggle();
                    $this.find('i').toggleClass('fa-square-minus fa-square-plus');
                    $($this.data('parent-id')).toggleClass('print:hidden');
                } else {
                    // user wants to select
                    $this.attr('data-toggle', '');
                }
                $this.off('mouseup mousemove', handler);
            });
        });
    }

    /* Handling the fa icon when Hit Table is collapsed */
    /* TODO:JOKO check if this method still being used? */
    toggleTable() {
        $('body').on(
            'mousedown',
            '.resultn .caption[data-toggle="collapse"]',
            function (event) {
                var $this = $(this);
                $this.on('mouseup mousemove', function handler(event) {
                    $this.find('i').toggleClass('fa-square-minus fa-square-plus');
                    $this.off('mouseup mousemove', handler);
                });
            }
        );
    }



    /**
   * For the query in viewport, highlights corresponding entry in the index.
   */
    setupScrollSpy() {
        var sectionIds = $('a.side-nav');

        $(document).scroll(function(){
            sectionIds.each(function(){

                var container = $(this).attr('href');
                var containerOffset = $(container).offset().top;
                var containerHeight = $(container).outerHeight();
                var containerBottom = containerOffset + containerHeight;
                var scrollPosition = $(document).scrollTop();

                if(scrollPosition < containerBottom - 20 && scrollPosition >= containerOffset - 20){
                    $(this).addClass('active');
                } else {
                    $(this).removeClass('active');
                }
            });
        });
    }

    populate_hsp_array(hit, query_id){
        return hit.hsps.map(hsp => Object.assign(hsp, {hit_id: hit.id, query_id}));
    }

    prepareAlignmentOfAllHits() {
        // Get number of hits and array of all hsps.
        var num_hits = 0;
        var hsps_arr = [];
        if(!this.state.queries.length){
            return;
        }
        this.state.queries.forEach(
            (query) => query.hits.forEach(
                (hit) => {
                    num_hits++;
                    hsps_arr = hsps_arr.concat(this.populate_hsp_array(hit, query.id));
                }
            )
        );

        var aln_exporter = new AlignmentExporter();
        var file_name = `alignment-${num_hits}_hits.txt`;
        const blob_url = aln_exporter.prepare_alignments_for_export(hsps_arr, file_name);
        $('.download-alignment-of-all')
            .attr('href', blob_url)
            .attr('download', file_name);
        return false;
    }

    render() {
        if (this.isUserWarningPresent()) {
            return this.warningJSX();
        } else if (this.isResultAvailable()) {
            return this.resultsJSX();
        } else {
            return this.loadingJSX();
        }
    }
}

export default Report;
