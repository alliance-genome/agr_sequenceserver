require 'spec_helper'

# The TSV side of a report is joined to the XML side by POSITION, not by
# subject id.
#
# It used to be keyed {qseqid => {sseqid => ...}}, which assumes a subject id
# identifies a hit. That holds on a single-database search and fails the moment
# one spans several: human, mouse, rat and zebrafish all name a chromosome "1".
# Measured on a nine-genome tblastn against /blast/ALLIANCE/prod/ -- 131 hits,
# 21 subject ids claimed by more than one hit, 53 hits displaying another hit's
# per-HSP coverage.
module SequenceServer
  RSpec.describe BLAST::Report do
    # parse_tsv is private; exercised through send, because what it returns is
    # the contract query_hits depends on.
    def parse(tsv)
      BLAST::Report.allocate.send(:parse_tsv, tsv)
    end

    it 'keeps two hits that share a subject id' do
      # Two hits both called "1" -- one from human, one from mouse -- with two
      # HSPs each. Under the old hash key these collapsed into one entry.
      tsv = <<~TSV
        Query_1\t1\tHomo sapiens\t90\t80
        Query_1\t1\tHomo sapiens\t90\t70
        Query_1\t1\tMus musculus\t40\t30
        Query_1\t1\tMus musculus\t40\t20
      TSV

      rows = parse(tsv)['Query_1']

      expect(rows.length).to eq(4)
      expect(rows.map { |r| r[0] }).to eq(
        ['Homo sapiens', 'Homo sapiens', 'Mus musculus', 'Mus musculus']
      )
      # Each HSP keeps its own coverage, in order.
      expect(rows.map { |r| r[2] }).to eq(%w[80 70 30 20])
    end

    it 'does not let the first hit of a colliding id speak for the rest' do
      tsv = "Query_1\t1\tHomo sapiens\t90\t80\nQuery_1\t1\tMus musculus\t40\t30\n"
      rows = parse(tsv)['Query_1']

      # The old shape returned ['Homo sapiens', '90', ['80','30']] for BOTH
      # hits: first-wins on sciname and qcovs, and one shared qcovhsp array
      # that `hsps` then indexed positionally.
      expect(rows[1][0]).to eq('Mus musculus')
      expect(rows[1][1]).to eq('40')
    end

    it 'keeps queries apart' do
      tsv = "Query_1\t1\tA\t10\t11\nQuery_2\t1\tB\t20\t21\n"
      ir = parse(tsv)

      expect(ir['Query_1'].map { |r| r[0] }).to eq(['A'])
      expect(ir['Query_2'].map { |r| r[0] }).to eq(['B'])
    end

    it 'ignores comment lines and yields nothing for an unseen query' do
      ir = parse("# TBLASTN 2.15.0+\n# Query: x\nQuery_1\t1\tA\t10\t11\n")

      expect(ir['Query_1'].length).to eq(1)
      expect(ir['nosuchquery']).to eq([])
    end

    it 'preserves row order, which is what the positional join relies on' do
      tsv = (1..5).map { |i| "Query_1\tchr#{i}\tOrg\t#{i}0\t#{i}1" }.join("\n") + "\n"

      expect(parse(tsv)['Query_1'].map { |r| r[2] }).to eq(%w[11 21 31 41 51])
    end
  end
end
