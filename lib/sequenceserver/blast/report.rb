require 'ox'
Ox.default_options = { skip: :skip_none }

require 'sequenceserver/report'
require 'sequenceserver/links'

require_relative 'formatter'
require_relative 'query'
require_relative 'hit'
require_relative 'hsp'

module SequenceServer
  module BLAST
    # Captures results of a BLAST search.
    #
    # A report is constructed from a search id. Search id is simply the
    # basename of the temporary file that holds BLAST results in binary
    # BLAST archive format.
    #
    # For a given search id, result is obtained in XML format using the
    # Formatter class, parsed into a simple intermediate representation
    # (Array of values and Arrays) and information extracted from the
    # intermediate representation (ir).
    class Report < Report
      def initialize(job, env_config = [])
        @env_config = env_config
        super do
          @querydb = job.databases
        end
      end

      def to_json(*_args)
        %i[querydb program program_version params stats
           queries].inject({}) do |h, k|
          h[k] = send(k)
          h
        end.update(search_id: job.id,
                   submitted_at: job.submitted_at.utc,
                   imported_xml: !job.imported_xml_file.nil?,
                   seqserv_version: SequenceServer::VERSION,
                   shared_accessions: shared_accessions,
                   non_parse_seqids: !!job.databases&.any?(&:non_parse_seqids?)).to_json
      end

      # Sequence ids claimed by more than one of the databases searched.
      #
      # This is not a tidiness check. When a search spans several databases
      # that use the same sequence ids, BLAST reports the hit ONCE and drops
      # the rest -- so the result is missing alignments that exist, with
      # nothing in the output to say so.
      #
      # Demonstrated on two databases built here, each holding one sequence
      # called "1" with different content and different taxids: searched
      # separately each returns its own, searched together only the first
      # appears. On the Alliance deployment the effect is large -- human,
      # mouse, rat and zebrafish all name chromosomes 1..n, so a nine-genome
      # tblastn for human ACTB returned 131 hits and not one of them was mouse
      # or rat, while mouse alone returns 20 at evalue 0.0.
      #
      # Measured over the deployments here: ALLIANCE/prod 23 of 36 same-type
      # database pairs collide, WB/WS298 6 pairs (the nematode genome
      # assemblies, which all name chromosomes I-VI and X), FB/FB2026_03 and
      # RGD/8.3.0 none.
      #
      # Returns a hash the front end can render, or nil when there is nothing
      # to say or the question cannot be answered cheaply.
      def shared_accessions
        @shared_accessions ||= compute_shared_accessions
      end

      private

      # Most databases to read indexes for before giving up on the question.
      #
      # Reading and parsing them is linear and fast for the handfuls this
      # matters to -- 0.07s for the nine Alliance genomes, 0.63s for all 63
      # WormBase databases -- but someone can tick all 200 FlyBase ones, which
      # is 2.2s of index parsing to answer a question that has no collisions
      # anyway. Past this many, the check is skipped rather than slowing the
      # report down.
      SHARED_ACCESSION_DATABASE_LIMIT = 80

      def compute_shared_accessions
        databases = job.databases || []
        return nil if databases.length < 2
        return nil if databases.length > SHARED_ACCESSION_DATABASE_LIMIT

        owner = {}
        collisions = {}
        databases.each do |database|
          accessions = database.accessions
          # An index missing for even one database makes the answer
          # incomplete, and a half-answer here is worse than none: it would
          # say "these two collide" while silently ignoring a third.
          return nil if accessions.nil?

          accessions.each do |accession|
            previous = owner[accession]
            if previous.nil?
              owner[accession] = database.title
            elsif previous != database.title
              (collisions[accession] ||= Set.new) << previous
              collisions[accession] << database.title
            end
          end
        end

        return nil if collisions.empty?

        affected = collisions.each_value.reduce(Set.new) { |a, e| a | e }
        {
          count: collisions.size,
          databases: affected.to_a.sort,
          examples: collisions.keys.sort.first(5)
        }
      end

      public

      def xml_file_size
        return File.size(job.imported_xml_file) if job.imported_xml_file

        xml_formatter.size
      end

      def done?
        return true if job.imported_xml_file

        File.exist?(xml_formatter.filepath) && File.exist?(tsv_formatter.filepath)
      end

      def program
        @program ||= xml_ir[0]
      end

      def program_version
        @program_version ||= xml_ir[1]
      end

      def querydb
        @querydb ||= xml_ir[3].split.map do |path|
          { title: File.basename(path) }
        end
      end

      def dbtype
        @dbtype ||= querydb&.first&.type || dbtype_from_program
      end

      def params
        @params ||= extract_params
      end

      def stats
        @stats ||= extract_stats
      end

      def queries
        @queries ||= xml_ir[8].map do |n|
          query = Query.new(self, n[0], n[2], n[3], [])
          query.hits = query_hits(n[4], tsv_ir[query.id], query)

          query
        end
      end

      private

      def xml_ir
        @xml_ir ||=
          if job.imported_xml_file
            parse_xml(File.read(job.imported_xml_file)).tap do |xml_ir|
              if xml_ir.size < 9 || !xml_ir[0].is_a?(String) || !xml_ir[1].is_a?(String) || !xml_ir[7].is_a?(Array) || !xml_ir[8].is_a?(Array)
                raise SequenceServer::XmlImportError
              end
            end
          else
            job.raise!
            parse_xml(xml_formatter.read_file)
          end
      end

      def tsv_ir
        @tsv_ir ||=
          if job.imported_xml_file
            # An imported XML report has no TSV beside it, so every query
            # yields no rows and each hit falls back to empty sciname/qcovs.
            Hash.new { |h, k| h[k] = [] }
          else
            job.raise!
            parse_tsv(tsv_formatter.read_file)
          end
      end

      def xml_formatter
        @xml_formatter ||= Formatter.run(job, 'xml')
      end

      def tsv_formatter
        @tsv_formatter ||= Formatter.run(job, 'custom_tsv')
      end

      # Search params tweak the results. Like evalue cutoff or penalty to open
      # a gap. BLAST+ doesn't list all input params in the XML output. Only
      # matrix, evalue, gapopen, gapextend, and filters are available from XML
      # output.
      def extract_params
        # Parse/get params from the job first.
        job_params = parse_advanced(job.advanced)
        # Old jobs from beta releases may not have the advanced key but they
        # will have the deprecated advanced_params key.
        job_params.update(job.advanced_params) if job.advanced_params

        # Parse params from BLAST XML.
        @params = Hash[
          *xml_ir[7].first.map { |k, v| [k.gsub('Parameters_', ''), v] }.flatten
        ]
        @params['evalue'] = @params.delete('expect')

        # Merge into job_params.
        @params = job_params.merge(@params)
      end

      # Search stats are computed metrics. Like total number of sequences or
      # effective search space.
      def extract_stats
        stats = xml_ir[8].first[5][0]
        {
          nsequences: stats[0],
          ncharacters: stats[1],
          hsp_length: stats[2],
          search_space: stats[3],
          kappa: stats[4],
          labmda: stats[5],
          entropy: stats[6]
        }
      end

      # Create Hit objects for the given query from the given ir.
      #
      # `tsv_rows` is this query's TSV rows in order, one per HSP. They are
      # consumed positionally: the first hit takes as many rows as it has HSPs,
      # the next hit the rows after those, and so on. Nothing is looked up by
      # subject id, because a subject id does not identify a hit across
      # databases -- see parse_tsv.
      def query_hits(xml_ir, tsv_rows, query)
        return [] if xml_ir == ["\n"] # => No hits.

        cursor = 0
        xml_ir.map do |n|
          # If hit comes from a non -parse_seqids database, then id (n[1]) is a
          # BLAST assigned internal id of the format 'gnl|BL_ORD_ID|serial'. We
          # assign the id to accession (because we use accession for sequence
          # retrieval and this id is what blastdbcmd expects for non
          # -parse_seqids databases) and parse the hit defline to
          # obtain id and title ourselves (we use id and title
          # for display purposes).
          if n[1] =~ /^gnl\|BL_ORD_ID\|\d+/
            n[3] = n[1]  # Store BL_ORD_ID as accession
            defline = n[2].split
            original_title = n[2]  # Keep the full original defline
            n[1] = defline.shift || n[1]  # Use first word as ID for lookup, fallback to BL_ORD_ID
            n[2] = defline.empty? ? original_title : defline.join(' ')  # Keep full title if single word
          end

          # This hit's slice of the TSV, by position.
          rows = tsv_rows[cursor, n[5].length] || []
          cursor += n[5].length

          # sciname and qcovs are per hit, so they come from its first row.
          # They are '' for an imported XML report, which has no TSV, and
          # "N/A" from BLAST itself where no taxdb is installed.
          first = rows.first || ['', '', nil]

          hit = Hit.new(query, n[0], n[1], n[3], n[2], n[4],
                        first[0], first[1], [])

          hit.hsps = hsps(n[5], rows.map { |r| r[2] }, hit)

          hit
        end
      end

      def hsps(xml_ir, tsv_ir, hit)
        xml_ir.map.with_index do |n, i|
          n.insert(14, tsv_ir[i])

          HSP.new(hit, *n)
        end
      end

      def parse_xml(xml)
        node_to_array Ox.parse(xml).root
      rescue Ox::ParseError
        raise 'Error parsing XML file' if job.imported_xml_file

        raise InputError, <<~MSG
          BLAST generated incorrect XML output. This can happen if sequence ids in your
          databases are not unique across all files. As a temporary workaround, you can
          repeat the search with one database at a time. Proper fix is to recreate the
          following databases with unique sequence ids:

              #{querydb.map(&:title).join(', ')}

          If you are not the one managing this server, try to let the manager know
          about this.
        MSG
      end

      PARSEABLE_AS_HASH  = %w[Parameters].freeze
      PARSEABLE_AS_ARRAY = %w[BlastOutput_param Iteration_stat Statistics
                              Iteration_hits BlastOutput_iterations
                              Iteration Hit Hit_hsps Hsp].freeze

      def node_to_hash(element)
        Hash[*element.nodes.map { |n| [n.name, node_to_value(n)] }.flatten]
      end

      def node_to_array(element)
        element.nodes.map { |n| node_to_value n }
      end

      def node_to_value(node)
        # Ensure that the recursion doesn't fails when String value is received.
        return node if node.is_a?(String)

        if PARSEABLE_AS_HASH.include? node.name
          node_to_hash(node)
        elsif PARSEABLE_AS_ARRAY.include? node.name
          node_to_array(node)
        else
          first_text(node)
        end
      end

      def first_text(node)
        node.nodes.find { |n| n.is_a? String }
      end

      # Parses the given TSV string as:
      #
      # {
      #    qseqid: [[sciname, qcovs, qcovhsp], ...],   # one entry per HSP, in order
      #    ...
      # }
      #
      # Ordered, and NOT keyed on sseqid. It used to be
      # {qseqid => {sseqid => [sciname, qcovs, [qcovhsp]]}}, which assumes a
      # subject id identifies a hit. It does not, once a search spans more than
      # one database: human, mouse, rat and zebrafish all name a chromosome
      # "1", so two hits called "1" from two genomes shared one entry. The
      # `||=` meant the first hit's sciname and qcovs were handed to both, and
      # every hit's qcovhsp values were appended to a single array, which
      # `hsps` then indexes positionally -- so the second hit's HSPs were shown
      # the first hit's coverage.
      #
      # Measured on a nine-genome tblastn against /blast/ALLIANCE/prod/: 131
      # hits over 78 distinct subject ids, 21 ids claimed by more than one hit,
      # and 53 of the 131 hits displaying another hit's per-HSP coverage.
      #
      # There is no column that would fix the key. BLAST has no outfmt
      # specifier for the subject database; staxids names an organism, not a
      # database, and is not unique per entry on any deployment here -- SGD has
      # 183 entries over 50 taxids with 11 sharing one. So the join is
      # positional: both files come from the same archive through
      # Formatter.run, hit and HSP order is identical between them, and the
      # count is exact (XML 1163 HSPs, TSV 1163 rows on that same search).
      def parse_tsv(tsv)
        ir = Hash.new { |h, k| h[k] = [] }
        tsv.each_line do |line|
          next if line.start_with? '#'

          row = line.chomp.split("\t")

          ir[row[0]] << [row[2], row[3], row[4]]
        end
        ir
      end

      # Parse BLAST CLI string from job.advanced.
      def parse_advanced(param_line)
        param_list = (param_line || '').split(' ')
        res = {}

        param_list.each_with_index do |word, i|
          nxt = param_list[i + 1]
          next unless word.start_with? '-'

          word.sub!('-', '')
          res[word] = unless nxt.nil? || nxt.start_with?('-')
                        nxt
                      else
                        'True'
                      end
        end
        res
      end

      # Returns database type (nucleotide or protein) inferred from
      # Report#program (i.e., the BLAST algorithm)
      def dbtype_from_program
        case program
        when /blastn|tblastn|tblastx/
          'nucleotide'
        when /blastp|blastx/
          'protein'
        end
      end
    end
  end
end
