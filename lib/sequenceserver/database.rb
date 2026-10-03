require 'open3'
require 'digest/md5'
require 'forwardable'

require 'sequenceserver/sequence'

# Define Database class.
module SequenceServer
  # Captures a directory containing FASTA files and BLAST databases.
  #
  # Formatting a FASTA for use with BLAST+ will create 3 or 6 files,
  # collectively referred to as a BLAST database.
  #
  # It is important that formatted BLAST database files have the same dirname
  # and basename as the source FASTA for SequenceServer to be able to tell
  # formatted FASTA from unformatted. And that FASTA files be formatted with
  # `parse_seqids` option of `makeblastdb` for sequence retrieval to work.
  #
  # SequenceServer will always place BLAST database files alongside input FASTA,
  # and use `parse_seqids` option of `makeblastdb` to format databases.
  Database = Struct.new(:name, :title, :type, :nsequences, :ncharacters,
                        :updated_on, :format, :categories) do

    extend Forwardable

    def_delegators SequenceServer, :config, :sys

    def initialize(*args)
      args[2].downcase!   # type
      args.each(&:freeze)
      super

      @id = Digest::MD5.hexdigest args.first
    end

    attr_reader :id
    alias path name

    def retrieve(accession, coords = nil)
      fail(
        InvalidSequenceIdError,
        "Invalid sequence id: #{accession}"
      ) unless accession =~ SequenceServer::BLAST::VALID_SEQUENCE_ID

      cmd = "blastdbcmd -db #{name} -entry '#{accession}'"

      if coords
        fail(
          InvalidParameterError,
          "Invalid range coordinates: #{coords}"
        ) unless coords =~ /[0-9]+-[0-9]*/

        cmd << " -range #{coords}"
      end
      out, = sys(cmd, path: config[:bin])
      out.chomp
    rescue CommandFailed
      # Command failed beacuse stdout was empty, meaning accession not
      # present in this database.
      nil
    end

    # Returns true if the database contains the given sequence id.
    # Returns false otherwise.
    def include?(id)
      fail ArgumentError, "Invalid sequence id: #{id}" unless id =~ SequenceServer::BLAST::VALID_SEQUENCE_ID

      cmd = "blastdbcmd -entry '#{id}' -db #{name}"
      sys(cmd, path: config[:bin]) rescue false
    end

    def v4?
      format == '4'
    end

    def v5?
      format == '5'
    end

    # Return true if the database was _not_ created using the -parse_seqids
    # option of makeblastdb.
    def non_parse_seqids?
      return if alias?
      case format
      when '5'
        # Check that at least one ID index exists (pjs or njs)
        !(extensions & %w[njs pjs]).any?
      when '4'
        !(extensions & %w[nsi psi]).any?
      end
    end

    # Returns true if the database was created using blastdb_aliastool.
    def alias?
      (%w[nal pal] & extensions).length == 1 && extensions.count == 1
    end

    def ==(other)
      @id == Digest::MD5.hexdigest(other.name)
    end

    def to_s
      "#{type}: #{title} #{name}"
    end

    def to_json(*args)
      to_h.update(id: id).to_json(*args)
    end

    private

    def extensions
      # The glob pattern used here is quite relaxed. This is to capture
      # multipart databases as well. It is possible that non-blast-database
      # extensions may also be picked. However, that shouldn't be a problem
      # as we only check whether certain required extensions are present or not.
      @extensions ||= Dir["#{path}*{n,p}*"].map { |p| p.split('.').last }.sort.uniq
    end
  end

  # Model Database's eigenclass as a collection of Database objects.
  class Database
    class << self
      include Enumerable

      extend Forwardable

      def_delegators SequenceServer, :config, :sys

      # The databases this request is working with.
      #
      # This fork loads databases per request from the URL's MOD and version
      # segments, so routes.rb assigns this collection on every request. It used
      # to be one process-wide Hash, cleared and repopulated each time -- so two
      # concurrent requests for different MODs overwrote each other. A WormBase
      # search that validated its database ids just after an SGD request had
      # replaced the collection matched none of them and was rejected with
      # "Database id should be one of ...", HTTP 400. Two users on different MODs
      # at the same time could break each other's searches, and the browser suite
      # reproduced it whenever it ran more than one worker.
      #
      # An assignment made while serving a request is therefore kept thread-local
      # and is invisible to other requests. Assignment on the main thread still
      # writes the process-wide collection, which is how upstream's single
      # database_dir is set up once at boot and read by every request thereafter.
      #
      # Safe because nothing outside the assigning thread reads this: a job
      # resolves its own databases at construction (blast/job.rb) and carries
      # them, so the BLAST thread pool never consults the collection.
      def collection
        Thread.current[:sequenceserver_database_collection] || process_collection
      end

      def process_collection
        @collection ||= {}
      end

      def collection=(databases)
        built = {}
        databases.each { |db| built[db.id] = db }

        if Thread.current == Thread.main
          @collection = built
        else
          Thread.current[:sequenceserver_database_collection] = built
        end
      end

      private :collection, :process_collection

      def [](ids)
        ids = Array ids
        collection.values_at(*ids)
      end

      def ids
        collection.keys
      end

      def all
        collection.values
      end

      def tree
        all.each_with_object({}) do |db, data|
          data[db.type] ||= []
          use_parent = '#'
          db.categories.each_with_index do |entry, index|
            parent = index.zero? ? '#' : db.categories[0..(index - 1)].join('-')
            use_id = db.categories[0..index].join('-')
            element = { id: use_id, parent: parent, text: entry }
            data[db.type] << element unless data[db.type].include?(element)
            use_parent = use_id
          end

          data[db.type] <<
            {
              id: db.id,
              parent: use_parent,
              text: db.title,
              icon: 'glyphicon glyphicon-file'
            }

          yield(db, data[db.type].last) if block_given?
        end
      end

      def each(&block)
        all.each(&block)
      end

      def include?(path)
        collection.include? Digest::MD5.hexdigest path
      end

      def group_by(&block)
        all.group_by(&block)
      end

      def to_json
        collection.values.to_json
      end

      # Retrieve given loci from the databases we have.
      #
      # loci to retrieve are specified as a String:
      #
      #    "accession_1,accession_2:start-stop,accession_3"
      #
      # Return value is a FASTA format String containing sequences in the same
      # order in which they were requested. If an accession could not be found,
      # a commented out error message is included in place of the sequence.
      # Sequences are retrieved from the first database in which the accession
      # is found. The returned sequences can, thus, be incorrect if accessions
      # are not unique across all database (admins should make sure of that).
      # Most ids one ?query= may ask for, and how long the whole lookup may
      # take.
      #
      # Every id is looked up in every database until one matches, and each of
      # those lookups forks the VM to exec blastdbcmd -- so a MISS costs one
      # fork per database. SGD's fungal set has 312 of them, which is ~19s for
      # a single absent accession, and nothing bounded the number of commas: a
      # ?query= with 100 ids was ~31,000 process spawns and about 26 minutes of
      # one worker, unauthenticated. The ?name= path next to it was given a
      # budget for exactly this reason; this one had none.
      #
      # 10 is well above what a deep link needs (they carry one id) and the
      # deadline is what actually bounds the cost on a large deployment.
      RETRIEVE_LOCI_LIMIT = 10
      RETRIEVE_BUDGET_SECONDS = 15

      def retrieve(loci)
        # Exit early if loci is nil.
        return unless loci

        # String -> Array
        # We may have empty string if loci contains a double comma as a result
        # of typo (remember - loci is external input). These are eliminated.
        loci = loci.split(',').delete_if(&:empty?)

        dropped = [loci.length - RETRIEVE_LOCI_LIMIT, 0].max
        loci = loci.first(RETRIEVE_LOCI_LIMIT)

        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) +
                   RETRIEVE_BUDGET_SECONDS
        expired = false

        # Each database is searched for each locus. For each locus, search is
        # terminated on the first database match.
        # NOTE: This can return incorrect sequence if the sequence ids are
        # not unique across all databases.
        seqs = loci.map do |locus|
          # Get sequence id and coords. coords may be nil. accession can't
          # be.
          accession, coords = locus.split(':')

          # Initialise a variable to store retrieved sequence.
          seq = nil

          # Go over each database looking for this accession. Each iteration
          # forks and execs blastdbcmd, so the deadline is checked per
          # database, not merely per locus: one absent accession on a large
          # deployment is itself hundreds of spawns.
          each do |database|
            if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
              expired = true
              break
            end

            # Database lookup  will return a string if given accession is
            # present in the database, nil otherwise.
            seq = database.retrieve(accession, coords)
            # Found a match! Terminate iteration returning the retrieved
            # sequence.
            break if seq
          end

          # If accession was not present in any database, insert an error
          # message in place of the sequence. The line starts with '#'
          # and should be ignored by BLAST (not tested).
          unless seq
            seq = if expired
                    "# ERROR: lookup of #{locus} gave up after " \
                    "#{RETRIEVE_BUDGET_SECONDS}s"
                  else
                    "# ERROR: #{locus} not found in any database"
                  end
          end

          # Return seq.
          seq
        end

        if dropped.positive?
          seqs << "# ERROR: #{dropped} further id(s) ignored; at most " \
                  "#{RETRIEVE_LOCI_LIMIT} may be requested at once"
        end

        # Array -> String
        seqs.join("\n")
      end

      # Intended to be used only for testing.
      def first
        all.first
      end

      # Intended to be used only for testing.
      def clear
        collection.clear
      end
    end
  end
end
