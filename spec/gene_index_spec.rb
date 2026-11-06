# frozen_string_literal: true

require 'spec_helper'
require 'json'
require 'tmpdir'
require 'zlib'

# GeneIndex answers "which genes overlap this hit", from an index built once
# per Alliance release rather than from a tabix range request.
#
# The fixture is generated rather than committed, so the intervals that make
# each case interesting are visible here instead of inside a binary blob. Its
# shape matches what agr_blastdb_manager/src/build_gene_index.py writes.
module SequenceServer
  describe GeneIndex do
    # chrI deliberately holds a long gene that STARTS before several short
    # ones and ENDS after them. That is the case a forward scan or a plain
    # binary search on start gets wrong, and it is why the implementation
    # walks backwards bounded by the longest gene on the refName.
    FIXTURE = {
      'assembly' => 'Test_organism',
      'release' => '9.2.0',
      'source' => 'https://example.invalid/GFF_TEST.sorted.gff.gz',
      'counts' => { 'genes' => 7, 'with_curie' => 5 },
      'refs' => {
        'chrI' => [
          [100,  200,  'aaa-1', 'SGD:S000000001'],
          [150,  9_000, 'long-1', 'SGD:S000000002'],
          [300,  400,  'bbb-1', nil],
          [500,  600,  'ccc-1', 'SGD:S000000003'],
          [8_000, 8_100, 'ddd-1', 'SGD:S000000004']
        ],
        'chrII' => [
          [1_000, 2_000, 'eee-1', 'SGD:S000000005'],
          [3_000, 3_500, nil,     nil]
        ]
      }
    }.freeze

    let(:root) { @root }

    before(:all) do
      @root = Dir.mktmpdir('sequenceserver-gene-index')
      FileUtils.mkdir_p(File.join(@root, 'gene_index'))
      path = File.join(@root, 'gene_index', 'Test_organism.genes.json.gz')
      Zlib::GzipWriter.open(path) { |gz| gz.write(JSON.generate(FIXTURE)) }
    end

    after(:all) do
      FileUtils.remove_entry(@root) if @root && File.exist?(@root)
    end

    before { GeneIndex.clear_cache! }

    let(:index) { GeneIndex.for('Test_organism', root: root) }

    describe '.for' do
      it 'loads an assembly that has an index' do
        expect(index).to be_a(GeneIndex)
        expect(index.assembly).to eq('Test_organism')
        expect(index.release).to eq('9.2.0')
      end

      it 'answers nil for an assembly with no index, rather than raising' do
        # The normal case for seven of the fork's deployments: no Alliance
        # all_genes track, so no index, so no gene panel.
        expect(GeneIndex.for('Nonexistent_organism', root: root)).to be_nil
      end

      it 'answers nil for a blank assembly' do
        expect(GeneIndex.for(nil, root: root)).to be_nil
        expect(GeneIndex.for('', root: root)).to be_nil
      end

      it 'loads the file once and reuses it' do
        first = GeneIndex.for('Test_organism', root: root)
        expect(GeneIndex.for('Test_organism', root: root)).to be(first)
      end
    end

    describe '#ref_names and #covers?' do
      it 'reports only the refNames the index carries' do
        expect(index.ref_names).to contain_exactly('chrI', 'chrII')
        expect(index.covers?('chrI')).to be true
        # A scaffold the Alliance GFFs do not annotate. Measured on the real
        # data: 680 of human's 705 refNames and 1,845 of fly's 1,870 are in
        # this position, so it is the common case rather than an edge.
        expect(index.covers?('NT_113793.3')).to be false
      end
    end

    describe '#gene_count' do
      it 'reports what the builder counted' do
        expect(index.gene_count).to eq(7)
      end
    end

    describe '#overlapping' do
      it 'finds every gene containing the span, long one included' do
        # long-1 spans 150..9000, so it covers this and most of chrI. Any span
        # inside it must report it, and an expectation that names only the
        # short gene is the mistake this fixture exists to catch.
        genes = index.overlapping('chrI', 520, 560)
        expect(genes.map { |g| g[:name] }).to eq(%w[long-1 ccc-1])
        expect(genes.map { |g| g[:curie] })
          .to eq(['SGD:S000000002', 'SGD:S000000003'])
      end

      it 'finds every gene the span touches' do
        genes = index.overlapping('chrI', 180, 320)
        expect(genes.map { |g| g[:name] }).to contain_exactly('aaa-1', 'long-1', 'bbb-1')
      end

      # The case the implementation is shaped around: a gene that starts far
      # before the query and still covers it.
      it 'finds a long gene whose start is far behind the query' do
        genes = index.overlapping('chrI', 8_050, 8_060)
        expect(genes.map { |g| g[:name] }).to contain_exactly('long-1', 'ddd-1')
      end

      it 'answers nearest-first from the span midpoint' do
        # Midpoint 8055 sits inside both, so both are distance 0 and the tie
        # breaks on start: long-1 at 150 before ddd-1 at 8000.
        expect(index.overlapping('chrI', 8_050, 8_060).first[:name]).to eq('long-1')
      end

      it 'returns nothing for a span with no genes' do
        expect(index.overlapping('chrI', 9_500, 9_600)).to eq([])
      end

      it 'returns nothing for a refName it does not cover' do
        expect(index.overlapping('NT_113793.3', 1, 1_000)).to eq([])
      end

      it 'treats coordinates as inclusive on both ends' do
        # 200 is aaa-1's last base and 100 its first.
        expect(index.overlapping('chrI', 200, 200).map { |g| g[:name] }).to include('aaa-1')
        expect(index.overlapping('chrI', 100, 100).map { |g| g[:name] }).to include('aaa-1')
        expect(index.overlapping('chrI', 201, 299).map { |g| g[:name] }).not_to include('aaa-1')
      end

      it 'accepts a reversed span, as a minus-strand HSP gives' do
        expect(index.overlapping('chrI', 560, 520).map { |g| g[:name] })
          .to eq(index.overlapping('chrI', 520, 560).map { |g| g[:name] })
      end

      it 'honours the limit' do
        expect(index.overlapping('chrI', 1, 9_000, limit: 2).size).to eq(2)
      end

      # Zebrafish carries a curie on 45.8% of its gene rows and Xenopus laevis
      # on 63.0%, so a nil curie is ordinary. It has to come back as a gene
      # with no orthologue link rather than be dropped.
      it 'keeps a gene that has no usable curie' do
        genes = index.overlapping('chrI', 350, 360)
        bbb = genes.find { |g| g[:name] == 'bbb-1' }
        expect(bbb).not_to be_nil
        expect(bbb[:curie]).to be_nil
        # And the gene beside it keeps its curie, so a nil is per-gene rather
        # than a whole-query failure.
        expect(genes.find { |g| g[:name] == 'long-1' }[:curie])
          .to eq('SGD:S000000002')
      end

      it 'keeps a gene that has no name either' do
        gene = index.overlapping('chrII', 3_100, 3_200).first
        expect(gene[:name]).to be_nil
        expect(gene[:curie]).to be_nil
      end
    end
  end
end
