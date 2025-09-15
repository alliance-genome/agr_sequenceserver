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
                        qcovs sciname hsps links]
        properties.inject({}) { |h, k| h[k] = send(k); h }.to_json(*args)
      end

      ###
      # Link generator functionality.
      ###

      # Include the Links module.
      include Links

      # Links returns a list of Hashes that can be easily turned into an href
      # in the client. These are derived by calling link generators, that is,
      # instance methods of the Links module.
      def links
        # Skip the database path lookup entirely for chromosome-level hits
        database_config = query.report.instance_variable_get(:@env_config)
        
        puts "DEBUG: database_config count = #{database_config&.length}"
        
        # Return empty links if no environment config
        return [] if database_config.nil? || database_config.empty?

        # Get the first database name and extract basename for matching
        first_db = report.querydb.first
        puts "DEBUG: first_db = #{first_db&.name}"
        return [] if first_db.nil?
        
        database_filename = File.basename(first_db.name)
        fasta_file_basename = File.basename(database_filename, File.extname(database_filename))
        
        # Extract species identifier from database name (e.g., "c_elegansdb" -> "c_elegans")
        species_identifier = fasta_file_basename.sub(/db$/, '')
        
        puts "DEBUG: database_filename = #{database_filename}"
        puts "DEBUG: fasta_file_basename = #{fasta_file_basename}"
        puts "DEBUG: species_identifier = #{species_identifier}"

        links = []
        for reference_sequence in database_config
          puts "DEBUG: Checking URI: #{reference_sequence['uri']} against #{species_identifier}"
          if reference_sequence["uri"].include? species_identifier
             if reference_sequence.key?("genome_browser")
                genome_browser_metadata = reference_sequence["genome_browser"]
                filepath_parts = first_db.name.split(File::SEPARATOR)
                links.push(Links.jbrowse(reference_sequence["genome_browser"], filepath_parts, hsps, accession))

                if genome_browser_metadata.has_key?("gene_track")
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
                return links.sort_by { |link| [link[:order], link[:title]] }
             else
               return links
             end
             break
          end
        end
        return links
      end

      # Returns the database type (nucleotide or protein).
      def dbtype
        report.dbtype
      end

      # returns the first database that it finds based on the id
      def getdbpath
          puts "DEBUG: getdbpath - hit id = #{id.inspect}"
          puts "DEBUG: getdbpath - report.querydb count = #{report.querydb&.length}"
          puts "DEBUG: getdbpath - report.querydb = #{report.querydb&.map(&:name)}"
          
          db = report.querydb.find { |db| 
            puts "DEBUG: Testing db #{db.name} for hit id #{id}"
            result = db.include?(id)
            puts "DEBUG: db.include?(#{id}) = #{result}"
            result
          }
          puts "DEBUG: getdbpath - found db = #{db&.name}"
          return db&.name
      end


      # Returns a list of databases that contain this hit.
      #
      # e.g., whichdb('SI_2.2.23') => [<Database: ...>, ...]
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
