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

## Auth Token Issues (v2.1.112)

**Problem:** `API Error: 401 "Invalid authentication credentials"` after `/login` succeeds.

**Root Cause:** v2.1.112 is **incompatible with the current Anthropic API**. The API changed to require an `anthropic-version` header and has different token validation logic that v2.1.112 doesn't implement.

### Investigation & Findings

Through extensive debugging, we discovered:

1. **v2.1.112 doesn't send the Authorization header** for the messages API endpoint
   - The `/api/eval` endpoint receives it and works (returns 200)
   - The `/v1/messages` endpoint doesn't receive it (returns 401)

2. **Current API requires `anthropic-version` header** 
   - Without it: `"anthropic-version: header is required"`
   - With it: `"Invalid bearer token"` (different error)

3. **Token format incompatibility**
   - Even when all headers are correctly injected, the token is rejected
   - The token works for `/login` but not for messages API
   - This suggests Anthropic changed their token validation

### Workarounds Attempted

We created a runtime wrapper (`claude-wrapper-final.js`) that:
- Injects the missing Authorization header
- Adds the required anthropic-version header
- Re-reads credentials on each request

**Status:** Partially working. Headers are injected correctly, but API still returns 401.

### Recommended Solutions

Since v2.1.112 is incompatible with current API:

1. **Option A: Use a newer Claude Code version**
   - Check if newer versions can run on your Mac without AVX2
   - Newer versions have proper API support

2. **Option B: Contact Anthropic support**
   - Report that v2.1.112 stopped working
   - Ask about older version API compatibility

3. **Option C: Investigate AVX2 workarounds**
   - Check if there's a way to use newer versions on pre-AVX2 hardware
   - Explore CPU emulation or QEMU options

## Affected hardware

Any Intel Mac with a CPU older than Haswell (4th gen, 2013), including:
- Mac Pro 5,1 (2010/2012) - Westmere Xeon
- Mac Pro 4,1 (2009) - Nehalem Xeon
- Older iMacs, MacBooks, Mac Minis with Sandy Bridge or Ivy Bridge CPUs
