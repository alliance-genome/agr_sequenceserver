require 'spec_helper'

# Which databases in one search claim the same sequence id.
#
# It matters because BLAST conflates sequences that share an id across the
# databases of a single search, so the result silently misses alignments. The
# detection has to be exact in both directions: a missed collision means a
# wrong answer presented as right, and a FALSE collision means a scary warning
# on a result that is fine -- which trains people to ignore the real one.
#
# It shipped with exactly that false positive. ZFIN's databases were built
# without -parse_seqids, so their name indexes hold synthetic "BL_ORD_ID:N"
# ordinals numbered from zero in every database. Comparing those found 21 of
# ZFIN's 21 database pairs "colliding" and warned a user about 40,280 shared
# ids on a search that was complete.
module SequenceServer
  RSpec.describe BLAST::Report do
    # A stand-in for Database carrying just what the detection reads.
    Stub = Struct.new(:title, :accessions)

    def shared(*databases)
      report = BLAST::Report.allocate
      job = double('job', databases: databases)
      report.instance_variable_set(:@job, job)
      allow(report).to receive(:job).and_return(job)
      report.send(:compute_shared_accessions)
    end

    it 'finds an id two databases both claim' do
      result = shared(
        Stub.new('Human_GRCh38', Set['1', '2', 'X']),
        Stub.new('Mouse_GRCm39', Set['1', '2', 'Y'])
      )

      expect(result[:count]).to eq(2)
      expect(result[:databases]).to eq(%w[Human_GRCh38 Mouse_GRCm39])
      expect(result[:examples]).to eq(%w[1 2])
    end

    it 'says nothing when the ids are distinct' do
      expect(shared(
        Stub.new('A', Set['GRCh38_1']),
        Stub.new('B', Set['GRCm39_1'])
      )).to be_nil
    end

    it 'says nothing about a single database' do
      expect(shared(Stub.new('A', Set['1', '2']))).to be_nil
    end

    it 'ignores BL_ORD_ID ordinals, which are not sequence ids' do
      # The shipped false positive. Every non -parse_seqids database numbers
      # these from zero, so they are identical everywhere and mean nothing.
      expect(shared(
        Stub.new('Ensembl_Transcripts', Set['BL_ORD_ID:0', 'BL_ORD_ID:1']),
        Stub.new('VEGA_Transcript',     Set['BL_ORD_ID:0', 'BL_ORD_ID:1'])
      )).to be_nil
    end

    it 'still reports a real collision alongside BL_ORD_ID ordinals' do
      result = shared(
        Stub.new('A', Set['BL_ORD_ID:0', 'I']),
        Stub.new('B', Set['BL_ORD_ID:0', 'I'])
      )

      expect(result[:count]).to eq(1)
      expect(result[:examples]).to eq(['I'])
    end

    it 'gives up rather than half-answer when an index cannot be read' do
      # Naming two colliding databases while silently ignoring a third would
      # be worse than saying nothing.
      expect(shared(
        Stub.new('A', Set['1']),
        Stub.new('B', nil),
        Stub.new('C', Set['1'])
      )).to be_nil
    end

    it 'does not report a database as colliding with itself' do
      expect(shared(Stub.new('A', Set['1']), Stub.new('A', Set['1']))).to be_nil
    end

    it 'skips the check entirely past the database limit' do
      many = (1..(BLAST::Report::SHARED_ACCESSION_DATABASE_LIMIT + 1)).map do |i|
        Stub.new("db#{i}", Set['1'])
      end

      expect(shared(*many)).to be_nil
    end
  end
end
