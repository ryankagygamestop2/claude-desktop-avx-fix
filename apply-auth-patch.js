#!/usr/bin/env node
/**
 * Patches cli.js to handle token refresh on 401 auth failures.
 *
 * The issue: v2.1.112+ doesn't refresh tokens when the API rejects them with 401.
 * The fix: Inject a fetch wrapper that intercepts 401 errors and refreshes the token.
 */

import fs from "fs";
import path from "path";
import os from "os";

const cliPath = process.argv[2];

if (!cliPath || !fs.existsSync(cliPath)) {
  console.error(`Usage: node apply-auth-patch.js <path-to-cli.js>`);
  process.exit(1);
}

const PATCH_CODE = `
// ============================================================================
// AUTH TOKEN REFRESH PATCH - Anthropic Claude Code v2.1.112+
// Fixes: API Error 401 "Invalid authentication credentials" on token expiry
// ============================================================================

const __claudeAuthPatch = (() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
  let tokenRefreshInProgress = null;

  async function readCredentials() {
    try {
      if (!fs.existsSync(CREDS_FILE)) return null;
      const data = fs.readFileSync(CREDS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }

  async function writeCredentials(creds) {
    try {
      const dir = path.dirname(CREDS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
      return true;
    } catch (e) {
      console.error('[claude-auth] Failed to write credentials:', e.message);
      return false;
    }
  }

  async function refreshToken() {
    // Prevent concurrent refresh attempts
    if (tokenRefreshInProgress) return tokenRefreshInProgress;

    tokenRefreshInProgress = (async () => {
      try {
        const creds = await readCredentials();
        if (!creds?.claudeAiOauth?.refreshToken) {
          console.error('[claude-auth] No refresh token available');
          return null;
        }

        console.error('[claude-auth] Attempting token refresh...');

        // Use the original fetch before our wrapper
        const fetchImpl = typeof globalThis !== 'undefined'
          ? globalThis.__originalFetch
          : global.__originalFetch;

        if (!fetchImpl) {
          console.error('[claude-auth] Original fetch not available');
          return null;
        }

        const response = await fetchImpl('https://api.anthropic.com/v1/auth/refresh', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': \`Bearer \${creds.claudeAiOauth.refreshToken}\`,
          },
          body: JSON.stringify({ refreshToken: creds.claudeAiOauth.refreshToken }),
        });

        if (!response.ok) {
          console.error('[claude-auth] Token refresh failed:', response.status, response.statusText);
          return null;
        }

        const data = await response.json();
        const newAccessToken = data.accessToken || data.access_token;

        if (!newAccessToken) {
          console.error('[claude-auth] No access token in refresh response');
          return null;
        }

        // Update credentials
        creds.claudeAiOauth.accessToken = newAccessToken;
        if (data.expiresIn) {
          creds.claudeAiOauth.expiresAt = Date.now() + (data.expiresIn * 1000);
        } else if (data.expires_in) {
          creds.claudeAiOauth.expiresAt = Date.now() + (data.expires_in * 1000);
        }

        const written = await writeCredentials(creds);
        if (written) {
          console.error('[claude-auth] ✓ Token refreshed successfully');
          return newAccessToken;
        }
      } catch (error) {
        console.error('[claude-auth] Error during refresh:', error.message);
      }
      return null;
    })();

    return tokenRefreshInProgress;
  }

  // Wrap the global fetch to handle 401 errors
  const originalFetch = typeof globalThis !== 'undefined'
    ? globalThis.fetch
    : global.fetch;

  if (originalFetch) {
    if (typeof globalThis !== 'undefined') {
      globalThis.__originalFetch = originalFetch;
      globalThis.fetch = async function claudeAuthFetch(url, options) {
        let response = await originalFetch(url, options);

        // If 401, try token refresh and retry once
        if (response.status === 401) {
          console.error('[claude-auth] Received 401, attempting token refresh...');
          const newToken = await refreshToken();

          if (newToken && options?.headers) {
            // Retry with new token
            const retryOptions = JSON.parse(JSON.stringify(options));
            retryOptions.headers = { ...retryOptions.headers };
            retryOptions.headers['Authorization'] = \`Bearer \${newToken}\`;

            console.error('[claude-auth] Retrying with refreshed token...');
            response = await originalFetch(url, retryOptions);

            if (response.ok) {
              console.error('[claude-auth] ✓ Retry successful');
            }
          }
        }

        return response;
      };
    } else {
      global.__originalFetch = originalFetch;
      global.fetch = async function claudeAuthFetch(url, options) {
        let response = await originalFetch(url, options);

        if (response.status === 401) {
          console.error('[claude-auth] Received 401, attempting token refresh...');
          const newToken = await refreshToken();

          if (newToken && options?.headers) {
            const retryOptions = JSON.parse(JSON.stringify(options));
            retryOptions.headers = { ...retryOptions.headers };
            retryOptions.headers['Authorization'] = \`Bearer \${newToken}\`;

            console.error('[claude-auth] Retrying with refreshed token...');
            response = await originalFetch(url, retryOptions);

            if (response.ok) {
              console.error('[claude-auth] ✓ Retry successful');
            }
          }
        }

        return response;
      };
    }
  }

  return { refreshToken, readCredentials };
})();

// Make it available globally
if (typeof globalThis !== 'undefined') {
  globalThis.__claudeAuthPatch = __claudeAuthPatch;
} else {
  global.__claudeAuthPatch = __claudeAuthPatch;
}

`;

try {
  let code = fs.readFileSync(cliPath, "utf-8");

  // Check if already patched
  if (code.includes("AUTH TOKEN REFRESH PATCH")) {
    console.log("✓ Patch already applied to this version");
    process.exit(0);
  }

  // Find the shebang line and inject after it
  const lines = code.split("\n");
  let insertIndex = 0;

  if (lines[0].startsWith("#!")) {
    // Keep the shebang, insert after it
    insertIndex = 1;
  }

  // Insert the patch code
  lines.splice(insertIndex, 0, PATCH_CODE);
  const patchedCode = lines.join("\n");

  // Write the patched version
  fs.writeFileSync(cliPath, patchedCode);

  console.log("✓ Auth patch successfully applied");
  console.log("  - Patches fetch to intercept 401 errors");
  console.log("  - Automatically refreshes tokens using refreshToken");
  console.log("  - Retries failed requests with new token");
} catch (error) {
  console.error("✗ Failed to apply patch:", error.message);
  process.exit(1);
}
