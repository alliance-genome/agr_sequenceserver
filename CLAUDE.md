# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This is the **Alliance of Genome Resources (AGR) fork** of SequenceServer, a Sinatra-based Ruby web app providing a UI for BLAST+ searches. The fork adds multi-MOD support (WormBase, FlyBase, SGD, RGD, ZFIN, XenBase, MGD), JBrowse genome browser integration, and Alliance branding.

## Build and Development Commands

```bash
# Install dependencies
bundle install
npm install

# Run in development mode (verbose logging)
bundle exec bin/sequenceserver -D

# Frontend: watch for changes and auto-rebuild JS
npm run watch

# Frontend: production build (webpack + tailwind CSS minification)
npm run build

# Build CSS only
npm run minify:css

# Run all Ruby tests
bundle exec rspec

# Run specific Ruby test
bundle exec rspec spec/foo_spec.rb -e 'test name'

# Run all JavaScript tests
npm run test

# Run JavaScript tests in specific file
npm run test file_name

# Linting (requires CodeClimate)
codeclimate analyze -e eslint     # JavaScript
codeclimate analyze -e rubocop    # Ruby
codeclimate analyze -e stylelint  # CSS
```

**Important:** If you change frontend code (JS/CSS), build and commit the resulting minified bundles before opening a PR. The test suite runs in production mode.

## Architecture Overview

### URL Structure (Key Difference from Upstream)

All routes use the pattern `/blast/:mod/:version/...` where:
- `:mod` = MOD identifier (`WB`, `FB`, `SGD`, `RGD`, `ZFIN`, `XB`, `MGD`)
- `:version` = data version (e.g., `WS297`, `FB2024`)

Databases are loaded per-request from `/db/{mod}/{version}/databases/`. Environment config (genome browser metadata) is read from `public/environments/{mod}/{version}/environment.json`.

### Backend (Ruby/Sinatra)

- **Entry:** `config.ru` → `lib/sequenceserver.rb` (singleton init)
- **Routes:** `lib/sequenceserver/routes.rb` — all HTTP endpoints; databases loaded per-request based on URL path segments
- **BLAST job:** `lib/sequenceserver/blast/job.rb` → `query.rb` → `hit.rb` → `hsp.rb`
- **Result parsing:** `lib/sequenceserver/blast/report.rb` uses Ox SAX parser for streaming XML
- **Links/JBrowse:** `lib/sequenceserver/links.rb` — generates JBrowse 1 & 2 URLs with MOD-specific chromosome name extraction
- **Config files:** `conf/sequenceserver.{wormbase,flybase,sgd,xenbase}.conf`

### Frontend (React/Webpack)

Two webpack entry points produce two bundles:
- `public/js/search.js` → `sequenceserver-search.min.js` (search form page)
- `public/js/report_root.js` → `sequenceserver-report.min.js` (results page)

**Search page component tree:**
```
Page (search.js) → Form (form.js)
  ├── SearchQueryWidget (query.js)     — textarea + sequence type detection
  ├── DatabasesTree (databases_tree.js) — JSTree widget with MOD-specific auto-expansion
  ├── Options (options.js)             — e-value, max hits, task dropdowns
  └── SearchButton (search_button.js)
```

**Report page component tree:**
```
Page (report_root.js) → Report (report.js)
  ├── Sidebar (sidebar.js)
  ├── GraphicalOverview (graphical_overview.js)
  └── Hits (hits.js) — renders in 25ms batches for responsiveness
       └── Hit (hit.js) → HSP (hsp.js)
```

**Plugin system (webpack aliases):** Six extension points in `webpack.config.js` alias to `public/js/null_plugins/` by default. Override with `--env=pluginsPath=../real_plugins`:
- `report_plugins`, `download_links`, `hit_buttons`, `search_header_plugin`, `query_stats`, `histogram`

### Alliance-Specific Customizations

- **JBrowse links** (`lib/sequenceserver/links.rb`): MOD-specific chromosome extraction (WormBase Roman numerals, FlyBase arm names, RGD ChrN format). Generates links for both JBrowse 1 and JBrowse 2. Gene-level links use `jbrowse-nclist-cli`.
- **Database ordering** (`public/configs/database_order.json`): Sort rules for SGD strains/types and RGD assembly versions
- **JSTree auto-expansion** (`public/js/databases_tree.js`): Auto-opens the relevant species node based on URL MOD segment
- **Task dropdown defaulting** (`public/js/options.js`): Defaults to match selected BLAST method
- **Layout** (`views/layout.erb`): Alliance branding, dynamic MOD logos from `alliancegenome.org` asset manifest, BETA ribbon, citation text
- **HTTPS detection**: Custom logic for `alliancegenome.org` deployments behind proxies (checks `HTTP_X_FORWARDED_PROTO`)

### Docker

Multi-stage `Dockerfile`: Ruby 3.2, BLAST+ 2.16.0, Node.js 20, `jbrowse-nclist-cli`. `docker-compose.yaml` defines per-MOD services (wb, fb, sgd, xenbase) on ports 5001-5004, each with its own conf file and database volume.

## Dependencies

- **Ruby** >= 3.0.6, Sinatra 4.0, Ox (SAX XML parser), rest-client, rubyzip
- **JavaScript**: React 18, jQuery 3.7, D3 7.9, JSTree, Webpack 5, Tailwind CSS 3.4
- **External**: BLAST+ 2.16.0+, optionally `jbrowse-nclist-cli` for gene links
- **Testing**: RSpec + Capybara (Ruby), Jest + React Testing Library (JS)
