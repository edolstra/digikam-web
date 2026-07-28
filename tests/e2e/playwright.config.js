// Playwright configuration for the digikam-web e2e suite.
//
// The webServer block seeds a synthetic fixture — the hidden --seed-fixture
// flag, the same data as the Rust API integration tests (src/fixture.rs) —
// into a fresh temp dir, then serves it with writes enabled. The server
// binary comes from $DIGIKAM_WEB_BIN (the flake's e2e check sets it to the
// built package; in the dev shell point it at target/debug/digikam-web), the
// port from $E2E_PORT (default 4621).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineConfig } = require('@playwright/test');

const port = process.env.E2E_PORT || 4621;
const bin = process.env.DIGIKAM_WEB_BIN || 'digikam-web';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digikam-e2e-'));

module.exports = defineConfig({
  testDir: __dirname,
  reporter: 'list', // no HTML report (which tries to auto-open a browser)
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // channel 'chromium': headless-run the full Chromium instead of the
    // separate "headless shell" build, which nixpkgs' browser bundle omits.
    channel: 'chromium',
    // Chromium's own sandbox can't be set up inside the Nix build sandbox,
    // and /dev/shm there is too small for the renderer.
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `'${bin}' --seed-fixture '${dir}' && exec '${bin}' --database '${dir}/digikam4.db' --allow-writes --listen 127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
  },
});
