require 'yaml'
require 'English'
require 'fileutils'
require 'digest/md5'
require 'forwardable'
require 'securerandom'

require 'sequenceserver/pool'
require 'sequenceserver/api_errors'

module SequenceServer
  # Abstract job super class.
  #
  # Provides a simple framework to store job data, execute shell commands
  # asynchronously and capture stdout, stderr and exit status. Subclasses
  # must provide a concrete implementation for `command` and may override
  # any other methods as required.
  #
  # Global `config` and `logger` object are available as instance methods.
  #
  # Singleton methods provide the facility to create and queue a job,
  # fetch a job or all jobs, and delete a job.
  class Job
    # Shape of an id this class issues: SecureRandom.uuid, and nothing else.
    #
    # A job id is a path segment -- `dir` is File.join(DOTDIR, id) -- so an id
    # that is not of this shape is a path traversal. Every id entering from a
    # request is checked against this before it reaches the filesystem.
    VALID_ID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/

    class << self
      # Creates and queues a job. Returns created job object.
      def create(params)
        job = BLAST::Job.new(params) # TODO: Dynamic dispatch.
        enqueue(job)
      end

      # True if `id` is one this class could have issued.
      #
      # Used to refuse a caller-supplied id outright rather than sanitise it:
      # the only ids that exist are the ones #initialize generates, so anything
      # else is either a bug or an attempt to escape DOTDIR.
      def valid_id?(id)
        id.is_a?(String) && id.match?(VALID_ID)
      end

      def serializable_classes
        [
          Time,
          Symbol,
          SequenceServer::Job,
          SequenceServer::BLAST::Job,
          SequenceServer::Database
        ]
      end

      # Fetches job with the given id.
      def fetch(id)
        # Every route reads :jid straight out of the URL, so this is the one
        # place that keeps a crafted id from being joined onto DOTDIR. A bad id
        # is "no such job", which is what callers already handle.
        return nil unless valid_id?(id)

        job_file = File.join(DOTDIR, id, 'job.yaml')
        return nil unless File.exist?(job_file)

        YAML.safe_load_file(
          job_file,
          permitted_classes: serializable_classes
        )
      end

      # Deletes job with the given id.
      def delete(id)
        return unless valid_id?(id)

        FileUtils.rm_r File.join(DOTDIR, id)
      end

      # Returns an Array of all jobs.
      def all
        Dir["#{DOTDIR}/**/job.yaml"]
          .map { |f| fetch File.basename File.dirname f }
      end

      # Enqueues a job that is already created, returns the job object
      def enqueue(job)
        pool.queue { job.run }
        job
      end

      private

      # Thread pool used for running BLAST searches.
      def pool
        @pool ||= Pool.new(SequenceServer.config[:num_jobs] || 1)
      end
    end

    include FileUtils

    # Provide access to global `config` & `logger` services to the job objects.
    extend Forwardable
    def_delegators SequenceServer, :config, :logger, :sys

    # Initialize the job: generates a job id, creates directory where all kind
    # of job data will be held, yields (if block given) and saves the job.
    #
    # Subclasses should extend `initialize` as per requirement.
    def initialize(params = {})
      # The id is never taken from `params`. It used to be
      # (`params.fetch(:id, SecureRandom.uuid)`), and `params` here is the
      # search form's request params passed through whole by routes.rb, while
      # Job.validate checks method, sequence, databases and options but not
      # :id. Since `dir` is File.join(DOTDIR, id), a submitted
      # `id=../../../../tmp/x` wrote the job -- query.fa included -- anywhere
      # the process could reach, as root in the container, and the rescue
      # below then made it an arbitrary delete. No caller has ever needed to
      # supply an id: Job.create is the only one, and ids restored from
      # job.yaml are rebuilt by YAML without going through initialize.
      @id = SecureRandom.uuid
      @submitted_at = Time.now
      mkdir_p dir
      yield if block_given?
      save
    rescue Errno::ENOSPC
      raise SystemError, 'Not enough disk space to start a new job'
    rescue Errno::EACCES
      raise SystemError, "Permission denied to write to #{DOTDIR}"
    rescue StandardError => e
      # Belt and braces. With the id generated above this can only ever be the
      # directory we just made, but this cleanup deletes recursively on any
      # unexpected error, so it refuses to step outside DOTDIR rather than
      # trusting that to stay true.
      rm_rf dir if File.expand_path(dir).start_with?("#{File.expand_path(DOTDIR)}/")
      raise e
    end

    attr_reader :id, :submitted_at, :completed_at, :exitstatus

    # Returns shell command that will be executed. Subclass needs to provide a
    # concrete implementation.
    def command
      fail 'Not implemented.'
    end

    # Shell out and execute the job.
    #
    # NOTE: This method is called asynchronously by thread pool.
    def run
      sys(command, path: config[:bin], stdout: stdout, stderr: stderr)
      done!
    rescue CommandFailed => e
      done! e.exitstatus
    end

    # Is exitstatus of the job available? If yes, it means the job is done.
    def done?
      !!@exitstatus
    end

    # Raise RuntimeError if job finished with non-zero exit status. This method
    # should be called on a completed job before attempting to use the results.
    # Subclasses should provide their own implementation.
    def raise!
      fail if done? && exitstatus != 0
    end

    # Where will the stdout be written to during execution and read from later.
    def stdout
      File.join(dir, 'stdout')
    end

    # Where will the stderr be written to during execution and read from later.
    def stderr
      File.join(dir, 'stderr')
    end

    # Where to save all kind of data for this job.
    def dir
      File.join(DOTDIR, id)
    end

    private

    # Saves job object to a YAML file in job directory.
    def save
      File.write(yfile, to_yaml)
    end

    # Save arbitrary blob of data for this job to a file. Returns absolute path
    # to the file. Doesn't mean the saved file will be linked to the job object
    # Downstream code must do that itself.
    #
    # NOTE:
    #   Job dir should have been created before `store` is called.  In a
    #   subclass this can be ensured by appropriately calling `super` in
    #   `initialize` method.
    def store(key, value)
      filename = File.join(dir, key)
      File.write(filename, value)
      filename
    end

    # Retrieve file from job dir with the given name. Raises RuntimeError if
    # the file can't be found.
    #
    # NOTE: Not used.
    def fetch(key)
      filename = File.join(dir, key)
      fail unless File.exist? filename

      filename
    end

    # Marks the job as done and save its exitstatus.
    def done!(status = 0)
      @completed_at = Time.now
      @exitstatus = status
      save
    end

    # Where to write serialised job object.
    def yfile
      File.join(dir, 'job.yaml')
    end
  end
end
