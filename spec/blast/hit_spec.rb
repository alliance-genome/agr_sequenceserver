require 'spec_helper'
require 'sequenceserver/blast/hit'

# Which config entry describes the database a hit came from.
#
# WormBase stores all five of its C. elegans databases under the filename
# "c_elegansdb", so the uri comparison in Hit#links saw "c_elegans" for every
# one of them and bound the lot to the N2 entry. A CB4856 hit was handed N2's
# genome_browser, pointing at assembly c_elegans_PRJNA13758, and N2's
# seqid_prefix, which left "CB4856_II" unstripped because there was no "N2_" to
# remove. The directory name is what tells them apart.
module SequenceServer
  module BLAST
    describe Hit do
      WS298 = [
        { 'blast_title' => 'C. elegans Genome Assembly',
          'seqid_prefix' => 'N2',
          'uri' => 'ftp://ftp.ebi.ac.uk/pub/.../PRJNA13758/c_elegans.PRJNA13758.WS298.genomic.fa.gz',
          'genome_browser' => { 'assembly' => 'c_elegans_PRJNA13758' } },
        { 'blast_title' => 'C. elegans CB4856 Genome Assembly',
          'seqid_prefix' => 'CB4856',
          'uri' => 'ftp://ftp.ebi.ac.uk/pub/.../PRJNA275000/c_elegans.PRJNA275000.WS298.genomic.fa.gz',
          'genome_browser' => { 'assembly' => 'c_elegans_PRJNA275000' } },
        { 'blast_title' => 'C. elegans Protein Sequences',
          'uri' => 'ftp://ftp.ebi.ac.uk/pub/.../PRJNA13758/c_elegans.PRJNA13758.WS298.protein.fa.gz' }
      ].freeze

      # Hit#config_entries_for_database only reads hit_db.name, so a stand-in
      # carrying that one value exercises it without building a report.
      def hit_for(path)
        hit = Hit.allocate
        db = double(name: path)
        allow(hit).to receive(:hit_db).and_return(db)
        [hit, db]
      end

      describe '#config_entries_for_database' do
        it 'picks the entry whose title names the database directory' do
          hit, db = hit_for('/db/WB/WS298/databases/Caenorhabditis/elegans/' \
                            'C_elegans_CB4856_Genome_Assembly/c_elegansdb')
          entries = hit.config_entries_for_database(WS298, db)

          expect(entries.size).to eq 1
          expect(entries.first['seqid_prefix']).to eq 'CB4856'
          expect(entries.first['genome_browser']['assembly']).to eq 'c_elegans_PRJNA275000'
        end

        it 'picks N2 for the database directory that names it' do
          hit, db = hit_for('/db/WB/WS298/databases/Caenorhabditis/elegans/' \
                            'C_elegans_Genome_Assembly/c_elegansdb')
          entries = hit.config_entries_for_database(WS298, db)

          expect(entries.first['seqid_prefix']).to eq 'N2'
        end

        # The older FlyBase releases name their directories with an accession
        # the titles do not carry, RGD's are strain names, and one ZFIN pair
        # sanitises to the same title. Returning nil there leaves Hit#links on
        # the uri comparison it used before, so none of those change.
        it 'returns nil when no entry names the directory' do
          hit, db = hit_for('/db/FB/FB2024_02/databases/x/y/' \
                            'A_aegypti_Genome_Assembly_GCF_002204515_2_AaegL5_0_/db')
          expect(hit.config_entries_for_database(WS298, db)).to be_nil
        end

        it 'returns nil when two entries sanitise to the same title' do
          ambiguous = [
            { 'blast_title' => 'Danio rerio!', 'uri' => 'a' },
            { 'blast_title' => 'Danio rerio?', 'uri' => 'b' }
          ]
          hit, db = hit_for('/db/ZFIN/prod/databases/Danio/rerio/Danio_rerio/x')
          expect(hit.config_entries_for_database(ambiguous, db)).to be_nil
        end
      end

      describe '.sanitise_title' do
        it 'matches the directory names the build writes' do
          expect(Hit.sanitise_title('C. elegans CB4856 Genome Assembly'))
            .to eq 'C_elegans_CB4856_Genome_Assembly'
          expect(Hit.sanitise_title('X laevis. XENLA_10.1')).to eq 'X_laevis_XENLA_10_1'
          expect(Hit.sanitise_title('RGD mRatBN7.2')).to eq 'RGD_mRatBN7_2'
        end
      end
    end
  end
end
