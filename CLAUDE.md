# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

### Running SequenceServer
```bash
# Run from source (development mode with verbose logging)
bundle exec bin/sequenceserver -D

# Run from source (production mode)
bundle exec bin/sequenceserver

# Install Ruby dependencies
bundle install

# Install frontend dependencies
npm install
```

### Frontend Development
```bash
# Watch and auto-rebuild frontend changes during development
npm run watch

# Build minified JS and CSS for production
npm run build

# Build CSS only
npm run minify:css
```

### Testing
```bash
# Run all Ruby tests
bundle exec rspec

# Run specific Ruby test file
bundle exec rspec spec/foo_spec.rb

# Run specific test scenario
bundle exec rspec spec/foo_spec.rb -e 'test name'

# Run JavaScript tests
npm run test

# Run specific JavaScript test
npm run test -e "test name"

# Run JavaScript tests in specific file
npm run test file_name
```

### Code Quality
```bash
# Run all CodeClimate checks (requires CodeClimate installation)
codeclimate analyze

# Run specific linters
codeclimate analyze -e eslint    # JavaScript linting
codeclimate analyze -e rubocop   # Ruby linting
codeclimate analyze -e stylelint # CSS linting
```

## Architecture Overview

### Core Structure
SequenceServer is a Sinatra-based Ruby web application that provides a user-friendly interface for BLAST+ searches. The application follows this high-level architecture:

1. **Backend (Ruby/Sinatra)**
   - Entry point: `config.ru` → `lib/sequenceserver.rb`
   - Main server: `lib/sequenceserver/server.rb` 
   - Routes: `lib/sequenceserver/routes.rb` - handles HTTP endpoints for search, results, downloads
   - BLAST integration: `lib/sequenceserver/blast/` - manages BLAST job execution and result parsing
   - Database management: `lib/sequenceserver/database.rb` - handles BLAST database discovery and metadata

2. **Frontend (React/JavaScript)**
   - Search interface: `public/js/search.js` - main search page component
   - Results viewer: `public/js/report_root.js` - BLAST results visualization
   - Component structure: React components in `public/js/` handle different aspects of the UI
   - Build via Webpack: Configuration in `webpack.config.js`

3. **Configuration**
   - Main config: `~/.sequenceserver.conf` or specified via command line
   - Database location, BLAST parameters, server settings configured here
   - Plugin system: Extensions can be loaded from specified paths

4. **Job Management**
   - Jobs stored temporarily with configurable lifetime
   - Background job remover cleans up old results
   - Thread pool manages concurrent BLAST executions

### Key Design Patterns
- **Singleton configuration**: Global config object initialized once and accessed throughout
- **Plugin architecture**: Extensible via Ruby files that hook into the application
- **Streaming results**: Large BLAST outputs handled efficiently without loading entire files into memory
- **Database auto-discovery**: Automatically finds and indexes BLAST databases in configured directory

### Alliance Genome Customizations
This fork includes Alliance-specific customizations:
- Custom configuration in `public/configs/`
- Modified templates in `views/` for Alliance branding
- Additional logos and resources in `public/logos/`

## Dependencies

### Ruby (managed via Bundler)
- Ruby >= 3.0.6
- Sinatra 4.0 (web framework)
- Key gems: rest-client, rubyzip, rack_csrf

### JavaScript (managed via npm)
- React 18 (UI framework)
- jQuery 3.7.1 (DOM manipulation)
- D3 7.9.0 (visualizations)
- Webpack (bundling)

### External Requirements
- BLAST+ binaries (default version 2.16.0+)
- Database files in BLAST format