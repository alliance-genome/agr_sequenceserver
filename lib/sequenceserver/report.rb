require 'forwardable'

module SequenceServer
  # Create report for the given job.
  #
  # Report is a generic superclass. Programs, like BLAST, must implement their
  # own report subclass.
  class Report
    # Provide access to global `config` & `logger` services to the report
    # objects.
    extend Forwardable
    def_delegators SequenceServer, :config, :logger

    def initialize(job, env_config)
      @job = job
      @env_config = env_config
      yield if block_given?
    end

    attr_reader :job
  end
end
