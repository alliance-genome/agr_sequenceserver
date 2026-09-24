// Playwright configuration for the AGR SequenceServer browser regression suite.
//
// This is a SEPARATE test runner from jest. `npm test` still runs jest against
// public/js/**; `npm run test:e2e` runs these browser specs.
//
// IMPORTANT: these specs run against the deployed dev site, NOT localhost.
// The dev container is configured with HTTPS=on, so views/layout.erb emits
// absolute https:// asset URLs. Hitting http://localhost:4569 makes the page
// reference https://localhost:4569/blast/css/app.min.css, which nothing serves
// -- the browser loads zero CSS and zero JS, React never boots, and every UI
// assertion fails for reasons unrelated to the code. Always use the public
// proxy, which serves matching absolute URLs over a valid certificate.
//
// There is no bundled Chromium on this box (browser download is skipped);
// we drive the system Google Chrome at /usr/bin/google-chrome instead.

const { defineConfig } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || 'https://blast-dev.alliancegenome.org';
const CHROME_PATH = process.env.E2E_CHROME_PATH || '/usr/bin/google-chrome';

module.exports = defineConfig({
    testDir: './test/e2e',
    testMatch: '**/*.spec.js',

    // A BLAST search takes 10-20s; page loads on dev are not instant either.
    timeout: 120 * 1000,
    expect: { timeout: 30 * 1000 },

    // Never let a stray .only land in CI.
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,

    // Dev is a single shared container running real BLAST jobs. Keep the
    // concurrency low so specs do not starve each other of workers.
    workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
    fullyParallel: false,

    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

    use: {
        baseURL: BASE_URL,
        headless: true,
        viewport: { width: 1440, height: 900 },
        actionTimeout: 30 * 1000,
        navigationTimeout: 60 * 1000,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
        launchOptions: {
            executablePath: CHROME_PATH,
            args: [
                // Headless EC2: no display, no sandbox namespace.
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        }
    },

    projects: [
        {
            name: 'chrome',
            use: { browserName: 'chromium' }
        }
    ],

    outputDir: './test/e2e/.artifacts'
});
