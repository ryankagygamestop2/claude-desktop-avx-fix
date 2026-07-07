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

1. Installs the pinned `@anthropic-ai/claude-code@2.1.112` npm package
2. Patches and locks the `claude` CLI wrapper in your nvm bin directory
3. Finds **every** version directory the desktop app has created (it makes a new one on each update rather than overwriting the old one — see below) and, for each:
   - Backs up the native Bun binary (if present)
   - Replaces it with a shell wrapper that invokes the Node.js version
   - Locks it with `chflags uchg` so it can't be silently reverted
4. Restart the Claude desktop app to apply

Safe to re-run anytime — it skips anything already patched, so it's cheap to call repeatedly (including from the background watcher below).

## Handling desktop app auto-updates automatically

The desktop app doesn't overwrite its binary in place when it updates — it creates a **new**, separately versioned directory (e.g. `2.1.202` next to the existing `2.1.197`) containing a fresh, unpatched native binary, and apparently re-verifies/restores its bundled binary at launch too. That means a one-time patch doesn't stay fixed forever; you either need to re-run `update-claude-desktop.sh` after every update, or set up a background watcher that does it for you automatically.

To have it patch new versions the moment they appear, install a `launchd` agent that watches the app's `claude-code` directory and re-runs the script on any change:

```bash
REPO_DIR="$HOME/claude-desktop-avx-fix"
PLIST_PATH="$HOME/Library/LaunchAgents/com.claude-desktop-avx-fix.watcher.plist"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-desktop-avx-fix.watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO_DIR/update-claude-desktop.sh</string>
    </array>
    <key>WatchPaths</key>
    <array>
        <string>$HOME/Library/Application Support/Claude/claude-code</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>/tmp/claude-desktop-avx-fix-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-desktop-avx-fix-watcher.log</string>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) "$PLIST_PATH"
```

This fires whenever anything changes under `claude-code` (a new version directory appearing counts) and also once at login, in case a version showed up while you were logged out. Since the script is idempotent and makes zero filesystem changes when everything's already patched, it settles after one real patch cycle rather than looping.

Check it's running and see its log:

```bash
launchctl list | grep claude-desktop-avx-fix
cat /tmp/claude-desktop-avx-fix-watcher.log
```

To disable it later:

```bash
launchctl bootout gui/$(id -u)/com.claude-desktop-avx-fix.watcher
rm ~/Library/LaunchAgents/com.claude-desktop-avx-fix.watcher.plist
```

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
