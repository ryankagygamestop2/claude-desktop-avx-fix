#!/usr/bin/env node
/**
 * Patches cli.js to handle token refresh on 401 auth failures.
 *
 * The issue: v2.1.112+ doesn't refresh tokens when the API rejects them with 401.
 * The fix: Inject a fetch wrapper that intercepts 401 errors and refreshes the token.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

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

(async () => {
  try {
    // Dynamic imports for ES module compatibility
    const fs = (await import('fs/promises')).default || (await import('fs'));
    const fsSync = require('fs');
    const path = (await import('path')).default || (await import('path'));
    const os = (await import('os')).default || (await import('os'));

    const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
    let tokenRefreshInProgress = null;

    async function readCredentials() {
      try {
        const data = await fs.readFile(CREDS_FILE, 'utf-8');
        return JSON.parse(data);
      } catch (e) {
        return null;
      }
    }

    async function writeCredentials(creds) {
      try {
        await fs.writeFile(CREDS_FILE, JSON.stringify(creds, null, 2));
        return true;
      } catch (e) {
        console.error('[claude-auth] Failed to write credentials:', e.message);
        return false;
      }
    }

    async function refreshToken() {
      if (tokenRefreshInProgress) return await tokenRefreshInProgress;

      tokenRefreshInProgress = (async () => {
        try {
          const creds = await readCredentials();
          if (!creds?.claudeAiOauth?.refreshToken) {
            return null;
          }

          console.error('[claude-auth] Refreshing token...');

          const origFetch = globalThis.__origFetch;
          if (!origFetch) return null;

          const response = await origFetch('https://api.anthropic.com/v1/auth/refresh', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': \`Bearer \${creds.claudeAiOauth.refreshToken}\`,
            },
            body: JSON.stringify({ refreshToken: creds.claudeAiOauth.refreshToken }),
          });

          if (!response.ok) return null;

          const data = await response.json();
          const newToken = data.accessToken || data.access_token;

          if (!newToken) return null;

          creds.claudeAiOauth.accessToken = newToken;
          if (data.expiresIn) {
            creds.claudeAiOauth.expiresAt = Date.now() + data.expiresIn * 1000;
          }

          await writeCredentials(creds);
          console.error('[claude-auth] ✓ Token refreshed');
          return newToken;
        } catch (e) {
          console.error('[claude-auth] Refresh error:', e.message);
          return null;
        }
      })();

      return await tokenRefreshInProgress;
    }

    // Wrap fetch
    const origFetch = globalThis.fetch;
    globalThis.__origFetch = origFetch;
    globalThis.fetch = async (url, opts) => {
      let res = await origFetch(url, opts);

      if (res.status === 401) {
        const newToken = await refreshToken();
        if (newToken && opts?.headers) {
          opts.headers.Authorization = \`Bearer \${newToken}\`;
          res = await origFetch(url, opts);
        }
      }

      return res;
    };

    console.error('[claude-auth] Patch loaded');
  } catch (e) {
    console.error('[claude-auth] Patch error:', e.message);
  }
})();

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
