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
    end
  end
end
