require 'spec_helper'

# A database built with seqid_prefix carries ids like "WBcel235_I" rather than
# "I". Every genome browser refName rule reads the chromosome out of the
# accession, so the prefix has to come off first -- otherwise prefixing a
# database to fix result conflation would silently stop its JBrowse links,
# breaking a working feature to fix a different one.
module SequenceServer
  RSpec.describe Links do
    describe '.strip_seqid_prefix' do
      it 'removes a leading prefix and its separator' do
        expect(Links.strip_seqid_prefix('WBcel235_I', 'WBcel235')).to eq('I')
        expect(Links.strip_seqid_prefix('GRCh38_1', 'GRCh38')).to eq('1')
        expect(Links.strip_seqid_prefix('mRatBN7.2_18', 'mRatBN7.2')).to eq('18')
      end

      it 'leaves an unprefixed accession exactly as it is' do
        # The overwhelmingly common case: no MOD but ALLIANCE is prefixed.
        expect(Links.strip_seqid_prefix('I', nil)).to eq('I')
        expect(Links.strip_seqid_prefix('I', '')).to eq('I')
        expect(Links.strip_seqid_prefix('NC_001133.9', nil)).to eq('NC_001133.9')
      end

      it 'does not strip a prefix the accession does not carry' do
        expect(Links.strip_seqid_prefix('GRCm39_1', 'GRCh38')).to eq('GRCm39_1')
      end

      it 'removes only the first occurrence, so an id may contain the prefix again' do
        expect(Links.strip_seqid_prefix('R64_chrR64_1', 'R64')).to eq('chrR64_1')
      end

      it 'keeps underscores that belong to the id' do
        expect(Links.strip_seqid_prefix('XENTR9.1_scaffold_57', 'XENTR9.1'))
          .to eq('scaffold_57')
      end

      it 'is safe on a nil accession' do
        expect(Links.strip_seqid_prefix(nil, 'GRCh38')).to be_nil
      end

      it 'leaves the chromosome recognisable to the WormBase rule' do
        # The actual point: "WBcel235_I" is not in WORMBASE_CHROMOSOME_MAP and
        # "I" is, so stripping is what keeps the link.
        stripped = Links.strip_seqid_prefix('WBcel235_I', 'WBcel235')
        expect(Links::WORMBASE_CHROMOSOME_MAP[stripped]).not_to be_nil
        expect(Links::WORMBASE_CHROMOSOME_MAP['WBcel235_I']).to be_nil
      end
    end
  end
end
