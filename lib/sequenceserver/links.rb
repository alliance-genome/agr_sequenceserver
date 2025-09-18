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

    # Extract proper reference sequence name from hit title or accession
    def self.extract_ref_name(hit_title, blast_accession, database_path = nil, genome_browser_metadata = nil)

      # First try to extract chromosome name from the hit title
      if hit_title && !hit_title.empty?
        # Handle FlyBase format: "type=golden_path; loc=2R:1..25286936; ID=2R; ..."
        if hit_title.include?("type=golden_path") && hit_title.include?("ID=")
          # Extract from ID= field which contains the chromosome name
          id_match = hit_title.match(/ID=([^;]+)/)
          if id_match
            seq_name = id_match[1].strip
            return seq_name unless seq_name.empty?
          end
        end

        # Handle FlyBase intergenic regions and other formats with loc= field
        # Format: "type=intergenic_region; loc=X:1..122492; ..."
        if hit_title.include?("loc=")
          loc_match = hit_title.match(/loc=([^:]+):/)
          if loc_match
            seq_name = loc_match[1].strip
            return seq_name unless seq_name.empty?
          end
        end

        # Extract the first word which is typically the chromosome/sequence name
        seq_name = hit_title.split(/[\s,;]/)[0]

        # For C. elegans CB4856 strain (PRJEB28388), map standard names to JBrowse format
        if database_path&.include?("WS297") && blast_accession.include?("PRJEB28388")
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

        return seq_name unless seq_name.empty?
      end

      # Fallback: return the original accession
      blast_accession
    end

    def self.jbrowse(genome_browser_metadata, filepath_parts, hsps, accession, hit_title = nil, database_path = nil)
        assembly = genome_browser_metadata["assembly"]
        if genome_browser_metadata["type"] == "jbrowse"
            subfeatures = []

            features_start = -1
            features_end = -1
            # Limit to first 5 HSPs to keep URLs manageable
            limited_hsps = hsps.first(5)
            for hsp in limited_hsps
              # Use hit title if available, otherwise fall back to accession
              refname = Links.extract_ref_name(hit_title, accession, database_path, genome_browser_metadata)
              if hsp["sstart"] > hsp["send"]
                  sequence_start = hsp["send"]
                  sequence_end = hsp["sstart"]
              else
                  sequence_start = hsp["sstart"]
                  sequence_end = hsp["send"]
              end

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
            loc = ERB::Util.url_encode(ref_name + ":" + features_start.to_s + ".." + features_end.to_s)
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

            # Check if FlyBase URL already has data parameter
            base_url = genome_browser_metadata['url']
            if base_url.include?("flybase") && base_url.include?("data=")
              # FlyBase URL already has data parameter, just add other parameters
              separator = base_url.include?('?') ? '&' : '?'
              url = "#{base_url}#{separator}loc=#{loc}" \
                    "&addFeatures=#{features}" \
                    "&addTracks=#{add_tracks}" \
                    "&tracks=#{tracks}" \
                    "&highlight="
            else
              # Standard URL construction
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
            limited_hsps = hsps.first(5)
            for hsp in limited_hsps
              refname = Links.extract_ref_name(hit_title, accession, database_path, genome_browser_metadata)
              if hsp["sstart"] > hsp["send"]
                  sequence_start = hsp["send"]
                  sequence_end = hsp["sstart"]
              else
                  sequence_start = hsp["sstart"]
                  sequence_end = hsp["send"]
              end

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
            loc = ERB::Util.url_encode(ref_name + ":" + features_start.to_s + ".." + features_end.to_s)

            url = "#{genome_browser_metadata['url']}?" \
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
  end
end
# [1]: https://stackoverflow.com/questions/2824126/whats-the-difference-between-ur#{sequence_id}i-escape-and-cgi-escape
