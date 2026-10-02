import { Component } from 'react';

/**
 * Find a query sequence by gene symbol.
 *
 * SGD asked for this. The lookup behind it already existed as ?name=, but that
 * resolves a symbol to ONE record by taking the first database that matches --
 * fine for a deep link, wrong for a box someone types into. Sixteen of SGD's
 * fungal databases carry an "act1", so typing ACT1 there silently handed back
 * Candida albicans. Every candidate here names the organism it came from and
 * the user chooses.
 *
 * Both sequence types are searched. WormBase carries symbols only on its
 * protein databases -- its nucleotide sets are genome assemblies with no
 * locus= -- so filtering by the selected type would make the box useless there.
 *
 * Renders nothing where the deployment has no name indexes, so a MOD that
 * cannot answer a gene search does not advertise one.
 */
const DEBOUNCE_MS = 350;

export class GeneSearch extends Component {
    constructor(props) {
        super(props);
        this.state = { query: '', results: [], searching: false, searched: false, error: null };
        this.timer = null;
        this.requestId = 0;
        this.handleChange = this.handleChange.bind(this);
        this.handleSubmit = this.handleSubmit.bind(this);
        this.choose = this.choose.bind(this);
    }

    componentWillUnmount() {
        clearTimeout(this.timer);
        // Any reply still in flight belongs to a component that no longer
        // exists; bumping the id makes its handler a no-op.
        this.requestId++;
    }

    /** Everything before the trailing segment: /blast/SGD/R64-5-1m */
    basePath() {
        return window.location.pathname.replace(/\/+$/, '');
    }

    handleChange(event) {
        const query = event.target.value;
        this.setState({ query });
        clearTimeout(this.timer);

        if (!query.trim()) {
            this.requestId++;
            this.setState({ results: [], searching: false, searched: false, error: null });
            return;
        }

        // Debounced rather than floored at two characters: FlyBase has 17
        // single-character symbols (w, y, a, d, e, f ...), so a minimum length
        // would make them unsearchable on the MOD that asked for this.
        this.timer = setTimeout(() => this.search(query), DEBOUNCE_MS);
    }

    handleSubmit(event) {
        event.preventDefault();
        clearTimeout(this.timer);
        if (this.state.query.trim()) this.search(this.state.query);
    }

    search(query) {
        const id = ++this.requestId;
        this.setState({ searching: true, error: null });

        fetch(`${this.basePath()}/gene_search?q=${encodeURIComponent(query.trim())}`)
            .then((response) => {
                if (!response.ok) throw new Error(`search failed (${response.status})`);
                return response.json();
            })
            .then((results) => {
                // A slower earlier request must not overwrite a later one.
                if (id !== this.requestId) return;
                this.setState({ results, searching: false, searched: true });
            })
            .catch((error) => {
                if (id !== this.requestId) return;
                this.setState({ results: [], searching: false, searched: true, error: error.message });
            });
    }

    /**
     * Fetch the chosen record and hand it up. The caller puts it in the query
     * box and selects the database it came from, the same way an example does.
     */
    choose(candidate) {
        const token = document.querySelector('meta[name="_csrf"]');
        const body = new URLSearchParams({
            sequence_ids: candidate.accession,
            database_ids: candidate.database_id
        });
        if (token) body.append('_csrf', token.content);

        this.setState({ searching: true });
        fetch(`${this.basePath()}/get_sequence`, { method: 'POST', body })
            .then((response) => {
                if (!response.ok) throw new Error(`could not fetch the sequence (${response.status})`);
                return response.text();
            })
            .then((sequence) => {
                this.setState({ searching: false, results: [], searched: false, query: '' });
                this.props.onSelect(candidate, sequence);
            })
            .catch((error) => this.setState({ searching: false, error: error.message }));
    }

    resultsJSX() {
        const { results, searching, searched, error, query } = this.state;

        if (error) {
            return <div className="mt-1 text-sm text-red-700">{error}</div>;
        }
        if (searching) {
            return <div className="mt-1 text-sm text-gray-500">Searching…</div>;
        }
        if (searched && !results.length) {
            return (
                <div className="mt-1 text-sm text-gray-500">
                    No gene named <strong>{query.trim()}</strong> in this deployment’s databases.
                </div>
            );
        }
        if (!results.length) return null;

        return (
            <ul className="gene-search-results mt-1 border border-gray-300 rounded max-h-64 overflow-y-auto">
                {results.map((candidate, index) => (
                    <li key={`${candidate.database_id}-${index}`}>
                        <button
                            type="button"
                            className="w-full text-left text-sm px-2 py-1 hover:bg-gray-100 cursor-pointer flex gap-2 items-baseline"
                            title={`Load ${candidate.accession} and select ${candidate.database_title}`}
                            onClick={() => this.choose(candidate)}>
                            <strong className="font-semibold">{candidate.symbol}</strong>
                            {/* The organism is the point of the list: it is what
                                tells two identically-named genes apart. */}
                            <em className="text-gray-700">{candidate.organism || 'unknown organism'}</em>
                            <span className="text-gray-500">{candidate.database_title}</span>
                            <span className="ml-auto text-xs text-gray-500 whitespace-nowrap">
                                {candidate.type}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        );
    }

    render() {
        return (
            <div className="gene-search mt-2" id="gene-search">
                <form onSubmit={this.handleSubmit} className="flex gap-2 items-center">
                    <label htmlFor="gene-search-input" className="text-sm text-gray-600">
                        Or find a gene:
                    </label>
                    <input
                        id="gene-search-input"
                        type="search"
                        className="border rounded px-1 text-sm"
                        placeholder="gene symbol, e.g. ACT1"
                        autoComplete="off"
                        value={this.state.query}
                        onChange={this.handleChange}
                    />
                </form>
                {this.resultsJSX()}
            </div>
        );
    }
}
