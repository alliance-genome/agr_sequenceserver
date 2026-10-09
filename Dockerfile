# Build variables. These need to be declared befored the first FROM
# for the variables to be accessible in FROM instruction.
# 2.16.0 is what the rest of the project already says it uses: CLAUDE.md names
# it twice, the CI workflow downloads it, and spec/fixtures' BLAST archive
# expects "BLASTN 2.16.0+" in the report, so report_spec cannot pass in an
# image built on 2.15.0. The Dockerfile was the only place still pinning the
# older one.
ARG BLAST_VERSION=2.16.0

## Stage 1: gem dependencies.
FROM docker.io/library/ruby:3.2-bookworm AS builder

# Copy over files required for installing gem dependencies.
WORKDIR /sequenceserver
COPY Gemfile Gemfile.lock sequenceserver.gemspec ./
COPY lib/sequenceserver/version.rb lib/sequenceserver/version.rb

# Install packages required for building gems with C extensions.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc make patch && rm -rf /var/lib/apt/lists/*

# Install gem dependencies using bundler.
RUN bundle install --without=development

## Stage 2: BLAST+ binaries.
# We will copy them from NCBI's docker image.
FROM docker.io/ncbi/blast-static:${BLAST_VERSION} AS ncbi-blast

## Stage 3: Puting it together.
FROM docker.io/library/ruby:3.2-bookworm AS final

LABEL Description="Intuitive local web frontend for the BLAST bioinformatics tool"
LABEL MailingList="https://groups.google.com/forum/#!forum/sequenceserver"
LABEL Website="http://sequenceserver.com"

# Install packages required to run SequenceServer and BLAST.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl libgomp1 && rm -rf /var/lib/apt/lists/*

# Copy gem dependencies and BLAST+ binaries from previous build stages.
COPY --from=builder /usr/local/bundle/ /usr/local/bundle/
COPY --from=ncbi-blast \
  /blast/bin/blast_formatter \
  /blast/bin/blastdbcmd \
  /blast/bin/blastn \
  /blast/bin/blastp \
  /blast/bin/blastx \
  /blast/bin/makeblastdb \
  /blast/bin/tblastn \
  /blast/bin/tblastx \
  /blast/bin/

# Add BLAST+ binaries to PATH.
ENV PATH=/blast/bin:${PATH}

# NCBI's taxonomy database, so that BLAST can turn the taxid baked into each
# BLAST database into a species name.
#
# Without it the `sscinames` column of the custom TSV report is the literal
# string "N/A" for every hit, on every deployment -- BLAST even says so:
# "Taxonomy name lookup from taxid requires installation of taxdb database".
# The front end gates its Species column on every hit having a name, so the
# column never appeared, and a cross-species result never named a species.
# That is the whole question /blast/ALLIANCE/prod/ exists to answer.
#
# Baked into the image rather than mounted. A mount is one more thing that has
# to be remembered on every `docker run`, and this deployment has already been
# bitten once by data that travelled separately from the code (the
# config/config-dev split that let production serve a 2024 config against 2026
# databases). ~195 MB uncompressed, which is small beside BLAST+ itself.
#
# Only taxdb.btd and taxdb.bti are needed. taxonomy4blast.sqlite3, also in that
# archive, is for taxid filtering (get_species_taxids.sh) and is not extracted.
RUN mkdir -p /blast/taxonomy \
    && curl -fsSL -o /tmp/taxdb.tar.gz https://ftp.ncbi.nlm.nih.gov/blast/db/taxdb.tar.gz \
    && curl -fsSL -o /tmp/taxdb.tar.gz.md5 https://ftp.ncbi.nlm.nih.gov/blast/db/taxdb.tar.gz.md5 \
    && (cd /tmp && md5sum -c taxdb.tar.gz.md5) \
    && tar -xzf /tmp/taxdb.tar.gz -C /blast/taxonomy taxdb.btd taxdb.bti \
    && rm -f /tmp/taxdb.tar.gz /tmp/taxdb.tar.gz.md5

# Where BLAST looks for taxdb. Database names are passed to BLAST as absolute
# paths (see BLAST::Job#command), so this cannot change which databases
# resolve -- it only adds the taxonomy lookup.
ENV BLASTDB=/blast/taxonomy

RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs
#RUN apt-get install -y nodejs npm
RUN npm i jbrowse-nclist-cli -g



# Setup working directory, volume for databases, port, and copy the code.
# SequenceServer code.
WORKDIR /sequenceserver
RUN mkdir /db
EXPOSE 4567
COPY . .

# Generate config file with default configs and database directory set to /db.
# Setting database directory in config file means users can pass command line
# arguments to SequenceServer without having to specify -d option again.
RUN mkdir -p /db && echo 'n' | script -qfec "bundle exec bin/sequenceserver -s config_file=/sequenceserver/public/configs/sequenceserver.conf -d /db" /dev/null

# Prevent SequenceServer from prompting user to join announcements list.
RUN mkdir -p ~/.sequenceserver && touch ~/.sequenceserver/asked_to_join

# Add SequenceServer's bin directory to PATH and set ENTRYPOINT to
# 'bundle exec'. Combined, this simplifies passing command-line
# arguments to SequenceServer, while retaining the ability to run
# bash in the container.
ENV PATH=/sequenceserver/bin:${PATH}
ENTRYPOINT ["bundle", "exec"]

# Name the config explicitly. Started without -c, SequenceServer falls back to
# ~/.sequenceserver.conf (written by the -s step above) and then to its own
# defaults, and serves a Settings panel with one undescribed preset per method
# and no -max_target_seqs -- none of what public/configs/sequenceserver.conf
# says. It starts and answers every request, so the only symptom is a quietly
# wrong options list. Anyone running `docker run <image>` gets the right config
# now, rather than having to know to repeat this flag.
CMD ["sequenceserver", "-c", "/sequenceserver/public/configs/sequenceserver.conf"]

## Stage 4 (optional) minify CSS & JS.
FROM node:20-alpine AS node

RUN apk add --no-cache git
WORKDIR /usr/src/app
COPY ./package.json ./package-lock.json ./webpack.config.js ./babel.config.js ./
RUN npm install
ENV PATH=${PWD}/node_modules/.bin:${PATH}
COPY public public
RUN apk add --no-cache tree
RUN tree public
RUN npm run-script build

## Stage 5 (optional) minify
FROM final AS minify

COPY --from=node /usr/src/app/public/sequenceserver-*.min.js public/
COPY --from=node /usr/src/app/public/css/sequenceserver.min.css public/css/

## Stage 6 (optional) Pull the example database from the debian package.
FROM docker.io/library/ruby:3.2-bookworm AS example_db

WORKDIR /tmp
RUN apt-get update && apt-get download ncbi-blast+ && dpkg-deb -xv ncbi-blast+*.deb .

FROM final AS dev

RUN bundle install

COPY --from=example_db /tmp/usr/share/doc/ncbi-blast+/examples /db/

VOLUME ["/db"]

FROM final

VOLUME ["/db"]
