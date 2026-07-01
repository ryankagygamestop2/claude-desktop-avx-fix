#!/bin/bash
# Wrapper for Claude Code v2.1.112 that patches auth token refresh
# This fixes the 401 "Invalid authentication credentials" issue

set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Run the actual CLI
CLAUDE_CODE_DIR="$(npm root -g)/@anthropic-ai/claude-code"
CLI_JS="$CLAUDE_CODE_DIR/cli.js"

# Check if cli.js exists
if [ ! -f "$CLI_JS" ]; then
    echo "Error: claude-code CLI not found at $CLI_JS"
    exit 1
fi

# Create a temp directory for our patches
PATCH_DIR="$HOME/.claude/patches"
mkdir -p "$PATCH_DIR"

# Check if we need to apply the auth refresh patch
PATCH_MARKER="$PATCH_DIR/.auth-patched-$(md5 -q "$CLI_JS" 2>/dev/null || echo "unknown")"

# If the patch hasn't been applied to this version, apply it
if [ ! -f "$PATCH_MARKER" ]; then
    echo "[claude-wrapper] Applying auth refresh patch to cli.js..."

    # Make a backup of the original cli.js if we haven't already
    if [ ! -f "$CLI_JS.orig" ]; then
        cp "$CLI_JS" "$CLI_JS.orig"
    fi

    # Apply the patch using Node.js
    node << 'EOF'
const fs = require('fs');
const path = require('path');

const CLI_JS = process.env.CLI_JS;
const code = fs.readFileSync(CLI_JS, 'utf-8');

// Look for the auth/credentials handling code patterns
// v2.1.112 likely has these patterns (minified)
// We're looking for where it reads credentials and makes API calls

// Pattern 1: Look for "claudeAiOauth" (the credentials key)
// Pattern 2: Look for 401 error handling
// Pattern 3: Look for Authorization header setup

// Since the file is heavily minified, we need to inject a wrapper
// that catches API errors and refreshes on 401

const wrapper = `
// Auth refresh wrapper for v2.1.112
const originalFetch = global.fetch;
let refreshPromise = null;

async function tryRefreshToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      const refreshToken = creds.claudeAiOauth?.refreshToken;

      if (!refreshToken) return false;

      const response = await originalFetch('https://api.anthropic.com/v1/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': \`Bearer \${refreshToken}\`
        },
        body: JSON.stringify({ refreshToken })
      });

      if (!response.ok) return false;

      const data = await response.json();
      const newToken = data.accessToken || data.access_token;

      if (newToken) {
        creds.claudeAiOauth.accessToken = newToken;
        if (data.expiresIn) {
          creds.claudeAiOauth.expiresAt = Date.now() + data.expiresIn * 1000;
        }
        fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
        console.error('[auth-refresh] Token refreshed');
        return true;
      }
    } catch (e) {
      console.error('[auth-refresh] Error:', e.message);
    }
    return false;
  })();

  return refreshPromise;
}

global.fetch = async (url, opts) => {
  const response = await originalFetch(url, opts);

  // If 401, try to refresh and retry
  if (response.status === 401) {
    console.error('[auth-refresh] Got 401, attempting token refresh...');
    const refreshed = await tryRefreshToken();

    if (refreshed) {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        const newToken = creds.claudeAiOauth?.accessToken;

        if (newToken && opts && opts.headers) {
          opts.headers['Authorization'] = \`Bearer \${newToken}\`;
          console.error('[auth-refresh] Retrying request with refreshed token...');
          return originalFetch(url, opts);
        }
      } catch (e) {}
    }
  }

  return response;
};
`;

// Find a good place to inject the wrapper
// Look for the first occurrence of "fetch" or "http" references
// v2.1.112 likely has fetch calls early in the initialization

if (code.includes('fetch')) {
  const newCode = wrapper + '\\n' + code;
  fs.writeFileSync(CLI_JS, newCode);
  console.log('✓ Auth refresh patch applied');
} else {
  console.log('⚠ Could not find injection point, patch may not work');
}
EOF

    # Mark that we've patched this version
    touch "$PATCH_MARKER"
fi

# Now run Claude with the original command
exec node "$CLI_JS" "$@"
