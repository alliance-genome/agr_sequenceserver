module SequenceServer
  # Define BLAST::Hit.
  module BLAST
    # Hit object to store all the hits per Query.
    Hit = Struct.new(:query, :number, :id, :accession, :title,
                     :length, :sciname, :qcovs, :hsps) do
      def initialize(*args)
        args[1] = args[1].to_i
        args[4] = '' if args[4] == 'No definition line'
        args[5] = args[5].to_i
        args[6] = '' if args[6] == 'N/A'
        args[7] = args[7].to_i
        super(*args)
      end

      # This gets called when #to_json is called on report object in routes. We
      # cannot use the to_json method provided by Struct class because what we
      # want to send to the browser differs from the attributes declared with
      # Struct class. Some of these are derived data such as score, identity,
      # custom links. While some attributes are necessary for internal
      # representation.
      def to_json(*args)
        # List all attributes that we want to send to the browser.
        properties = %i[number id accession title length total_score
                        qcovs sciname hsps links gene_symbol]
        properties.inject({}) { |h, k| h[k] = send(k); h }.to_json(*args)
      end

      ###
      # Link generator functionality.
      ###

      # Include the Links module.
      include Links

      # The gene symbol this hit's defline names, or nil. Sent to the client so
      # the hit list can lead with the symbol rather than the accession: a
      # FlyBase hit list of FBpp identifiers does not tell a curator which of
      # them are the gene they searched for, which is what prompted this.
      #
      # Derived from the same extraction the gene links use, so the symbol in
      # the table and the symbol on the link can never disagree.
      def gene_symbol
        gene = Links.gene_from_defline(title, id, accession)
        gene && gene[:symbol]
      end

      # Links returns a list of Hashes that can be easily turned into an href
      # in the client. These are derived by calling link generators, that is,
      # instance methods of the Links module.
      def links
        database_config = query.report.instance_variable_get(:@env_config)

        # The links that come from the defline alone need no environment config
        # and no database match, so they are available even on the paths below
        # that give up early.
        defline_links = [
          Links.ncbi_link(accession, title, dbtype),
          Links.mod_gene_from_defline(title, id, accession),
          Links.agr_gene_from_defline(title, id, accession),
          Links.ncbi_gene(title, id, accession)
        ].compact

        if database_config.nil? || database_config.empty?
          return defline_links.sort_by { |link| [link[:order], link[:title]] }
        end

        hit_db = nil
        report.querydb.each do |db|
          begin
            if db.include?(id)
              hit_db = db
              break
            end
          rescue => e
            next
          end
        end

        hit_db ||= report.querydb.first
        return defline_links.sort_by { |link| [link[:order], link[:title]] } if hit_db.nil?

        database_filename = File.basename(hit_db.name)
        fasta_file_basename = File.basename(database_filename, File.extname(database_filename))
        species_identifier = fasta_file_basename.sub(/db$/, '')

        # A hit in a protein database is addressed by amino acid offset into
        # that protein, so its own coordinates can never be used as positions on
        # a chromosome.
        #
        # That does not mean a protein hit has no place in the genome browser.
        # Where the defline names the gene's location outright, the browser can
        # be pointed at the gene -- and SGD's protein deflines do exactly that,
        # in the same form as its ORF ones:
        #
        #   YAL069W SGDID:S000002143, Chr I from 335-649, ...
        #
        # So the test is not "is this protein" but "can this hit be placed at
        # all". WormBase's protein deflines name no location
        # (wormpep=CE09349 gene=... locus=...), so they stay unlinked, which is
        # the case this gate was added for: WormBase builds its protein and
        # genomic databases both as "c_elegansdb" under project PRJNA13758, so
        # the protein database matched the genomic entry and inherited its
        # genome_browser block, yielding links at protein coordinates.
        protein_hit = hit_db.type.to_s == 'protein'
        locatable = !protein_hit || !Links.defline_feature_ranges(title).nil?

        links = defline_links.dup

        for reference_sequence in database_config
          uri_matches = false
          uri_project = reference_sequence["uri"].match(/PRJ[A-Z]+\d+/i)&.to_s

          if species_identifier == "c_elegans" && database_filename == "c_elegansdb"
            uri_matches = uri_project == "PRJNA13758"
          elsif reference_sequence["uri"].include?(species_identifier)
            uri_matches = true
          end

          if uri_matches
             if reference_sequence.key?("genome_browser") && locatable
                genome_browser_metadata = reference_sequence["genome_browser"]
                filepath_parts = hit_db.name.split(File::SEPARATOR)
                links.push(Links.jbrowse(reference_sequence["genome_browser"], filepath_parts, hsps, accession, title, hit_db.name, protein_hit))

                # The gene_track lookup is driven by the hit's own coordinates,
                # which for a protein hit are amino acid offsets. Feeding those
                # to a genomic track reports whichever gene happens to sit at
                # that base pair, so it stays off for protein.
                if genome_browser_metadata.has_key?("gene_track") && !protein_hit
                    first_hit_start = hsps.map(&:sstart).at(0)
                    first_hit_end = hsps.map(&:send).at(0)
                    organism = accession.partition('-').first

                    data_url = genome_browser_metadata["data_url"]
                    gene_track = genome_browser_metadata["gene_track"]
                    command = "jbrowse-nclist-cli -b " + data_url + " -t tracks/" + gene_track + "/{refseq}/trackData.jsonz -s " \
                                                    + first_hit_start.to_s + " -e " + first_hit_end.to_s + " -r " + organism
                    response = `#{command}`
                    if response != ''
                        data = JSON.parse(response)
                        if data && !data.empty?
                            for url_data in data
                                if url_data && url_data["id"] && url_data["display_name"]
                                    links.push(Links.agr_gene(filepath_parts, url_data))
                                    if genome_browser_metadata.has_key?("mod_gene_url") && filepath_parts[2] && genome_browser_metadata["mod_gene_url"]
                                        links.push(Links.mod_gene(genome_browser_metadata, filepath_parts, url_data))
                                        break
                                    end
                                end
                            end
                        end
                    end
                end
                links.compact!
                return dedupe_links(links)
             else
               return dedupe_links(links)
             end
             break
          end
        end
        return dedupe_links(links)
      end

      # One link per destination, in display order.
      #
      # The Alliance gene page can be reached two ways: read off the defline, or
      # looked up from the hit's coordinates against a gene_track. Where a
      # database supports both they name the same gene, and the hit would
      # otherwise carry the link twice. Keeping the first occurrence keeps the
      # coordinate-derived label, which carries the gene's display name.
      def dedupe_links(links)
        links.compact.uniq { |link| link[:url] }
             .sort_by { |link| [link[:order], link[:title]] }
      end

      # Returns the database type (nucleotide or protein).
      def dbtype
        report.dbtype
      end

      # Returns the path of the first database containing this hit.
      #
      # Currently unused: #links resolves the database itself so that it can
      # keep the Database object rather than just its path.
      def getdbpath
          db = report.querydb.find { |db| db.include?(id) }
          return db&.name
      end

      # Returns a list of databases that contain this hit.
      def whichdb
        report.querydb.select { |db| db.include? id }
      end

      # Returns tuple of tuple indicating start and end coordinates of matched
      # regions of query and hit sequences.
      def coordinates
        qstart_min = hsps.map(&:qstart).min
        qend_max = hsps.map(&:qend).max
        sstart_min = hsps.map(&:sstart).min
        send_max = hsps.map(&:send).max

        [[qstart_min, qend_max], [sstart_min, send_max]]
      end

      ###
      # Score, identity, and evalue attributes below are used in tabular summary
      # of hits in the HTML report. At some point we should move these to the
      # client.
      ###

      # Returns the sum of scores of all HSPs. Displayed in the tabular summary
      # of hits in the HTML report. Should probably be calculated in browser?
      def total_score
        hsps.map(&:score).reduce(:+)
      end

      private

      # Returns the report object that this hit is a part of. This is used to
      # access list of databases etc.
      def report
        query.report
      end
    end
  end
end
