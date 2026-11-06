# frozen_string_literal: true

require 'json'
require 'zlib'

module SequenceServer
  # Which genes overlap a hit's coordinates, per assembly.
  #
  # A BLAST hit gives a refName and a span. Reaching a gene page needs the
  # genes at that span, and reaching orthologues needs that gene's curie. The
  # Alliance publishes both, in the `<Assembly>_all_genes` tracks of its
  # JBrowse 2 config, each a Gff3TabixAdapter over an S3 `.gff.gz`.
  #
  # docs/ALLIANCE_WIDE_PLAN.md Phase 4 assumed the query path was a tabix range
  # request. It does not have to be. Only `gene` rows matter, and
  # agr_blastdb_manager/src/build_gene_index.py extracts those once per release
  # into one file per assembly: 365,684 genes across nine assemblies, 5.98 MB
  # gzipped, against 313 MB of source GFFs. So the lookup is a local read, with
  # no new binary in the image and no call to S3 while a user waits.
  #
  # Files live in the mounted environments directory, beside
  # environment_info.json, because an assembly is shared across deployments:
  # one Danio_rerio index serves both ZFIN and the Alliance-wide set.
  class GeneIndex
    DIRNAME = 'gene_index'

    class << self
      # Index for an assembly, or nil where none is published.
      #
      # Memoised per assembly: the files are a few hundred KB each and a report
      # asks for the same one on every hit. Thread-safe by lock rather than by
      # hope, since WEBrick hands each request its own thread and two hits can
      # race on the first load.
      def for(assembly, root: nil)
        return nil if assembly.nil? || assembly.empty?

        @lock ||= Mutex.new
        @cache ||= {}
        key = [assembly, root]
        @lock.synchronize do
          @cache.fetch(key) { @cache[key] = load(assembly, root) }
        end
      end

      def clear_cache!
        @lock ||= Mutex.new
        @lock.synchronize { @cache = {} }
      end

      def dir(root = nil)
        return File.join(root, DIRNAME) if root

        configured = SequenceServer.config[:gene_index_dir] if SequenceServer.config
        return configured if configured

        File.join(default_root, DIRNAME)
      end

      private

      # Same path routes.rb gives Sinatra, derived the same way, because this
      # class is called from Links and has no access to `settings`.
      # routes.rb:52 sets :root to File.join(__dir__, '..', '..'); __dir__
      # there is lib/sequenceserver, and it is lib/sequenceserver here too.
      # :gene_index_dir overrides it outright, for a deployment that keeps the
      # indexes somewhere else.
      def default_root
        File.join(__dir__, '..', '..', 'public', 'environments')
      end

      def load(assembly, root)
        path = File.join(dir(root), "#{assembly}.genes.json.gz")
        return nil unless File.exist?(path)

        doc = Zlib::GzipReader.open(path) { |gz| JSON.parse(gz.read) }
        new(doc, path)
      rescue Zlib::Error, JSON::ParserError => e
        # A corrupt index must not take a report down with it: a hit without
        # gene annotation is the normal case for a scaffold anyway.
        SequenceServer.logger.warn "Unreadable gene index #{path}: #{e.message}"
        nil
      end
    end

    attr_reader :assembly, :release, :path, :counts

    def initialize(doc, path)
      @assembly = doc['assembly']
      @release  = doc['release']
      @path     = path
      @counts   = doc['counts'] || {}
      @refs     = doc['refs'] || {}
      # Longest gene per refName, so a backward scan knows where to stop. The
      # arrays are sorted by start, and a gene starting well before the query
      # can still overlap it, so a bound on length is what makes the scan
      # correct rather than merely fast.
      @max_span = {}
      @refs.each do |ref, rows|
        @max_span[ref] = rows.map { |row| row[1] - row[0] }.max || 0
      end
    end

    # refNames this index covers. The Alliance GFFs annotate assembled
    # chromosomes only, so this is far short of the assembly's .fai: measured
    # 2026-10-30, 25 of human's 705 and 25 of fly's 1,870. A hit on a scaffold
    # therefore has no gene annotation, which is absence of data rather than
    # failure, and the caller has to say so.
    def ref_names
      @refs.keys
    end

    def covers?(ref_name)
      @refs.key?(ref_name)
    end

    def gene_count
      @counts['genes'] || @refs.values.sum(&:size)
    end

    # Genes overlapping ref_name:from..to, nearest-first by distance from the
    # span's midpoint, at most `limit` of them.
    #
    # Coordinates are 1-based inclusive on both sides, as GFF gives them and as
    # BLAST reports subject coordinates, so the comparison needs no adjustment.
    def overlapping(ref_name, from, to, limit: 10)
      rows = @refs[ref_name]
      return [] if rows.nil? || rows.empty?

      from, to = to, from if from > to
      found = []
      # Walk back from the last gene that starts at or before the query end.
      # Stop once a gene's start is further back than the longest gene on this
      # refName, since nothing earlier can reach the query.
      floor = from - @max_span[ref_name].to_i
      index = upper_bound(rows, to)
      while index >= 0
        start_pos, end_pos, name, curie = rows[index]
        break if start_pos < floor

        found << { name: name, curie: curie, start: start_pos, end: end_pos } if end_pos >= from
        index -= 1
      end

      midpoint = (from + to) / 2
      found
        .sort_by { |gene| [distance(gene, midpoint), gene[:start]] }
        .first(limit)
    end

    private

    def distance(gene, point)
      return 0 if point.between?(gene[:start], gene[:end])

      [(gene[:start] - point).abs, (gene[:end] - point).abs].min
    end

    # Index of the last row whose start is <= value, or -1 if none is.
    def upper_bound(rows, value)
      low = 0
      high = rows.size - 1
      answer = -1
      while low <= high
        mid = (low + high) / 2
        if rows[mid][0] <= value
          answer = mid
          low = mid + 1
        else
          high = mid - 1
        end
      end
      answer
    end
  end
end
