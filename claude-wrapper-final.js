#!/usr/bin/env node
/**
 * Runtime wrapper for Claude Code v2.1.112 on pre-AVX2 Macs
 *
 * This wrapper:
 * 1. Intercepts fetch() calls before cli.js loads
 * 2. Injects Authorization header (v2.1.112 fails to send it for messages API)
 * 3. Injects anthropic-version header (required by current API)
 * 4. Re-reads credentials on each request in case they're updated by /login
 *
 * Status: Partially working
 * - Authorization header injection works
 * - anthropic-version header is added
 * - But API still returns 401 "Invalid authentication credentials"
 *
 * Root cause: v2.1.112 is incompatible with current Anthropic API token validation
 * The token format or validation logic changed, making v2.1.112's tokens invalid.
 */

(async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');

  function getToken() {
    try {
      if (!fs.existsSync(credsPath)) return null;
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      return creds.claudeAiOauth?.accessToken;
    } catch (e) {
      return null;
    }
  }

  // Patch fetch globally to inject required headers
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    if (!options) options = {};
    if (!options.headers) options.headers = {};

    // Re-read token on every request (in case /login was just called)
    const token = getToken();

    // For Anthropic API calls, ensure required headers are present
    if (url.includes('api.anthropic.com')) {
      // v2.1.112 doesn't send Authorization header for some endpoints
      if (!options.headers.Authorization && token) {
        options.headers.Authorization = `Bearer ${token}`;
      }

      // anthropic-version header is required by current API but v2.1.112 doesn't send it
      if (!options.headers['anthropic-version']) {
        options.headers['anthropic-version'] = '2025-04-14';
      }
    }

    return origFetch(url, options);
  };

  // Load cli.js as ES module
  await import('/Users/admin/.nvm/versions/node/v24.14.0/lib/node_modules/@anthropic-ai/claude-code/cli.js');
})();
