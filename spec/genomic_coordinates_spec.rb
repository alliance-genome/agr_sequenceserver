require 'spec_helper'

# Translating a hit's subject coordinates onto the chromosome.
#
# For a genome assembly the two are already the same thing. For a feature
# database -- SGD's ORF and RNA sets -- the subject is one gene and an HSP's
# sstart/send are offsets into that gene, so passing them through unchanged
# sends the browser to the start of the chromosome.
#
# Every defline here was read off the deployed R64-5-1m databases.
module SequenceServer
  describe Links do
    def hsp(sstart, send)
      { 'sstart' => sstart, 'send' => send }
    end

    # Real deflines.
    FORWARD  = 'YAL069W SGDID:S000002143, Chr I from 335-649, Genome Release 64-3-1'.freeze
    REVERSE  = 'PAU8 SGDID:S000002142, Chr I from 2169-1807, Genome Release 64-3-1, reverse complement'.freeze
    SPLICED  = 'TRN1 SGDID:S000006680, Chr I from 139152-139187,139219-139254, tRNA_gene'.freeze
    ACT1     = 'ACT1 SGDID:S000001855, Chr VI from 54377-53260,54696-54687, Genome Release 64-3-1'.freeze
    MITO     = 'Q0010 SGDID:S000007257, Chr Mito from 3952-4338, Genome Release 64-3-1'.freeze
    INTERGEN = 'Chr I from 802-1806, Genome Release 64-3-1, between TEL01L and YAL068C'.freeze
    ASSEMBLY = '[org=Saccharomyces cerevisiae] [strain=S288C] [moltype=genomic] [chromosome=VI]'.freeze

    describe '.defline_feature_ranges' do
      it 'reads a single forward range' do
        expect(Links.defline_feature_ranges(FORWARD)).to eq [[335, 649]]
      end

      # Kept descending on purpose: the order carries the strand.
      it 'keeps a reverse range descending' do
        expect(Links.defline_feature_ranges(REVERSE)).to eq [[2169, 1807]]
      end

      it 'reads every range of a spliced feature' do
        expect(Links.defline_feature_ranges(SPLICED)).to eq [[139_152, 139_187], [139_219, 139_254]]
      end

      it 'reads a mitochondrial feature' do
        expect(Links.defline_feature_ranges(MITO)).to eq [[3952, 4338]]
      end

      it 'reads an intergenic region, which names no gene' do
        expect(Links.defline_feature_ranges(INTERGEN)).to eq [[802, 1806]]
      end

      it 'finds no ranges in an assembly defline' do
        expect(Links.defline_feature_ranges(ASSEMBLY)).to be_nil
        expect(Links.defline_feature_ranges('')).to be_nil
        expect(Links.defline_feature_ranges(nil)).to be_nil
      end
    end

    describe '.genomic_hsp_spans' do
      context 'a genome assembly, where the subject is the chromosome' do
        it 'passes the coordinates through' do
          expect(Links.genomic_hsp_spans(ASSEMBLY, [hsp(53_088, 55_378)])).to eq [[53_088, 55_378]]
        end

        it 'still normalises a descending HSP' do
          expect(Links.genomic_hsp_spans(ASSEMBLY, [hsp(55_378, 53_088)])).to eq [[53_088, 55_378]]
        end
      end

      context 'a forward-strand feature' do
        it 'maps an HSP covering the whole feature back onto it' do
          expect(Links.genomic_hsp_spans(FORWARD, [hsp(1, 315)])).to eq [[335, 649]]
        end

        it 'maps an interior HSP' do
          expect(Links.genomic_hsp_spans(FORWARD, [hsp(11, 20)])).to eq [[345, 354]]
        end
      end

      # The case worth being careful about: offset 1 of the subject is the
      # HIGHEST coordinate, so offsets run back down the chromosome and the
      # start/end of the span swap over. Verified against a live search: the
      # first 120 bp of the PAU8 CDS highlights chrI:2050..2169.
      context 'a reverse-strand feature' do
        it 'maps an HSP covering the whole feature back onto it' do
          expect(Links.genomic_hsp_spans(REVERSE, [hsp(1, 363)])).to eq [[1807, 2169]]
        end

        it 'maps the start of the subject to the end of the range' do
          expect(Links.genomic_hsp_spans(REVERSE, [hsp(1, 120)])).to eq [[2050, 2169]]
        end

        it 'gives the same answer for a descending HSP' do
          expect(Links.genomic_hsp_spans(REVERSE, [hsp(120, 1)])).to eq [[2050, 2169]]
        end
      end

      # An offset into a spliced product does not map linearly onto the genome,
      # so the whole feature is used rather than a position that would be
      # confidently wrong.
      context 'a spliced feature' do
        it 'falls back to the feature span' do
          expect(Links.genomic_hsp_spans(SPLICED, [hsp(1, 20)])).to eq [[139_152, 139_254]]
        end

        # ACT1 is what the shipped SGD example searches, and its ranges are not
        # in transcription order -- it is on the reverse strand, so its first
        # exon is the one at the higher coordinates, listed second.
        it 'spans the whole of ACT1 regardless of range order' do
          expect(Links.genomic_hsp_spans(ACT1, [hsp(1, 300)])).to eq [[53_260, 54_696]]
        end
      end

      it 'maps every HSP, not only the first' do
        expect(Links.genomic_hsp_spans(FORWARD, [hsp(1, 10), hsp(101, 110)]))
          .to eq [[335, 344], [435, 444]]
      end
    end

    describe '.extract_sgd_chromosome on a feature defline' do
      it 'reads the abbreviated "Chr I from" form' do
        expect(Links.extract_sgd_chromosome(FORWARD, 'YAL069W')).to eq 'chrI'
        expect(Links.extract_sgd_chromosome(ACT1, 'ACT1')).to eq 'chrVI'
      end

      it 'reads a mitochondrial feature' do
        expect(Links.extract_sgd_chromosome(MITO, 'Q0010')).to eq 'chrmt'
      end

      it 'reads an intergenic region' do
        expect(Links.extract_sgd_chromosome(INTERGEN, 'x')).to eq 'chrI'
      end

      # The two assembly styles must keep working; this method served only them
      # before.
      it 'still reads the SGD assembly style' do
        expect(Links.extract_sgd_chromosome(ASSEMBLY, 'NC_001138')).to eq 'chrVI'
      end

      it 'still reads the NCBI assembly style' do
        expect(Links.extract_sgd_chromosome('Saccharomyces cerevisiae S288C chromosome I, complete sequence', 'x'))
          .to eq 'chrI'
      end
    end
  end
end
