require 'spec_helper'
require 'tmpdir'
require 'sequenceserver/report'
require 'sequenceserver/blast/report'

module SequenceServer
  RSpec.describe BLAST::Job do
    before do
      FileUtils.mkdir_p(DOTDIR)
      FileUtils.rm_r(File.join(DOTDIR, job_id)) if File.exist?(File.join(DOTDIR, job_id))
      FileUtils.cp_r(File.join(__dir__, '..', 'fixtures', job_id), DOTDIR)

      # Every path in this fixture -- the BLAST archive in `stdout`, the
      # database names in `job.yaml`, the expected JSON -- was captured on a
      # checkout named "sequenceserver" and baked in as
      # "$PATH_PREFIX/sequenceserver/spec/...". Expanding $PATH_PREFIX to the
      # parent of the checkout, which is what this did, therefore only resolves
      # when the checkout is itself named "sequenceserver". This fork's is
      # "agr_sequenceserver", and CI checks out under the repository name too,
      # so every path pointed at a directory that does not exist and
      # blast_formatter died with "Fail to initialize local or remote DB" --
      # surfacing as a bare SystemError, since Formatter#run replaces the
      # stderr with a generic message.
      #
      # The baked-in segment cannot just be rewritten: the archive is ASN.1
      # text, which wraps long strings mid-token, and two of the 218
      # occurrences are split as "$PATH_PREFIX/sequencese" + newline +
      # "rver/...". So point the placeholder at a directory that really does
      # contain a "sequenceserver" entry, whatever this checkout is called.
      #
      # That directory has to sit outside the repository. Putting it under
      # spec/tmp made `rspec spec` walk back into the checkout through the
      # symlink and collect every spec a second time -- 749 examples instead of
      # 362, each failure reported twice.
      job_dir = File.join(DOTDIR, job_id)
      repo_dir = File.expand_path(File.join(__dir__, '..', '..'))
      root_dir = File.join(Dir.tmpdir, "sequenceserver-spec-#{Process.pid}")
      FileUtils.mkdir_p root_dir
      FileUtils.ln_sf repo_dir, File.join(root_dir, 'sequenceserver')
      Dir[File.join(job_dir, '**', '*')].each do |f|
        File.write(f, File.read(f).gsub('$PATH_PREFIX', root_dir)) if File.file?(f)
      end

      SequenceServer.init
    end

    let(:job_id) { '38334a72-e8e7-4732-872b-24d3f8723563' }
    let(:job) { SequenceServer::Job.fetch(job_id) }
    let(:report) { BLAST::Report.new(job) }
    # Strings, not symbols. These are compared against the keys of a
    # JSON.parse result, which are strings, so as symbols the list matched
    # nothing and all four keys were compared after all -- which is why this
    # spec broke on a version bump (seqserv_version 3.1.3 -> 3.1.4) that it was
    # written specifically to tolerate.
    let(:keys_to_ignore) { %w[querydb submitted_at imported_xml seqserv_version] }

    describe "#to_json" do
      it "returns a JSON representation of the job" do
        actual_report = JSON.parse(report.to_json).reject { |k, _| keys_to_ignore.include?(k) }
        expected_report = JSON.parse(File.read(File.join(job.dir, 'expected_outputs/frontend.json'))).reject { |k, _| keys_to_ignore.include?(k) }

        actual_report.each do |k, v|
          expect(v).to eq(expected_report[k])
        end
      end
    end
  end
end