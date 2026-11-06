import React, { Component } from 'react';

/**
 * The genes a hit's coordinates fall in, and their orthologues on demand.
 *
 * This is the half of the deployment that was missing. A cross-species BLAST
 * whose hits reach coordinates and never a gene is a coordinate lookup, and
 * until now the only gene link was WormBase's, which shells out to
 * jbrowse-nclist-cli per hit and needs a `gene_track` that eight of the nine
 * Alliance entries do not have.
 *
 * The genes arrive on the hit itself, from a per-assembly index built once per
 * Alliance release (lib/sequenceserver/gene_index.rb). Orthologues are fetched
 * per gene, only when asked, straight from the Alliance API: it answers
 * unauthenticated and returns an `access-control-allow-origin` for
 * blast.alliancegenome.org, so no Ruby route is in the way.
 */

const API = 'https://www.alliancegenome.org/api';

// The API paginates at 20 and reports the true count in `total`. A request
// without an explicit limit silently truncates: SGD:S000001855 has 51
// orthologues and returns 20 of them.
const LIMIT = 200;

/** One gene's orthologues: a list, an error, or neither yet. */
class Orthologues extends Component {
    constructor(props) {
        super(props);
        this.state = { status: 'idle', rows: [], total: 0, error: null };
        this.toggle = this.toggle.bind(this);
    }

    toggle() {
        if (this.state.status === 'open') {
            this.setState({ status: 'closed' });
            return;
        }
        if (this.state.status === 'closed' || this.state.status === 'done') {
            this.setState({ status: 'open' });
            return;
        }
        this.fetchOrthologues();
    }

    fetchOrthologues() {
        this.setState({ status: 'loading' });
        fetch(`${API}/gene/${encodeURIComponent(this.props.curie)}/orthologs?limit=${LIMIT}`)
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then((data) => {
                const rows = (data.results || []).map((result) => {
                    // The payload key is geneToGeneOrthologyGenerated. An
                    // earlier reading of the API called it
                    // geneToGeneOrthology, which is absent and would have made
                    // every row blank.
                    const orthology = result.geneToGeneOrthologyGenerated || {};
                    const gene = orthology.objectGene || {};
                    return {
                        curie: gene.primaryExternalId || gene.curie,
                        symbol: (gene.geneSymbol || {}).displayText,
                        species: (gene.taxon || {}).name,
                        methods: (orthology.predictionMethodsMatched || []).length,
                        strict: orthology.strictFilter === true,
                    };
                }).filter((row) => row.curie);
                this.setState({
                    status: 'open',
                    rows: rows,
                    total: typeof data.total === 'number' ? data.total : rows.length,
                });
            })
            .catch((error) => {
                this.setState({ status: 'error', error: error.message });
            });
    }

    label() {
        switch (this.state.status) {
        case 'loading': return 'loading orthologues…';
        case 'open': return `hide ${this.state.rows.length} orthologues`;
        case 'error': return 'orthologues unavailable';
        default: return 'orthologues';
        }
    }

    rowsJSX() {
        if (this.state.status !== 'open') return null;

        if (!this.state.rows.length) {
            // A gene the Alliance holds no orthology for. The API answers 200
            // with total=0 for these, so the status code is not the signal.
            return <div className="ml-4 text-sm text-gray-500">No orthologues recorded.</div>;
        }

        // Grouped by species, because the question a cross-species result
        // raises is which organisms carry a counterpart, not the order the API
        // returned them in.
        const bySpecies = {};
        this.state.rows.forEach((row) => {
            const key = row.species || 'Unknown species';
            bySpecies[key] = bySpecies[key] || [];
            bySpecies[key].push(row);
        });

        const truncated = this.state.total > this.state.rows.length;
        return (
            <div className="ml-4 text-sm">
                {Object.keys(bySpecies).sort().map((species) => (
                    <div key={species} className="my-1">
                        <em>{species}</em>{': '}
                        {bySpecies[species].map((row, i) => (
                            <span key={row.curie}>
                                {i > 0 ? ', ' : ''}
                                <a
                                    href={`https://www.alliancegenome.org/gene/${encodeURIComponent(row.curie)}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-seqblue hover:text-seqorange"
                                    title={`${row.methods} prediction methods agree`}
                                >
                                    {row.symbol || row.curie}
                                </a>
                                {!row.strict && <span className="text-gray-400" title="not a stringent match">*</span>}
                            </span>
                        ))}
                    </div>
                ))}
                {truncated &&
                    <div className="text-gray-500">
                        Showing {this.state.rows.length} of {this.state.total}.
                    </div>}
            </div>
        );
    }

    render() {
        return (
            <span>
                {' '}
                <button
                    type="button"
                    className="text-seqblue hover:text-seqorange underline text-sm"
                    data-orthologues={this.props.curie}
                    onClick={this.toggle}
                    disabled={this.state.status === 'loading'}
                >
                    {this.label()}
                </button>
                {this.state.status === 'error' &&
                    <span className="ml-1 text-sm text-gray-500" title={this.state.error}>
                        (the Alliance API did not answer)
                    </span>}
                {this.rowsJSX()}
            </span>
        );
    }
}

export default class HitGenes extends Component {
    render() {
        const genes = this.props.genes || [];
        if (!genes.length) return null;

        return (
            <div className="hit-genes text-sm my-1 print:hidden" data-hit-genes={genes.length}>
                <span className="font-semibold">
                    {genes.length === 1 ? 'Gene at this location:' : 'Genes at this location:'}
                </span>
                {genes.map((gene) => (
                    <div key={`${gene.name}-${gene.start}`} className="ml-2 my-1">
                        {gene.curie
                            ? <a
                                href={`https://www.alliancegenome.org/gene/${encodeURIComponent(gene.curie)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-seqblue hover:text-seqorange"
                            >
                                {gene.name || gene.curie}
                            </a>
                            // No curie, so no Alliance gene page and no
                            // orthologue query. Ordinary rather than broken:
                            // Danio rerio carries a curie on 45.8% of its gene
                            // rows and Xenopus laevis on 63.0%, so the name is
                            // all there is for roughly 49,000 of 365,684
                            // genes.
                            : <span>{gene.name || 'unnamed gene'}</span>}
                        <span className="ml-1 text-gray-500">
                            {gene.start.toLocaleString()}..{gene.end.toLocaleString()}
                        </span>
                        {gene.curie && <Orthologues curie={gene.curie} />}
                    </div>
                ))}
            </div>
        );
    }
}
