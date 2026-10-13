require 'simplecov'
require 'capybara/rspec'
require 'selenium-webdriver'
require 'capybara-screenshot/rspec'

Dir[File.expand_path('spec/support/**/*.rb')].sort.each { |file| require file }

# Start SimpleCov.
SimpleCov.start

# Load SequenceServer in testing mode.
ENV['RACK_ENV'] = 'test'
require 'sequenceserver'

# For the purpose of testing, set DOTDIR to spec/dotdir.
SequenceServer::DOTDIR = File.join(__dir__, 'dotdir')

# The shape SecureRandom.uuid produces, which is what Job#initialize assigns.
JOB_UUID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/.freeze

Capybara.app = SequenceServer
Capybara.server = :webrick
Capybara.default_max_wait_time = 15

chrome_options = Selenium::WebDriver::Chrome::Options.new
chrome_options.add_preference('download.default_directory', DownloadHelpers::DOWNLOADS_DIR)
chrome_options.add_preference('profile.default_content_setting_values.automatic_downloads', 1)
chrome_options.add_argument('--window-size=1920,1200')

Capybara.register_driver :chrome do |app|
  Capybara::Selenium::Driver.new(
    app,
    browser: :chrome,
    options: chrome_options
  )
end

Capybara.register_driver :headless_chrome do |app|
  options = chrome_options.dup
  options.add_argument('--headless')

  Capybara::Selenium::Driver.new(
    app,
    browser: :chrome,
    options: options
  )
end

Capybara.default_driver = ENV['BROWSER_DEBUG'] ? :chrome : :headless_chrome
Capybara.javascript_driver = ENV['BROWSER_DEBUG'] ? :chrome : :headless_chrome

Capybara::Screenshot.instance_variable_set :@capybara_root, File.join(__dir__, 'tmp')
Capybara::Screenshot.register_driver :headless_chrome do |driver, path|
  driver.browser.save_screenshot(path)
end

RSpec.configure do |config|
  # Explicitly enable should syntax of rspec.
  config.expect_with :rspec do |expectations|
    expectations.syntax = %i[should expect]
  end

  # To use url_encode function in import_spec.
  config.include ERB::Util, type: :feature

  # For file downloading.
  config.include DownloadHelpers, type: :feature

  # Setup capybara tests.
  config.before :context, type: :feature do |_context|
    FileUtils.mkdir_p DownloadHelpers::DOWNLOADS_DIR
  end

  config.after :example, type: :feature do
    clear_downloads
  end

  config.after :context do
    SequenceServer::Database.clear

    # Delete the jobs the run just created, which this hook used to miss.
    #
    # It was scoped `type: :feature`, and the specs that call Job.create are
    # job_spec and routes_spec, neither of which is a feature spec, so nothing
    # ever cleaned up after them. 145 job directories had collected in
    # spec/dotdir by the time anyone counted, none of them tracked.
    #
    # Anchored on the uuid shape Job#initialize generates, so the ten fixture
    # directories beside them -- blast_2.2.30 through blast_2.9.0 and
    # diamond_0.9.24, which are tracked and are what 214 of the suite's
    # examples read -- cannot match it.
    Dir[File.join(SequenceServer::DOTDIR, '*')].each do |path|
      next unless File.basename(path).match?(JOB_UUID)

      FileUtils.rm_rf path
    end
  end
end
