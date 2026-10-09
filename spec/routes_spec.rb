require 'spec_helper'

require 'rack/test'

# Basic unit tests for HTTP / Rack interface.
module SequenceServer
  RSpec.describe 'Routes' do
    ENV['RACK_ENV'] = 'test'
    include Rack::Test::Methods

    # This fork serves everything under /blast/<mod>/<version>/ (6e969b2c,
    # November 2023). The bare "/" and "/get_sequence" these specs used to post
    # to have not existed since, so all twelve of them had been failing on a
    # 404 for two years.
    #
    # The MOD and version are not free-form: a route turns them into
    # <database_dir>/<mod>/<version>/databases and 404s unless that is a
    # directory. spec/mods/TEST/v5/databases is a symlink to the v5 sample set,
    # so the fixtures are not duplicated.
    #
    # It lives in spec/mods rather than under spec/database because job_spec
    # scans the whole of spec/database and then picks databases by position --
    # Database.ids[17] and friends. A symlink inside that tree makes the sample
    # set appear twice, shifts every index, and silently changes what those
    # specs are asserting about.
    ROUTE = '/blast/TEST/v5'

    before do
      SequenceServer.init(database_dir: "#{__dir__}/mods")
    end

    let 'app' do
      SequenceServer
    end

    context "POST #{ROUTE}" do
      before :each do
        get "#{ROUTE}/" # make a request so we have an env with CSRF token
        @params = {
          'sequence'  => 'AGCTAGCTAGCT',
          'databases' => [Database.first.id],
          'method'    => (Database.first.type == 'protein' ? 'blastp' : 'blastn'),
          '_csrf'     => Rack::Csrf.token(last_request.env)
        }
      end

      it 'returns Bad Request (400) if no blast method is provided' do
        @params.delete('method')
        post ROUTE, @params
        last_response.status.should == 400
      end

      it 'returns Bad Request (400) if no input sequence is provided' do
        @params.delete('sequence')
        post ROUTE, @params
        last_response.status.should == 400
      end

      it 'returns Bad Request (400) if no database id is provided' do
        @params.delete('databases')
        post ROUTE, @params
        last_response.status.should == 400
      end

      it 'returns Bad Request (400) if an empty database list is provided' do
        @params['databases'].pop

        # ensure the list of databases is empty
        @params['databases'].should be_empty

        post ROUTE, @params
        last_response.status.should == 400
      end

      it 'returns Bad Request (400) if incorrect database id is provided' do
        @params['databases'] = ['123']
        post ROUTE, @params
        last_response.status.should == 400
      end

      it 'returns Bad Request (400) if an incorrect blast method is supplied' do
        @params['method'] = 'foo'
        post ROUTE, @params
        last_response.status.should == 400
      end

      it 'returns Bad Request (400) if incorrect advanced params are supplied' do
        @params['advanced'] = '-word_size 5; rm -rf /'
        post ROUTE, @params
        last_response.status.should == 400
      end

      it 'redirects to /:jobid (302) when correct method, sequence, and database ids are'\
        'provided but no advanced params' do
        post ROUTE, @params
        last_response.should be_redirect
        last_response.status.should eq 302

        @params['advanced'] = '  '
        post ROUTE, @params
        last_response.should be_redirect
        last_response.status.should == 302
      end

      it 'redirects to /jobid (302) when correct method, sequence, and database ids and'\
        'advanced params are provided' do
        @params['advanced'] = '-evalue 1'
        post ROUTE, @params
        last_response.should be_redirect
        last_response.status.should == 302
      end
    end

    context "POST #{ROUTE}/get_sequence" do
      before :each do
        get "#{ROUTE}/" # make a request so we have an env with CSRF token
        @csrf_token = Rack::Csrf.token(last_request.env)
      end

      let(:job) do
        SequenceServer::BLAST::Job.new(
          sequence: ">test\nACGT",
          databases: [SequenceServer::Database.ids[1]],
          method: 'blastp'
        )
      end

      it 'returns 422 if no sequence_ids are provided' do
        post "#{ROUTE}/get_sequence", {
          '_csrf' => @csrf_token,
          'sequence_ids' => "",
          'database_ids' => Database.first.id.to_s
        }

        expect(last_response.status).to eq(422)
        expect(last_response.body).to include('No sequence ids provided')
      end

      it 'returns 422 if no database_ids are provided' do
        post "#{ROUTE}/get_sequence", {
          '_csrf' => @csrf_token,
          'sequence_ids' => "contig1",
          'database_ids' => ""
        }

        expect(last_response.status).to eq(422)
        expect(last_response.body).to include('No database ids provided')
      end

      it 'does not allow invalid sequence ids' do
        post "#{ROUTE}/get_sequence", {
          '_csrf' => @csrf_token,
          'sequence_ids' => "invalid_sequence_id';sleep 30;",
          'database_ids' => Database.first.id.to_s
        }

        expect(last_response.status).to eq(422)
        expect(last_response.body).to include('Invalid sequence id(s): invalid_sequence_id')
      end
    end
  end
end
