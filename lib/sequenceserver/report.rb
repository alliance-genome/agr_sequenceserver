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

    # `env_config` is the "data" array of the MOD/release environment.json,
    # used to attach genome-browser links. It defaults to empty because that is
    # already a supported state: routes.rb passes [] when no environment.json
    # exists for the release. Defaulting it also keeps the specs working --
    # they construct reports directly, and were never updated when this fork
    # added the argument, which is why `bundle exec rspec` could not run.
    def initialize(job, env_config = [])
      @job = job
      @env_config = env_config
      yield if block_given?
    end

    attr_reader :job
  end
end
