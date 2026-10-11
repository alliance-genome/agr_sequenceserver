require 'spec_helper'

# These cover the reference name a hit contributes to a genome browser URL.
#
# The cases are drawn from deflines that are actually deployed, because the bug
# they guard against was not a malformed name but a plausible-looking one: a
# WormBase protein hit produced "wormpep=CE09349", which JBrowse accepted as a
# sequence name and then failed to find.
module SequenceServer
  describe Links do
    describe '.extract_ref_name' do
      WORMBASE = { 'url' => 'https://wormbase.org/tools/genome/jbrowse2/index.html' }.freeze
      FLYBASE  = { 'url' => 'https://flybase.org/jbrowse' }.freeze

      it 'maps a WormBase Roman chromosome through' do
        name = Links.extract_ref_name('III  length=13783801', 'III', '/db/WB/WS298/x', WORMBASE)
        expect(name).to eq 'III'
      end

      it 'maps a WormBase Arabic chromosome to its Roman form' do
        name = Links.extract_ref_name('2 length=15279421', '2', '/db/WB/WS298/x', WORMBASE)
        expect(name).to eq 'II'
      end

      # The reported bug. A WormBase protein defline opens with an attribute
      # pair, which the generic fallback used to return verbatim.
      it 'refuses a WormBase protein defline rather than naming it wormpep=' do
        title = 'wormpep=CE09349 gene=WBGene00006789 locus=unc-54 status=Confirmed'
        name = Links.extract_ref_name(title, 'F11C3.3', '/db/WB/WS298/x', WORMBASE)
        expect(name).not_to include '='
      end

      # FlyBase is the counter-example that shows why the attribute filter is
      # not on its own enough. Its polypeptide deflines carry the chromosome in
      # a loc= attribute, so the FlyBase extractor returns a real chromosome and
      # never reaches the generic fallback. The name is fine; the hit's
      # coordinates are still amino acid offsets. What keeps a protein hit off
      # the genome browser is the database type check in Hit#links, not this.
      it 'still reads the chromosome out of a FlyBase polypeptide defline' do
        title = 'type=polypeptide; loc=X:join(19963955..19964071); ID=FBpp0070000'
        name = Links.extract_ref_name(title, 'FBpp0070000', '/db/FB/FB2026_03/x', FLYBASE)
        expect(name).to eq 'X'
      end

      it 'refuses an attribute defline that reaches the generic fallback' do
        name = Links.extract_ref_name('protein_id=ABC123 note=hypothetical', 'ABC123', nil, nil)
        expect(name).to eq 'ABC123'
      end

      it 'refuses a length-only defline' do
        name = Links.extract_ref_name('length=14890789', 'X', nil, nil)
        expect(name).not_to include '='
      end

      # SGD's fungal deflines open with a bracketed attribute. It is not an
      # attribute in the sense the filter rejects, and the filter must not
      # widen into it -- these databases carry no genome browser config, so
      # nothing here reaches a URL either way.
      it 'leaves a bracketed SGD fungal defline alone' do
        name = Links.extract_ref_name('[gene=PAU8] [locus_tag=YAL068C]', 'YAL068C', nil, nil)
        expect(name).to eq '[gene=PAU8]'
      end

      it 'falls back to the first word of an ordinary defline' do
        name = Links.extract_ref_name('scaffold_12 some description', 'scaffold_12', nil, nil)
        expect(name).to eq 'scaffold_12'
      end

      it 'falls back to the accession when there is no title' do
        name = Links.extract_ref_name('', 'NC_003279.8', nil, nil)
        expect(name).to eq 'NC_003279.8'
      end

      # The Alliance databases state outright that their sequence ids are the
      # browser's refNames, which they are: measured against each assembly's
      # .fai in Alliance JBrowse 2, every id resolves once its seqid_prefix is
      # off -- 705 of 705 for human, 61 of 61 for mouse, 7 of 7 for C. elegans,
      # 17 of 17 for yeast, 8 of 8 for fly.
      #
      # Each case below is a rule that claimed one of those hits first and
      # returned something Alliance JBrowse 2 cannot find.
      ALLIANCE = {
        'assembly' => 'Homo_sapiens',
        'ref_name' => 'accession',
        'tracks' => ['Homo_sapiens_all_genes'],
        'url' => 'https://www.alliancegenome.org/jbrowse2/'
      }.freeze

      it 'takes an Alliance sequence id as the refName' do
        name = Links.extract_ref_name('', '1', '/db/ALLIANCE/prod/databases/Homo/sapiens/x', ALLIANCE)
        expect(name).to eq '1'
      end

      # The scaffolds are the only Alliance sequences with a defline, and the
      # generic fallback took its first word, so the 680 human and 39 mouse
      # sequences that carry one pointed JBrowse at "Homo" or "Mus".
      it 'keeps a scaffold id rather than the first word of its defline' do
        title = 'Homo sapiens chromosome 1 unlocalized genomic scaffold, GRCh38.p14 Primary Assembly HSCHR1_CTG1_UNLOCALIZED'
        name = Links.extract_ref_name(title, 'NT_187361.1',
                                      '/db/ALLIANCE/prod/databases/Homo/sapiens/x', ALLIANCE)
        expect(name).to eq 'NT_187361.1'
      end

      # The Alliance rat database directory is named RGD_mRatBN7_2, so the
      # database path contains "RGD" and the RGD rule used to answer "Chr1"
      # where this browser wants "1".
      it 'is not intercepted by the RGD rule for a path containing RGD' do
        rat = ALLIANCE.merge('assembly' => 'Rattus_norvegicus')
        name = Links.extract_ref_name('Rattus norvegicus chromosome 1', '1',
                                      '/db/ALLIANCE/prod/databases/Rattus/norvegicus/RGD_mRatBN7_2/x', rat)
        expect(name).to eq '1'
      end

      # The Alliance yeast assembly name is "Saccharomyces_cerevisiae",
      # verbatim what the SGD rule matches on, and SGD's answer is "chrIV".
      it 'is not intercepted by the SGD rule for a Saccharomyces assembly' do
        yeast = ALLIANCE.merge('assembly' => 'Saccharomyces_cerevisiae')
        name = Links.extract_ref_name('Saccharomyces cerevisiae chromosome IV', 'chrIV',
                                      '/db/ALLIANCE/prod/databases/Saccharomyces/cerevisiae/x', yeast)
        expect(name).to eq 'chrIV'
      end

      it 'leaves a MOD entry without the key on its own rule' do
        name = Links.extract_ref_name('2 length=15279421', '2', '/db/WB/WS298/x', WORMBASE)
        expect(name).to eq 'II'
      end

      # WormBase's VC2010, C. inopinata, C. latens and O. tipulae assemblies all
      # carry the defline "1 <length>", so WORMBASE_CHROMOSOME_MAP turned every
      # sequence in those four databases into chromosome "I" -- 2,062 of them.
      # Their ids are already the refNames their browsers list, so the entries
      # say so, and the map must not get a look in.
      it 'does not map a VC2010 defline of "1" onto chromosome I' do
        vc2010 = {
          'assembly' => 'c_elegans_PRJEB28388',
          'ref_name' => 'accession',
          'url' => 'https://wormbase.org/tools/genome/jbrowse2/index.html'
        }
        name = Links.extract_ref_name('1 15525148', 'chrII_pilon',
                                      '/db/WB/WS298/databases/C_elegans_VC2010_Genome_Assembly/x',
                                      vc2010)
        expect(name).to eq 'chrII_pilon'
      end

      # c_nigoni_PRJNA384657 lists "CM008509.1" and
      # p_redivivus_PRJNA186477 lists "AOMH01000001", while BLAST keeps the
      # bar notation its FASTA used.
      it 'unwraps a bar-delimited accession' do
        nigoni = {
          'assembly' => 'c_nigoni_PRJNA384657',
          'ref_name' => 'accession',
          'url' => 'https://wormbase.org/tools/genome/jbrowse2/index.html'
        }
        name = Links.extract_ref_name('', 'gb|CM008509.1|',
                                      '/db/WB/WS298/databases/C_nigoni_Genome_Assembly/x',
                                      nigoni)
        expect(name).to eq 'CM008509.1'
      end

      it 'leaves an accession that merely contains a bar alone' do
        # SGD's genome deflines are "CHRMT|NC_001224|", a chromosome name in
        # front of a bar rather than a database tag. A first attempt matched any
        # two-to-six letters and turned this into "NC_001224"; the tag list is
        # NCBI's instead, so it survives.
        expect(Links.unwrap_accession('CHRMT|NC_001224|')).to eq 'CHRMT|NC_001224|'
        # Three fields, and BL_ORD_ID is a synthetic ordinal rather than an
        # accession.
        expect(Links.unwrap_accession('gnl|BL_ORD_ID|0')).to eq 'gnl|BL_ORD_ID|0'
        expect(Links.unwrap_accession('II')).to eq 'II'
        expect(Links.unwrap_accession(nil)).to be_nil
      end
    end

    describe '.jbrowse' do
      # "tracks" is optional in a config entry. A missing one raised
      # NoMethodError on nil, which failed the whole report rather than
      # dropping one link.
      it 'builds a JBrowse 2 link for an entry that lists no tracks' do
        metadata = {
          'assembly' => 'Homo_sapiens',
          'ref_name' => 'accession',
          'type' => 'jbrowse2',
          'url' => 'https://www.alliancegenome.org/jbrowse2/'
        }
        # Links.genomic_hsp_spans reads an HSP with [], not accessors.
        hsp = { 'sstart' => 1000, 'send' => 1300, 'qstart' => 1, 'qend' => 300 }

        link = Links.jbrowse(metadata, ['x'], [hsp], '1', '', '/db/ALLIANCE/prod/x', false)

        expect(link[:url]).to include 'assembly=Homo_sapiens'
        expect(link[:url]).to include 'tracks=blasthits'
        expect(link[:url]).to include 'loc=1'
      end
    end
  end
end
