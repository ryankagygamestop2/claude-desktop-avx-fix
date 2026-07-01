# claude-desktop-avx-fix

Fixes the Claude desktop app on older Intel Macs that lack AVX2 support (pre-Haswell CPUs, circa 2013).

## The Problem

The Claude desktop app bundles a native binary (built with Bun) that requires AVX2 CPU instructions. On older Intel Macs (e.g. Mac Pro 5,1 with Xeon X5675), this binary crashes immediately with:

```
Illegal instruction: 4
```

The Electron UI opens fine, but the app is unresponsive because its backend process dies on launch.

## The Fix

This script replaces the native Bun binary with a wrapper that runs the npm-distributed version of `@anthropic-ai/claude-code` via Node.js, which has no AVX2 requirement.

## Requirements

- [nvm](https://github.com/nvm-sh/nvm) with a working Node.js installation
- The Claude desktop app installed

## Usage

```bash
# First time
git clone https://github.com/$(gh api user -q .login)/claude-desktop-avx-fix.git
cd claude-desktop-avx-fix
chmod +x update-claude-desktop.sh
./update-claude-desktop.sh
```

Re-run the script after the desktop app updates:

```bash
./update-claude-desktop.sh
```

## What it does

1. Updates `@anthropic-ai/claude-code` npm package to the latest version
2. Finds the latest version directory the desktop app created
3. Backs up the native Bun binary (if present)
4. Replaces it with a shell wrapper that invokes the Node.js version
5. Restart the Claude desktop app to apply

## Auth Token Refresh Issue (v2.1.112+)

**Problem:** If you see `API Error: 401 "Invalid authentication credentials"` after running `/login`, this is a token refresh issue. The `/login` command succeeds and stores credentials, but subsequent API calls are rejected with 401.

**Root Cause:** v2.1.112 doesn't automatically refresh tokens when they expire or are rejected by the API.

**Solution:** Use the provided `claude-wrapper.sh` script instead of running `claude` directly. The wrapper patches `cli.js` to:
1. Intercept 401 auth errors
2. Automatically refresh the token using the stored `refreshToken`
3. Retry the failed request with the new token

### Setup auth fix

Replace your current shim with the patched wrapper:

```bash
# Copy the wrapper into your nvm Node directory
cp claude-wrapper.sh ~/.nvm/versions/node/v24.14.0/bin/claude
chmod +x ~/.nvm/versions/node/v24.14.0/bin/claude

# Or create a symlink to it
ln -sf /path/to/claude-wrapper.sh ~/.nvm/versions/node/v24.14.0/bin/claude
```

The wrapper will automatically patch `cli.js` the first time it runs. You may see `[claude-auth]` messages during token refresh, which is expected.

If you still get 401 errors after the patch:
1. Try logging out and back in: `/logout` then `/login`
2. Clear credentials: `rm ~/.claude/.credentials.json`
3. Check your Anthropic account status at https://console.anthropic.com

## Affected hardware

Any Intel Mac with a CPU older than Haswell (4th gen, 2013), including:
- Mac Pro 5,1 (2010/2012) - Westmere Xeon
- Mac Pro 4,1 (2009) - Nehalem Xeon
- Older iMacs, MacBooks, Mac Minis with Sandy Bridge or Ivy Bridge CPUs
