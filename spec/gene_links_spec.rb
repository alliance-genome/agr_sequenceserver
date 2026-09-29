require 'spec_helper'

# Gene linkouts derived from the defline: the Alliance gene page, and NCBI Gene.
#
# Every defline below was read off a deployed database, and each pair is given
# the way BLAST actually hands it over -- split at the first space into an id and
# a title -- because which half carries the gene identifier differs by MOD, and
# testing against the whole defline hides that.
module SequenceServer
  describe Links do
    describe '.agr_gene_from_defline' do
      def label_for(title, id = nil, accession = nil)
        link = Links.agr_gene_from_defline(title, id, accession)
        link && link[:title]
      end

      def url_for(title, id = nil, accession = nil)
        link = Links.agr_gene_from_defline(title, id, accession)
        link && link[:url]
      end

      context 'WormBase' do
        let(:named) { 'wormpep=CE32785 gene=WBGene00007064 locus=rga-9 status=Confirmed' }
        let(:unnamed) { 'wormpep=CE32090 gene=WBGene00007063 status=Confirmed uniprot=A4F336' }

        it 'links the gene and shows its locus name' do
          expect(url_for(named, 'F11C3.3')).to eq 'https://www.alliancegenome.org/gene/WB:WBGene00007064'
          expect(label_for(named, 'F11C3.3')).to eq 'Alliance: rga-9'
        end

        it 'falls back to the identifier for a gene with no locus name' do
          expect(label_for(unnamed, 'F11C3.2')).to eq 'Alliance: WBGene00007063'
        end

        # The non-elegans nematodes use a scaffold-derived gene name that the
        # Alliance does not hold, so there is nothing to link to.
        it 'declines a gene name that is not a WBGene identifier' do
          expect(url_for('transcript=CSP29.g1.t1 gene=CSP29.g1', 'CSP29.g1.t1')).to be_nil
        end
      end

      context 'FlyBase' do
        let(:polypeptide) do
          'type=polypeptide; loc=X:join(1..2); ID=FBpp0070000; name=Nep3-PA; ' \
            'parent=FBgn0031081,FBtr0070000; dbxref=FlyBase:FBpp0070000,REFSEQ:NP_523417'
        end

        it 'links the parent gene and strips the isoform suffix from the symbol' do
          expect(url_for(polypeptide, 'FBpp0070000')).to eq 'https://www.alliancegenome.org/gene/FB:FBgn0031081'
          expect(label_for(polypeptide, 'FBpp0070000')).to eq 'Alliance: Nep3'
        end

        # An intergenic region is NAMED after a flanking gene without being that
        # gene, so anchoring on parent= rather than on a bare FBgn is what keeps
        # these unlinked.
        it 'declines an intergenic region named after a gene' do
          expect(url_for('_intergenic_FBgn0259837 type=intergenic_region; loc=2111:1..400', '2111')).to be_nil
        end

        it 'declines a genome assembly sequence' do
          expect(url_for('type=golden_path; loc=2L:1..23513712; ID=2L', '2L')).to be_nil
        end
      end

      context 'SGD' do
        it 'links the gene and shows its symbol' do
          defline = 'PAU8 SGDID:S000002142, Chr I from 2169-1807, Genome Release 64-3-1'
          expect(url_for(defline, 'PAU8_mRNA')).to eq 'https://www.alliancegenome.org/gene/SGD:S000002142'
          expect(label_for(defline, 'PAU8_mRNA')).to eq 'Alliance: PAU8'
        end

        it 'shows the systematic name for an unnamed ORF' do
          defline = 'YAL069W SGDID:S000002143, Chr I from 335-649, Genome Release 64-3-1'
          expect(label_for(defline, 'YAL069W_mRNA')).to eq 'Alliance: YAL069W'
        end

        it 'declines a chromosome sequence' do
          expect(url_for('[org=Saccharomyces cerevisiae] [strain=S288C] [chromosome=VI]', 'NC_001138')).to be_nil
        end
      end

      # ZFIN is why the identifier is looked for in every field rather than only
      # the title. Its defline leads with a pipe-delimited block, so the gene id
      # lands in Hit_id -- and its databases are built without -parse_seqids, so
      # Hit_accession is a useless gnl|BL_ORD_ID|N.
      context 'ZFIN' do
        it 'finds the gene identifier in Hit_id and the symbol in the title' do
          title = 'itsn1|OTTDARP00000003616 BUSM1-173A8.1-001 LG_ AL606751.5'
          id = 'tpe|OTTDART00000003965|OTTDARG00000003778|ZDB-GENE-030616-226'
          expect(url_for(title, id, 'gnl|BL_ORD_ID|1'))
            .to eq 'https://www.alliancegenome.org/gene/ZFIN:ZDB-GENE-030616-226'
          expect(label_for(title, id, 'gnl|BL_ORD_ID|1')).to eq 'Alliance: itsn1'
        end

        it 'keeps a si: style symbol intact' do
          title = 'si:ch211-106g8.33|OTTDARP00000003922 BUSM1-1C23.28-001'
          id = 'tpe|OTTDART00000004315|OTTDARG00000004126|ZDB-GENE-141212-117'
          expect(label_for(title, id)).to eq 'Alliance: si:ch211-106g8.33'
        end

        # The clone names that sit in the same position are not symbols. This
        # also pins the narrower bug that made the label "Alliance: tpe": the
        # symbol was being looked for in Hit_id too, where ZFIN's own "tpe|"
        # prefix satisfies the pattern.
        it 'falls back to the identifier rather than showing a clone name' do
          title = 'CH211-107M8.1-002|OTTDARP00000028185 CH211-107M8.1'
          id = 'tpe|OTTDART00000042346|OTTDARG00000030557|ZDB-GENE-090313-221'
          expect(label_for(title, id)).to eq 'Alliance: ZDB-GENE-090313-221'
        end

        it 'declines a transcript identifier' do
          title = 'CH211-107M8.2-001|OTTDARP00000028180 CH211-107M8.2'
          id = 'tpe|OTTDART00000035016|OTTDARG00000026398|ZDB-TSCRIPT-090929-15699'
          expect(url_for(title, id)).to be_nil
        end
      end

      it 'declines a defline with no gene identifier at all' do
        expect(url_for('Rattus norvegicus strain BN/NHsdMcwi chromosome 1, GRCr8', 'NC_086019.1')).to be_nil
        expect(url_for('', nil, nil)).to be_nil
      end
    end

    describe '.ncbi_gene' do
      it 'reads a GeneID cross-reference' do
        defline = '[locus_tag=E1B28_000001] [db_xref=GeneID:66069077] [protein_id=XP_043014495.1]'
        link = Links.ncbi_gene(defline)
        expect(link[:url]).to eq 'https://www.ncbi.nlm.nih.gov/gene/66069077'
        expect(link[:title]).to eq 'NCBI Gene: 66069077'
      end

      # A LOC number IS the NCBI Gene id, so it resolves at the same path.
      it 'reads a LOC number' do
        defline = 'Acyrthosiphon pisum membrane alanyl aminopeptidase N (LOC100144773), mRNA'
        expect(Links.ncbi_gene(defline)[:url]).to eq 'https://www.ncbi.nlm.nih.gov/gene/100144773'
      end

      it 'declines a defline that names no NCBI gene' do
        expect(Links.ncbi_gene('wormpep=CE32785 gene=WBGene00007064 locus=rga-9')).to be_nil
        expect(Links.ncbi_gene('PAU8 SGDID:S000002142, Chr I from 2169-1807')).to be_nil
      end
    end

    # FlyBase names the RefSeq record in its cross-reference list rather than in
    # the accession, which is FlyBase's own FBpp/FBtr id. Without reading dbxref
    # a FlyBase hit carried no NCBI link at all.
    describe '.ncbi_link from a dbxref cross-reference' do
      it 'routes a REFSEQ protein cross-reference to /protein/' do
        defline = 'type=polypeptide; ID=FBpp0070000; parent=FBgn0031081; ' \
                  'dbxref=FlyBase:FBpp0070000,GB_protein:AAF45370.2,REFSEQ:NP_523417'
        link = Links.ncbi_link('FBpp0070000', defline, 'protein')
        expect(link[:url]).to eq 'https://www.ncbi.nlm.nih.gov/protein/NP_523417'
      end

      it 'routes a REFSEQ transcript cross-reference to /nuccore/' do
        defline = 'type=miRNA; ID=FBtr0304171; dbxref=REFSEQ:NR_048074,FlyBase:FBtr0304171'
        link = Links.ncbi_link('FBtr0304171', defline, 'nucleotide')
        expect(link[:url]).to eq 'https://www.ncbi.nlm.nih.gov/nuccore/NR_048074'
      end

      it 'still declines a MOD-native accession with no cross-reference' do
        expect(Links.ncbi_link('F11C3.3', 'wormpep=CE09349 gene=WBGene00006789', 'protein')).to be_nil
        expect(Links.ncbi_link('YFL039C', 'YFL039C ACT1 SGDID:S000001855', 'nucleotide')).to be_nil
      end
    end
  end
end
