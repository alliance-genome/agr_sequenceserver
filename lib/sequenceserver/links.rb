require 'erb'
require 'json'
require 'pp'

module SequenceServer
  # Module to contain methods for generating sequence retrieval links.
  module Links
    # Provide a method to URL encode _query parameters_. See [1].
    include ERB::Util
    alias encode url_encode
    # Link generators are methods that return a Hash as defined below.
    #
    # {
    #   # Required. Display title.
    #   :title => "title",
    #
    #   # Required. Generated url.
    #   :url => url,
    #
    #   # Optional. Left-right order in which the link should appear.
    #   :order => num,
    #
    #   # Optional. Classes, if any, to apply to the link.
    #   :class => "class1 class2",
    #
    #   # Optional. Class name of a FontAwesome icon to use.
    #   :icon => "fa-icon-class"
    # }
    #
    # If no url could be generated, return nil.
    #
    # Helper methods
    # --------------
    #
    # Following helper methods are available to help with link generation.
    #
    #   encode:
    #     URL encode query params.
    #
    #     Don't use this function to encode the entire URL. Only params.
    #
    #     e.g:
    #         sequence_id = encode sequence_id
    #         url = "http://www.ncbi.nlm.nih.gov/nucleotide/#{sequence_id}"
    #
    #   dbtype:
    #     Returns the database type (nucleotide or protein) that was used for
    #     BLAST search.
    #
    #   whichdb:
    #     Returns the databases from which the hit could have originated. To
    #     ensure that one and the correct database is returned, ensure that
    #     your sequence ids are unique across different FASTA files.
    #     NOTE: This method is slow.
    #
    #   coordinates:
    #     Returns min alignment start and max alignment end coordinates for
    #     query and hit sequences.
    #
    #     e.g.,
    #     query_coords = coordinates[0]
    #     hit_coords = coordinates[1]

    # MOD-specific chromosome extraction methods
    # =============================================

    # A defline opening with an attribute pair carries no sequence name in that
    # position. WormBase protein deflines start "wormpep=CE09349", FlyBase's
    # "type=polypeptide", and C. elegans genomic ones "length=14890789".
    # Returning the pair verbatim as a reference name is what produced JBrowse
    # links addressed to "wormpep=CE09349" instead of a chromosome.
    #
    # Deliberately anchored on a bare identifier: SGD's fungal deflines open
    # with a bracketed "[gene=PAU8]", which is not an attribute in this sense
    # and is left alone.
    DEFLINE_ATTRIBUTE = /\A[A-Za-z_][A-Za-z0-9_]*=/.freeze

    # C. elegans chromosome name normalization to JBrowse2 ref names
    WORMBASE_CHROMOSOME_MAP = {
      "1" => "I", "2" => "II", "3" => "III", "4" => "IV", "5" => "V",
      "I" => "I", "II" => "II", "III" => "III", "IV" => "IV", "V" => "V",
      "X" => "X", "MtDNA" => "MtDNA"
    }.freeze

    # Extract chromosome name for WormBase hits
    def self.extract_wormbase_chromosome(hit_title, blast_accession, database_path = nil)
      # Handle C. elegans length-only format: "length=14890789"
      if hit_title && hit_title.match(/^length=\d+$/) && blast_accession.include?("BL_ORD_ID")
        # Extract the ID number from gnl|BL_ORD_ID|X format
        id_match = blast_accession.match(/BL_ORD_ID\|(\d+)/)
        if id_match
          id_num = id_match[1].to_i
          # Map WormBase chromosome order: I=1, II=2, III=3, IV=4, V=5, X=6
          case id_num
          when 1 then return "I"
          when 2 then return "II"
          when 3 then return "III"
          when 4 then return "IV"
          when 5 then return "V"
          when 6 then return "X"
          when 7 then return "MtDNA"
          end
        end
      end

      # Handle C. elegans CB4856 strain (PRJEB28388)
      if database_path&.include?("WS297") && blast_accession.include?("PRJEB28388")
        seq_name = hit_title.split(/[\s,;]/)[0] if hit_title
        case seq_name
        when "I" then return "chrI_pilon"
        when "II" then return "chrII_pilon"
        when "III" then return "chrIII_pilon"
        when "IV" then return "chrIV_pilon"
        when "V" then return "chrV_pilon"
        when "X" then return "chrX_pilon"
        when "MtDNA" then return "chrM_pilon"
        end
      end

      # Normalize chromosome names from title or accession
      # WormBase JBrowse2 expects: I, II, III, IV, V, X, MtDNA
      if hit_title && !hit_title.empty?
        first_word = hit_title.split(/[\s,;]/)[0]
        mapped = WORMBASE_CHROMOSOME_MAP[first_word]
        return mapped if mapped
      end

      # Also check the accession (some DBs have Roman/Arabic accessions with empty titles)
      if blast_accession
        mapped = WORMBASE_CHROMOSOME_MAP[blast_accession]
        return mapped if mapped
      end

      nil # Return nil if no WormBase-specific pattern matched
    end

    # Check if extracted name looks like a real chromosome (not a scaffold)
    def self.is_valid_flybase_chromosome(name)
      # Valid FlyBase chromosomes: X, Y, 2L, 2R, 3L, 3R, 4, rDNA, mitochondrion_genome
      return false if name.nil? || name.empty?
      # Reject long numeric IDs (scaffolds)
      return false if name.match(/^\d{10,}$/)
      # Accept short names typical of chromosomes
      return true if name.match(/^[XY234]$/) || name.match(/^[234][LR]$/) || name.match(/^rDNA$/) || name.match(/^mitochondrion/)
      # Accept other short names
      return name.length <= 20
    end

    # Extract chromosome name for FlyBase hits
    def self.extract_flybase_chromosome(hit_title, blast_accession)
      return nil unless hit_title && !hit_title.empty?

      # Try loc= field first (more reliable for chromosomes)
      if hit_title.include?("loc=")
        loc_match = hit_title.match(/loc=([^:]+):/)
        if loc_match
          seq_name = loc_match[1].strip
          return seq_name if is_valid_flybase_chromosome(seq_name)
        end
      end

      # Fall back to ID= field for golden_path types
      if hit_title.include?("type=golden_path") && hit_title.include?("ID=")
        id_match = hit_title.match(/ID=([^;]+)/)
        if id_match
          seq_name = id_match[1].strip
          return seq_name if is_valid_flybase_chromosome(seq_name)
        end
      end

      nil # Return nil if no valid chromosome found
    end

    # Extract chromosome name for RGD hits
    # RGD hit titles look like: "Rattus norvegicus strain BN/NHsdMcwi chromosome 1, GRCr8, whole genome shotgun sequence"
    # JBrowse2 primary names: Chr1, Chr2, ..., ChrX, ChrY, ChrMT
    def self.extract_rgd_chromosome(hit_title, blast_accession)
      return nil unless hit_title && !hit_title.empty?

      # Match "chromosome N" where N is a number, X, or Y
      chr_match = hit_title.match(/chromosome\s+(\d+|X|Y)/i)
      if chr_match
        return "Chr#{chr_match[1]}"
      end

      # Handle mitochondrial sequences
      if hit_title.match(/mitochondri/i)
        return "ChrMT"
      end

      nil # Return nil for scaffolds and unlocalized sequences
    end

    # Extract chromosome name for SGD hits.
    #
    # Two defline styles are in use across the SGD datasets:
    #   NCBI style (R64-5-1f): "... S288C chromosome I, complete sequence"
    #   SGD style  (R64-5-1m): "[org=...] [strain=S288C] [chromosome=XVI]"
    # so the separator after "chromosome" may be whitespace or '='.
    #
    # JBrowse refseq names are chrI..chrXVI and chrmt. Anything else (the
    # 2-micron plasmid, scaffolds, the ~200 other fungal species) returns nil so
    # that no JBrowse link is generated for a reference JBrowse cannot resolve.
    SGD_ROMAN_MAP = {
      "I" => "chrI", "II" => "chrII", "III" => "chrIII", "IV" => "chrIV",
      "V" => "chrV", "VI" => "chrVI", "VII" => "chrVII", "VIII" => "chrVIII",
      "IX" => "chrIX", "X" => "chrX", "XI" => "chrXI", "XII" => "chrXII",
      "XIII" => "chrXIII", "XIV" => "chrXIV", "XV" => "chrXV", "XVI" => "chrXVI"
    }.freeze

    # The fungal CDS and protein sets name the chromosome NOWHERE in the title.
    # It is only in the RefSeq accession their id is built from:
    #
    #   NC_001138.5_cds_NP_116614.1_1760   [gene=ACT1] [locus_tag=YFL039C] ...
    #
    # Read off the fungal genome assembly database, which carries both halves:
    # "NC_001133.9 | Saccharomyces cerevisiae S288C chromosome I, ...". The
    # accessions are S288C's, so only S. cerevisiae resolves -- which is correct,
    # because it is the only fungus AGR's JBrowse 2 hosts. A hit in any of the
    # other ~60 fungal species returns nil and gets no link, since there is no
    # browser to send it to.
    SGD_REFSEQ_CHROMOSOME = {
      "NC_001133" => "chrI",    "NC_001134" => "chrII",   "NC_001135" => "chrIII",
      "NC_001136" => "chrIV",   "NC_001137" => "chrV",    "NC_001138" => "chrVI",
      "NC_001139" => "chrVII",  "NC_001140" => "chrVIII", "NC_001141" => "chrIX",
      "NC_001142" => "chrX",    "NC_001143" => "chrXI",   "NC_001144" => "chrXII",
      "NC_001145" => "chrXIII", "NC_001146" => "chrXIV",  "NC_001147" => "chrXV",
      "NC_001148" => "chrXVI",  "NC_001224" => "chrmt"
    }.freeze

    def self.extract_sgd_chromosome(hit_title, blast_accession)
      if hit_title && !hit_title.empty?
        chr_match = hit_title.match(/chromosome[\s=]+([IVXL]+)\b/i)
        if chr_match
          roman = chr_match[1].upcase
          return SGD_ROMAN_MAP[roman] if SGD_ROMAN_MAP[roman]
        end

        # The feature sets (ORF and RNA) abbreviate it instead: "Chr I from
        # 335-649". Without this they fell through to the generic fallback in
        # extract_ref_name, which returned the first word of the defline -- the
        # gene name, "YAL069W", which is not a sequence JBrowse can find.
        feature_match = hit_title.match(SGD_FEATURE_LOCATION)
        if feature_match
          chromosome = feature_match[1]
          return "chrmt" if chromosome.match?(/\AMito/i)

          roman = chromosome.upcase
          return SGD_ROMAN_MAP[roman] if SGD_ROMAN_MAP[roman]
        end
      end

      # Tried after the title, which is the more specific signal where it exists:
      # the genome assembly carries BOTH an NC_ accession and "chromosome I" in
      # its description, and the two agree.
      if blast_accession
        refseq = blast_accession[/\bNC_\d{6}/]
        chromosome = SGD_REFSEQ_CHROMOSOME[refseq] if refseq
        return chromosome if chromosome
      end

      return "chrmt" if hit_title && hit_title.match(/mitochondri/i)

      nil
    end

    # Where SGD says a feature lives, as given in its own deflines:
    #
    #   YAL069W SGDID:S000002143, Chr I from 335-649, ...
    #   PAU8 SGDID:S000002142, Chr I from 2169-1807, ..., reverse complement, ...
    #   TRN1 SGDID:S000006680, Chr I from 139152-139187,139219-139254, ...
    #   Chr I from 802-1806, ..., between TEL01L and YAL068C        (intergenic)
    #   Q0010 SGDID:S000007257, Chr Mito from 3952-4338, ...
    #
    # The chromosome token set is closed: Chr I..Chr XVI and Chr Mito. A
    # descending range means the feature is on the reverse strand.
    SGD_FEATURE_LOCATION = /\bChr\s+([IVXL]+|Mito)\s+from\s+((?:\d+-\d+)(?:,\d+-\d+)*)/i

    # The ranges a defline names, as [[from, to], ...], or nil where it names
    # none. Coordinates are kept in the order given: a descending pair carries
    # the strand, which the caller needs in order to map offsets.
    # The same information, as NCBI writes it in the fungal CDS and protein
    # sets. Measured across all 6020 S. cerevisiae CDS entries, six shapes occur:
    #
    #   [location=2480..2707]                                  2858
    #   [location=complement(1807..2169)]                      2833
    #   [location=join(87286..87387,87501..87752)]              176
    #   [location=complement(join(53260..54377,54687..54696))]  149   ACT1
    #   [location=join(1,100..200)]                               2
    #   [location=complement(join(100..200,1))]                   2
    #
    # NCBI always lists coordinates ascending and marks the reverse strand with
    # complement(); SGD encodes the strand by descending the range instead. This
    # normalises to SGD's convention, so the same ACT1 comes out as
    # [[54377, 53260], [54696, 54687]] either way and genomic_hsp_spans needs no
    # new case. The last two shapes carry a bare coordinate, which is one base.
    NCBI_FEATURE_LOCATION = /\[location=([^\]]+)\]/

    def self.ncbi_feature_ranges(hit_title)
      match = hit_title.match(NCBI_FEATURE_LOCATION)
      return nil unless match

      location = match[1]
      ranges = location.scan(/(\d+)(?:\.\.(\d+))?/).map do |from, to|
        [from.to_i, (to || from).to_i]
      end
      return nil if ranges.empty?
      return nil if ranges.any? { |range| range.any?(&:zero?) }

      location.include?('complement') ? ranges.map(&:reverse) : ranges
    end

    def self.defline_feature_ranges(hit_title)
      return nil if hit_title.nil? || hit_title.empty?

      match = hit_title.match(SGD_FEATURE_LOCATION)
      return ncbi_feature_ranges(hit_title) unless match

      ranges = match[2].split(',').map { |range| range.split('-').map(&:to_i) }
      return nil if ranges.empty?
      return nil unless ranges.all? { |r| r.length == 2 && r.none?(&:zero?) }

      ranges
    end

    # A hit's subject coordinates expressed on the chromosome, as [[start, end],
    # ...] with start <= end.
    #
    # For a genome assembly the two are already the same thing: the subject IS
    # the chromosome. For a feature database -- SGD's ORF, RNA and protein sets
    # -- the subject is one gene, and an HSP's sstart/send are offsets into that
    # gene. Passing them through unchanged is what sent the browser to the start
    # of the chromosome: an ACT1 hit covering 1..456 of the CDS opened
    # chrVI:1..456 instead of the ACT1 locus at 53260..54696.
    #
    # Pass protein = true for a hit in a protein database.
    def self.genomic_hsp_spans(hit_title, hsps, protein = false)
      spans = hsps.map do |hsp|
        hsp['sstart'] > hsp['send'] ? [hsp['send'], hsp['sstart']] : [hsp['sstart'], hsp['send']]
      end

      ranges = defline_feature_ranges(hit_title)
      return spans unless ranges

      # Exact placement is possible only for a nucleotide subject occupying one
      # contiguous range. Two things rule it out:
      #
      # Protein. The offsets are amino acids, which are not the feature's units
      # -- offset n is nucleotide 3n-2 of the CDS -- and the reading frame does
      # not survive an intron at all.
      #
      # Spliced. The subject is the joined product, so an offset into it does
      # not map linearly onto the genome. Not a rare path: ACT1, which the
      # shipped SGD example searches, is "Chr VI from 54377-53260,54696-54687",
      # and those ranges are not in transcription order -- it is on the reverse
      # strand, so its first exon is the one at the HIGHER coordinates, listed
      # second. Walking them to place an offset would have to know that, and
      # getting it wrong puts the highlight in the neighbouring gene.
      #
      # Either way the whole feature is used, which is also the honest thing to
      # show: the hit is somewhere in this gene.
      if protein || ranges.length > 1
        coordinates = ranges.flatten
        return [[coordinates.min, coordinates.max]]
      end

      from, to = ranges.first
      if from <= to
        spans.map { |start, finish| [from + start - 1, from + finish - 1] }
      else
        # Reverse strand: offset 1 of the subject is the HIGHER coordinate, so
        # the offsets run back down the chromosome and the ends swap over.
        spans.map { |start, finish| [from - finish + 1, from - start + 1] }
      end
    end

    # Main extraction method that delegates to MOD-specific methods
    def self.extract_ref_name(hit_title, blast_accession, database_path = nil, genome_browser_metadata = nil)
      # Determine which MOD based on genome browser metadata or database path
      if genome_browser_metadata
        if genome_browser_metadata["url"]&.include?("flybase")
          # Try FlyBase-specific extraction
          ref_name = extract_flybase_chromosome(hit_title, blast_accession)
          return ref_name if ref_name
        elsif genome_browser_metadata["url"]&.include?("wormbase")
          # Try WormBase-specific extraction
          ref_name = extract_wormbase_chromosome(hit_title, blast_accession, database_path)
          return ref_name if ref_name
        elsif genome_browser_metadata["url"]&.include?("rgd")
          # Try RGD-specific extraction
          ref_name = extract_rgd_chromosome(hit_title, blast_accession)
          return ref_name if ref_name
        # "yeastgenome" alone stopped identifying SGD when it moved to AGR's
        # JBrowse 2: the url became www.alliancegenome.org, and only the
        # database_path fallback further down was still getting these right.
        # The assembly name is what distinguishes SGD there.
        elsif genome_browser_metadata["url"]&.include?("yeastgenome") ||
              genome_browser_metadata["assembly"]&.include?("Saccharomyces")
          # Try SGD-specific extraction
          ref_name = extract_sgd_chromosome(hit_title, blast_accession)
          return ref_name if ref_name
        end
      end

      # Try to determine MOD from database path or accession format
      if database_path&.include?("WB") || blast_accession&.include?("BL_ORD_ID")
        # Try WormBase extraction
        ref_name = extract_wormbase_chromosome(hit_title, blast_accession, database_path)
        return ref_name if ref_name
      end

      if database_path&.include?("FB") || (hit_title && (hit_title.include?("type=golden_path") || hit_title.include?("type=intergenic")))
        # Try FlyBase extraction
        ref_name = extract_flybase_chromosome(hit_title, blast_accession)
        return ref_name if ref_name
      end

      if database_path&.include?("RGD") || (hit_title && hit_title.include?("Rattus norvegicus"))
        # Try RGD extraction
        ref_name = extract_rgd_chromosome(hit_title, blast_accession)
        return ref_name if ref_name
      end

      if database_path&.include?("SGD") || (hit_title && hit_title.include?("Saccharomyces cerevisiae"))
        ref_name = extract_sgd_chromosome(hit_title, blast_accession)
        return ref_name if ref_name
      end

      # Generic fallback: extract the first word from title
      if hit_title && !hit_title.empty?
        seq_name = hit_title.split(/[\s,;]/)[0]
        return seq_name unless seq_name.empty? || DEFLINE_ATTRIBUTE.match?(seq_name)
      end

      # Final fallback: return the original accession
      blast_accession
    end

    def self.jbrowse(genome_browser_metadata, filepath_parts, hsps, accession, hit_title = nil, database_path = nil, protein = false)
        assembly = genome_browser_metadata["assembly"]
        if genome_browser_metadata["type"] == "jbrowse"
            subfeatures = []

            features_start = -1
            features_end = -1
            # Limit to first 5 HSPs to keep URLs manageable
            limited_spans = Links.genomic_hsp_spans(hit_title, hsps, protein).first(5)
            for span in limited_spans
              # Use hit title if available, otherwise fall back to accession
              refname = Links.extract_ref_name(hit_title, accession, database_path, genome_browser_metadata)
              sequence_start, sequence_end = span

              if features_start == -1 || features_start > sequence_start
                features_start = sequence_start
              end

              if features_end == -1 || features_end < sequence_end
                features_end = sequence_end
              end

              subfeature = {"seq_id": refname,
                            "start": sequence_start,
                            "end": sequence_end,
                            "type": "match_part"}
              subfeatures.push(subfeature)
            end

            ref_name = Links.extract_ref_name(hit_title, accession, database_path, genome_browser_metadata)

            # Don't generate JBrowse link if we don't have a valid chromosome/reference name
            return nil if ref_name.nil? || ref_name.empty? || ref_name.start_with?("type=") || ref_name.include?("gnl|BL_ORD_ID")

            # Zoom to the first (best) HSP with padding
            first_start, first_end = limited_spans.first
            hsp_length = first_end - first_start
            padding = [hsp_length * 2, 1000].max
            loc_start = [first_start - padding, 1].max
            loc_end = first_end + padding

            loc = ERB::Util.url_encode(ref_name + ":" + loc_start.to_s + ".." + loc_end.to_s)
            features = ERB::Util.url_encode(JSON.generate([{
                :seq_id => ref_name,
                :start => features_start,
                :end => features_end,
                :type => "match",
                :subfeatures => subfeatures
            }]))
            # Use FlyBase default tracks if none specified or if FlyBase metadata tracks don't work
            if genome_browser_metadata["url"] && genome_browser_metadata["url"].include?("flybase")
              # Override with working FlyBase tracks
              default_flybase_tracks = ["Gene_span", "RNA"]
              tracks = ERB::Util.url_encode(default_flybase_tracks.join(",") + ",Hits")
            else
              tracks = ERB::Util.url_encode(genome_browser_metadata["tracks"].join(",") + ",Hits")
            end
            add_tracks = ERB::Util.url_encode('[{"label":"Hits","type":"JBrowse/View/Track/CanvasFeatures","store":"url","subParts":"match_part","glyph":"JBrowse/View/FeatureGlyph/Segments"}]')

            base_url = genome_browser_metadata['url']
            if assembly.nil? || assembly.empty? || base_url.include?("data=")
              separator = base_url.include?('?') ? '&' : '?'
              url = "#{base_url}#{separator}loc=#{loc}" \
                    "&addFeatures=#{features}" \
                    "&addTracks=#{add_tracks}" \
                    "&tracks=#{tracks}" \
                    "&highlight="
            else
              url = "#{base_url}" \
                    "?data=data/#{assembly}" \
                    "&loc=#{loc}" \
                    "&addFeatures=#{features}" \
                    "&addTracks=#{add_tracks}" \
                    "&tracks=#{tracks}" \
                    "&highlight="
            end
        elsif genome_browser_metadata["type"] == "jbrowse2"
            unique_ids = []
            subfeatures = []

            features_start = -1
            features_end = -1
            count = 1
            # Limit to first 5 HSPs to keep URLs manageable
            limited_spans = Links.genomic_hsp_spans(hit_title, hsps, protein).first(5)
            for span in limited_spans
              refname = Links.extract_ref_name(hit_title, accession, database_path, genome_browser_metadata)
              sequence_start, sequence_end = span

              if features_start == -1 || features_start > sequence_start
                features_start = sequence_start
              end

              if features_end == -1 || features_end < sequence_end
                features_end = sequence_end
              end
 
              unique_id = sequence_start.to_s + "-" + sequence_end.to_s + "-" + count.to_s
              count = count + 1
              unique_ids = unique_ids.push(unique_id)

              subfeature = {"uniqueId": unique_id,
                            "refName": refname,
                            "start": sequence_start,
                            "end": sequence_end}
              subfeatures.push(subfeature)
            end

            session_tracks = ERB::Util.url_encode(
                             [{"type": "FeatureTrack",
                              "trackId":"blasthits",
                              "name": "BLAST Hits",
                              "assemblyNames": [assembly],
                              "adapter":{"type":"FromConfigAdapter",
                                         "features": [{"uniqueId": unique_ids.join(","),
                                                      "refName": refname,
                                                      "start": features_start,
                                                      "end": features_end,
                                                      "name": "Hits",
                                                      "subfeatures": subfeatures}]}}].to_json)
            tracks = ERB::Util.url_encode(genome_browser_metadata["tracks"].join(",") + ",blasthits")
            ref_name = Links.extract_ref_name(hit_title, accession, database_path, genome_browser_metadata)

            # Don't generate JBrowse2 link if we don't have a valid chromosome/reference name
            return nil if ref_name.nil? || ref_name.empty? || ref_name.start_with?("type=") || ref_name.include?("gnl|BL_ORD_ID")

            # Zoom to the first (best) HSP with padding, so hits are visible
            # even when multiple HSPs are far apart on the chromosome
            first_start, first_end = limited_spans.first
            hsp_length = first_end - first_start
            padding = [hsp_length * 2, 1000].max
            loc_start = [first_start - padding, 1].max
            loc_end = first_end + padding

            loc = ERB::Util.url_encode(ref_name + ":" + loc_start.to_s + ".." + loc_end.to_s)

            base_url = genome_browser_metadata['url']
            separator = base_url.include?('?') ? '&' : '?'
            url = "#{base_url}#{separator}" \
                         "loc=#{loc}" \
                         "&tracks=#{tracks}"\
                         "&sessionTracks=#{session_tracks}" \
                         "&assembly=#{assembly}"
       end

       {
         :order => 2,
         :title => 'JBrowse',
         :url   => url,
         :icon  => 'fa-external-link'
       }
    end

    def self.mod_gene(genome_browser_metadata, filepath_parts, url_data)
        {
         order: 2,
         title: "#{filepath_parts[2]}: #{url_data['display_name']}",
         url:   "#{genome_browser_metadata['mod_gene_url']}#{url_data['id']}",
         icon:  'fa-external-link'
        }
    end

    def self.agr_gene(filepath_parts, url_data)
        {
         order: 2,
         title: "Alliance: #{url_data['display_name']}",
         url: "https://www.alliancegenome.org/gene/#{filepath_parts[2]}:#{url_data['id']}",
         icon: 'fa-external-link'
        }
    end

    # Gene identifiers the Alliance can resolve, recognised by the shape of the
    # identifier itself rather than by the MOD segment of the URL. The two do
    # not always agree -- XenBase is served under /blast/XB/ but mints Xenbase:
    # CURIEs, and MGD under /blast/MGD/ mints MGI: -- and a wrong prefix gives a
    # link that 400s rather than one that visibly fails here.
    #
    # Each pattern was read off the deployed deflines:
    #
    #   WB    wormpep=CE32785 gene=WBGene00007064 locus=rga-9 status=Confirmed
    #   FB    ID=FBpp0070000; name=Nep3-PA; parent=FBgn0031081,FBtr0070000;
    #   SGD   PAU8 SGDID:S000002142, Chr I from 2169-1807, ...
    #   ZFIN  tpe|OTTDART00000003965|OTTDARG00000003778|ZDB-GENE-030616-226 itsn1|...
    #
    # FlyBase is deliberately anchored on parent=. A bare /FBgn\d+/ also matches
    # the intergenic-region sets, whose deflines are NAMED after a flanking gene
    # ("_intergenic_FBgn0259837") without being that gene.
    AGR_GENE_PATTERNS = [
      ['WB',   /\bgene=(WBGene\d+)/],
      ['FB',   /\bparent=[^;]*?\b(FBgn\d+)/],
      # Two spellings deployed: SGD's own "SGDID:S000002142" and the fungal
      # sets' NCBI-derived "db_xref=SGD:S000002142".
      ['SGD',  /\bSGD(?:ID)?:(S\d+)/],
      ['ZFIN', /\b(ZDB-GENE-[\d-]+\d)/]
    ].freeze

    # The gene symbol a defline offers for display, where it carries one that is
    # unambiguously the symbol. Falls back to the identifier, which is always
    # meaningful even if less readable.
    AGR_GENE_SYMBOL = {
      # locus=rga-9. Many WormBase genes are unnamed and carry no locus at all.
      'WB' => /\blocus=([^\s;]+)/,
      # name=Nep3-PA is the isoform; the gene symbol is the part before it.
      'FB' => /\bname=([^\s;]+?)-[A-Z]{2}\b/,
      # SGD leads with the symbol (PAU8) or, for unnamed ORFs, the systematic
      # name (YAL069W). Either is the right thing to show. The fungal sets name
      # it in a tag instead, and omit the tag entirely for unnamed ORFs -- which
      # then fall through to the identifier, as they should.
      'SGD' => [/\A([A-Za-z0-9-]+)\s+SGDID:/, /\A\[gene=([^\]]+)\]/],
      # ZFIN's title opens with the symbol: "itsn1|OTTDARP00000003616 ...",
      # also "si:ch211-106g8.33|" and "zgc:..." forms. Anchored on a lowercase
      # first letter so that the clone names that appear in the same position in
      # other sets ("CH211-107M8.1-002|", "DKEY-193P22.2|") are left to fall
      # back to the identifier rather than be shown as a gene symbol.
      'ZFIN' => /\A([a-z][^|\s]*)\|/
    }.freeze

    # A link to the Alliance gene page for a hit, derived from its defline.
    #
    # This is separate from agr_gene above, which needs a gene_track configured
    # and a jbrowse-nclist-cli lookup against genomic coordinates to succeed. It
    # therefore produces nothing for the protein and transcript databases, which
    # are exactly the ones whose deflines name the gene outright.
    # Every field is searched because BLAST splits a defline at its first space,
    # and which half the gene id lands in depends on how the MOD orders its
    # defline. WormBase, FlyBase and SGD name the gene in the title. ZFIN leads
    # with a pipe-delimited field, so its id ends up in Hit_id instead -- and
    # because ZFIN's databases are built without -parse_seqids, its Hit_accession
    # is a useless gnl|BL_ORD_ID|N:
    #
    #   id         tpe|OTTDART00000003966|OTTDARG00000003778|ZDB-GENE-030616-226
    #   accession  gnl|BL_ORD_ID|1
    #   title      itsn1|OTTDARP00000003617 BUSM1-173A8.1-002 ...
    #
    # Pass the title first: it is where a readable gene symbol lives when there
    # is one.
    # The MOD's own gene report, where the MOD has one. Offered alongside the
    # Alliance link rather than instead of it: a curator working in FlyBase
    # asked for FlyBase's page, and a visitor comparing organisms wants the
    # Alliance's. Neither is a substitute for the other.
    MOD_GENE_URL = {
      'FB' => { name: 'FlyBase', url: 'https://flybase.org/reports/' }
    }.freeze

    # The gene a defline names, as { mod:, id:, symbol: }, or nil where it names
    # none. Shared by every link that needs it and by the hit list, so that the
    # symbol shown in the table and the symbol on the link can never disagree.
    def self.gene_from_defline(*fields)
      fields = fields.compact.reject(&:empty?)
      return nil if fields.empty?

      prefix, id = nil, nil
      AGR_GENE_PATTERNS.each do |mod, pattern|
        match = fields.filter_map { |field| field.match(pattern) }.first
        next unless match

        prefix, id = mod, match[1]
        break
      end
      return nil unless id

      # The symbol is looked for in the title ONLY, never in the other fields.
      # Searching all of them let ZFIN's own id prefix win: "tpe|OTTDART..."
      # satisfies the ZFIN symbol pattern, so a hit whose title held no symbol
      # was labelled "Alliance: tpe".
      # A MOD may spell the symbol more than one way across its own datasets,
      # so each entry is a list tried in order.
      symbol_patterns = Array(AGR_GENE_SYMBOL[prefix])
      symbol = symbol_patterns.filter_map { |pattern| fields.first[pattern, 1] }.first
      symbol = nil if symbol.to_s.empty?

      { mod: prefix, id: id, symbol: symbol }
    end

    def self.agr_gene_from_defline(*fields)
      gene = gene_from_defline(*fields)
      return nil unless gene

      {
        order: 2,
        title: "Alliance: #{gene[:symbol] || gene[:id]}",
        url: "https://www.alliancegenome.org/gene/#{gene[:mod]}:#{ERB::Util.url_encode(gene[:id])}",
        icon: 'fa-external-link'
      }
    end

    # Deliberately ordered ahead of the Alliance link: on a MOD's own
    # deployment, its own gene report is the one a curator reaches for.
    def self.mod_gene_from_defline(*fields)
      gene = gene_from_defline(*fields)
      return nil unless gene

      mod = MOD_GENE_URL[gene[:mod]]
      return nil unless mod

      {
        order: 1,
        title: "#{mod[:name]}: #{gene[:symbol] || gene[:id]}",
        url: "#{mod[:url]}#{ERB::Util.url_encode(gene[:id])}",
        icon: 'fa-external-link'
      }
    end

    # An NCBI Gene identifier named outright in the defline. Two spellings are
    # deployed, both from NCBI-derived FASTA:
    #
    #   [db_xref=GeneID:66069077]                     SGD's fungal coding sets
    #   ... aminopeptidase N (LOC100144773), mRNA     FlyBase's non-Drosophila sets
    #
    # A LOC number IS the Gene id, so both resolve at /gene/<id>.
    NCBI_GENE_ID = /\bdb_xref=GeneID:(\d+)|\(LOC(\d+)\)/

    def self.ncbi_gene(*fields)
      fields = fields.compact.reject(&:empty?)
      return nil if fields.empty?

      match = fields.filter_map { |field| field.match(NCBI_GENE_ID) }.first
      return nil unless match

      id = match[1] || match[2]
      {
        order: 3,
        title: "NCBI Gene: #{id}",
        url: "https://www.ncbi.nlm.nih.gov/gene/#{id}",
        icon: 'fa-external-link'
      }
    end

    # RefSeq accession prefixes, and whether each names a protein record.
    # BLAST reports Hit_accession without the version suffix, so the version is
    # optional here even though the FASTA deflines carry it.
    REFSEQ_ACCESSION = /\A(N[CGTWZ]|N[MR]|[NXYAZ]P|XM|XR)_\d+(?:\.\d+)?\z/
    REFSEQ_PROTEIN_PREFIX = /\A[NXYAZ]P_/

    def self.ncbi_link(accession, hit_title, dbtype)
      return nil if accession.nil? || accession.empty?

      ncbi_acc = nil
      is_protein = nil

      # Prefer an explicit protein_id from the defline, e.g. [protein_id=NP_009332.1]
      if hit_title
        protein_match = hit_title.match(/\[protein_id=([A-Za-z0-9_.]+)\]/)
        if protein_match
          ncbi_acc = protein_match[1]
          is_protein = true
        end
      end

      # Otherwise accept the hit accession only if it really looks like RefSeq.
      # A looser pattern would link MOD-native identifiers (SGD's Q0010, WormBase
      # gene names) to NCBI records that do not exist.
      unless ncbi_acc
        embedded = accession[/(?:N[CGTWZ]|N[MR]|[NXYAZ]P|XM|XR)_\d+(?:\.\d+)?/]
        candidate = accession.match?(REFSEQ_ACCESSION) ? accession : embedded
        ncbi_acc = candidate if candidate
      end

      # FlyBase names the RefSeq record in its cross-reference list rather than
      # in the accession, which is FlyBase's own FBpp/FBtr id:
      #
      #   ID=FBpp0070000; ... dbxref=FlyBase:FBpp0070000,...,REFSEQ:NP_523417,...
      #
      # Without this a FlyBase hit carries no NCBI link at all, even though the
      # defline says exactly which record it is.
      if !ncbi_acc && hit_title
        dbxref = hit_title[/\bdbxref=([^;]+)/, 1]
        refseq = dbxref && dbxref[/\bREFSEQ:((?:N[CGTWZ]|N[MR]|[NXYAZ]P|XM|XR)_\d+(?:\.\d+)?)/, 1]
        ncbi_acc = refseq if refseq
      end

      return nil unless ncbi_acc

      is_protein = ncbi_acc.match?(REFSEQ_PROTEIN_PREFIX) if is_protein.nil?
      # dbtype is a String ('protein'/'nucleotide'), never a Symbol.
      is_protein ||= dbtype.to_s == 'protein'

      db = is_protein ? 'protein' : 'nuccore'
      encoded_acc = ERB::Util.url_encode(ncbi_acc)

      {
        order: 3,
        title: "NCBI: #{ncbi_acc}",
        url: "https://www.ncbi.nlm.nih.gov/#{db}/#{encoded_acc}",
        icon: 'fa-external-link'
      }
    end
  end
end
# [1]: https://stackoverflow.com/questions/2824126/whats-the-difference-between-ur#{sequence_id}i-escape-and-cgi-escape
