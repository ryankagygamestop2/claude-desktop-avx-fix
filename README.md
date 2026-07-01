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

## Auth Token Issues: "Please run /login" loop after login succeeds

**Symptom:** `/login` reports "Login successful", but every request immediately after fails with:

```
API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}
```

No amount of repeating `/login`, `/logout`, deleting `~/.claude/.credentials.json`, or reinstalling the npm package fixes it.

**This is not a Claude Code bug or an API compatibility issue.** On macOS, Claude Code stores OAuth credentials in the login Keychain (service name `Claude Code-credentials`), not in a plaintext file. If the Keychain itself can't be written to, `/login` completes the OAuth handshake successfully but silently fails to persist the new token — so every subsequent request keeps using whatever stale token was already in Keychain, which is likely expired or revoked.

### How to diagnose

Confirm the Keychain is actually the problem with a test unrelated to Claude Code entirely:

```bash
security add-generic-password -a "$USER" -s "diagnostic-test" -w "hello123" -U
security find-generic-password -a "$USER" -w -s "diagnostic-test"
security delete-generic-password -a "$USER" -s "diagnostic-test"
```

If the middle command doesn't print back `hello123`, or you see an error like:

```
security: SecKeychainItemCreateFromContent (<default>): UNIX[Permission denied]
```

your login keychain itself is rejecting writes — independent of Claude Code.

Check the actual `Claude Code-credentials` entry's last-modified time to confirm it's stale despite recent "successful" logins:

```bash
security find-generic-password -a "$USER" -s "Claude Code-credentials" 2>&1 | grep -E "cdat|mdat"
```

If `mdat` (modified date) is much older than your most recent `/login`, that confirms writes aren't persisting.

### Root cause (in our case)

Two things had gone wrong with `~/Library/Keychains/login.keychain-db`:

1. **`com.apple.quarantine` extended attribute** was stamped on the keychain file itself (in our case, by Chrome at some point) — macOS blocks command-line tools like `security` from writing to quarantined files.
2. **A stale/dead keychain reference in the search list** (an old renamed/archived keychain) caused extra unlock prompts even after the main issue was fixed.

Check for both:

```bash
xattr -l ~/Library/Keychains/login.keychain-db
ls -le ~/Library/Keychains/login.keychain-db   # look for unexpected ACL entries
security list-keychains                          # look for dead/orphaned entries
```

### The fix

```bash
# 1. Strip the quarantine flag
xattr -d com.apple.quarantine ~/Library/Keychains/login.keychain-db

# 2. Clear any custom ACL entries
chmod -N ~/Library/Keychains/login.keychain-db

# 3. Clear any stale file flags
chflags nouchg ~/Library/Keychains/login.keychain-db

# 4. Re-bind and unlock the default keychain explicitly
security default-keychain -s ~/Library/Keychains/login.keychain-db
security unlock-keychain ~/Library/Keychains/login.keychain-db

# 5. Verify the diagnostic test now works
security add-generic-password -a "$USER" -s "diagnostic-test" -w "hello123" -U
security find-generic-password -a "$USER" -w -s "diagnostic-test"
security delete-generic-password -a "$USER" -s "diagnostic-test"
```

If you still get an unlock popup for an old/unfamiliar keychain name after this, it's a dead entry in the keychain search list — drop it and rebuild the list pointing only at your real keychain:

```bash
security delete-keychain <old-keychain-name>.keychain-db   # or the absolute path if the short name isn't found
security list-keychains -s ~/Library/Keychains/login.keychain-db
security list-keychains   # should show exactly one entry: login.keychain-db
```

Then `claude /login` again — it should now persist correctly, and normal usage should stop 401ing.

### Note on the AVX2 shim + this issue

This Keychain problem is unrelated to the AVX2 fix above and can happen on any Mac. It came up here because it coincided with adding a second bootable macOS volume on the same machine, which is what stamped/disturbed the keychain file. If you're troubleshooting a 401 loop on a Mac running the Node.js-shimmed version of Claude Code from this repo, check Keychain health first before assuming it's a version/API incompatibility.

## Affected hardware

Any Intel Mac with a CPU older than Haswell (4th gen, 2013), including:
- Mac Pro 5,1 (2010/2012) - Westmere Xeon
- Mac Pro 4,1 (2009) - Nehalem Xeon
- Older iMacs, MacBooks, Mac Minis with Sandy Bridge or Ivy Bridge CPUs
