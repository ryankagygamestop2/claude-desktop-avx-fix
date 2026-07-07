# claude-desktop-avx-fix

Fixes Claude Code — both the CLI and the desktop app — on older Intel Macs that lack AVX2 support (pre-Haswell CPUs, circa 2013 and earlier).

## The problem

Current Claude Code ships as a native binary (built with Bun) that requires AVX2 CPU instructions. On older Intel Macs (e.g. Mac Pro 5,1 with Xeon X5675, Mac Pro 4,1 with Nehalem Xeon), this crashes immediately:

- **CLI:** `Illegal instruction: 4` in the terminal (exit code 132)
- **Desktop app:** the Electron UI opens fine, but starting a session fails with `Claude Code process exited with code 132` — its backend process is the same AVX2-requiring binary, dying on launch

Both are fixed the same way: replace the native binary with a wrapper that runs an older, npm-distributed version of `@anthropic-ai/claude-code` through Node.js instead, which has no AVX2 requirement.

## Prerequisites

- [nvm](https://github.com/nvm-sh/nvm) with a working Node.js installation
- This repo cloned locally:
  ```bash
  git clone <this-repo-url> ~/claude-desktop-avx-fix
  cd ~/claude-desktop-avx-fix
  chmod +x update-claude-desktop.sh
  ```

## Install

One script handles both the CLI and the desktop app (if installed):

```bash
./update-claude-desktop.sh
```

What it does:

1. Installs the pinned `@anthropic-ai/claude-code@2.1.112` npm package — the last version to ship a Node.js-runnable `cli.js` instead of an AVX2-only native binary. (Skips this step if 2.1.112 is already installed.)
2. Creates a `claude` wrapper script in your nvm bin directory and locks it with `chflags uchg` (see [Stop auto-updaters](#stop-auto-updaters-from-undoing-this) below for why).
3. If the desktop app is installed, finds **every** version directory under `~/Library/Application Support/Claude/claude-code/` — it creates a new one on each update rather than overwriting the old one — and for each: backs up the native binary, replaces it with the same Node.js wrapper, and locks it too.

Safe to re-run anytime: it skips anything already patched, so re-running after a manual update or from the background watcher below is cheap and idempotent.

Verify:
```bash
claude --version   # should print "2.1.112 (Claude Code)" with no crash
```
For the desktop app, restart it and start a local session.

## Stop auto-updaters from undoing this

Two *separate* auto-update mechanisms will silently break this fix if left on. Disable both.

### 1. The CLI's own background updater

Add to `~/.claude/settings.json` (merge with whatever's already there):

```json
{
  "env": {
    "DISABLE_UPDATES": "1",
    "DISABLE_AUTOUPDATER": "1"
  }
}
```

`DISABLE_AUTOUPDATER` stops the silent background check; `DISABLE_UPDATES` also blocks manual `claude update`/`claude install`. Set both — the documented behavior has been inconsistent across versions.

**Never run `claude install`** on this machine, even if a banner suggests it — it fetches the latest native-only build and immediately breaks with `Illegal instruction`.

### 2. The desktop app's auto-updater (Sparkle/"ShipIt")

The desktop app uses the Sparkle framework for updates, which runs as a background helper (`com.anthropic.claudefordesktop.ShipIt`) independent of whether the app window is open. Disable its automatic checks:

```bash
defaults write com.anthropic.claudefordesktop SUEnableAutomaticChecks -bool NO
defaults write com.anthropic.claudefordesktop SUAutomaticallyUpdate -bool NO
launchctl bootout gui/$(id -u)/com.anthropic.claudefordesktop.ShipIt 2>/dev/null
```

Also check inside the app itself (Preferences/Settings menu) for an "automatically check for updates" toggle and disable it there too.

**Even with this disabled**, the app appears to re-verify/restore its bundled binary at launch in some cases, and updates can still slip through (manual "Check for Updates," etc.). Rather than fight this indefinitely, set up the watcher below so any new version gets patched automatically instead of relying on updates never happening.

### 3. Auto-patch new desktop app versions in the background

Install a `launchd` agent that watches the app's `claude-code` directory and re-runs `update-claude-desktop.sh` the moment a new version directory appears:

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

This fires whenever anything changes under `claude-code` (a new version directory counts) and once at login. The script has a built-in lock so overlapping triggers can't race each other, and it makes zero filesystem changes once everything's already patched, so it settles quickly rather than looping.

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

Skip this step entirely if you only use the CLI, not the desktop app.

## Troubleshooting

### "Illegal instruction" / exit code 132 comes back after working fine

Something reverted the patch — most commonly the CLI or desktop app auto-updater (see above), or npm reinstalling the package as a side effect of an unrelated `npm install -g`. Just re-run:
```bash
./update-claude-desktop.sh
```
If the CLI wrapper is locked (`chflags uchg`) and you need to inspect or hand-edit it, unlock it first: `chflags nouchg ~/.nvm/versions/node/*/bin/claude`.

### `npm install`/`npm uninstall` fails with `EACCES` or `EPERM`

Two known causes we've hit:

1. **Mixed root/admin ownership** somewhere under `~/.nvm` (usually left over from an earlier `sudo` command touching that tree). Fix by reclaiming ownership, then retry with no `sudo`:
   ```bash
   sudo chown -R "$(whoami):staff" ~/.nvm/versions/node/<your-version>
   ```
2. **A race between two overlapping runs** of the patch script (e.g. the background watcher firing twice in quick succession) both trying to modify npm's temp staging directory at once. The script has a lock to prevent this going forward; if you hit a leftover orphaned temp dir (`@anthropic-ai/.claude-code-XXXXXXXX`) from before that fix, clear it manually:
   ```bash
   chflags -R nouchg "$(npm root -g)/@anthropic-ai/.claude-code-XXXXXXXX" 2>/dev/null
   rm -rf "$(npm root -g)/@anthropic-ai/.claude-code-XXXXXXXX"
   ```

### `cat > .../bin/claude` corrupts `cli.js` instead of creating the wrapper

If `bin/claude` is currently a **symlink** (which is what a fresh `npm install -g` creates, pointing at `cli.js`), redirecting into it with `cat >` follows the symlink and overwrites the real `cli.js` instead of creating a new file. Always `rm -f` the existing `bin/claude` immediately before writing the wrapper — `update-claude-desktop.sh` already does this correctly; only an issue if you're hand-running the steps yourself.

### Auth: "Please run /login" loop (401) after login reports success

**Symptom:** `/login` reports "Login successful", but every request immediately after fails with:
```
API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}
```
No amount of repeating `/login`, `/logout`, deleting `~/.claude/.credentials.json`, or reinstalling the npm package fixes it.

**This is not a Claude Code bug or an API compatibility issue.** On macOS, Claude Code stores OAuth credentials in the login Keychain (service name `Claude Code-credentials`), not in a plaintext file. If the Keychain itself can't be written to, `/login` completes the OAuth handshake successfully but silently fails to persist the new token — so every subsequent request keeps using whatever stale token was already in Keychain, which is likely expired or revoked.

**How to diagnose** — confirm the Keychain is the problem with a test unrelated to Claude Code entirely:
```bash
security add-generic-password -a "$USER" -s "diagnostic-test" -w "hello123" -U
security find-generic-password -a "$USER" -w -s "diagnostic-test"
security delete-generic-password -a "$USER" -s "diagnostic-test"
```
If the middle command doesn't print back `hello123`, or you see an error like:
```
security: SecKeychainItemCreateFromContent (<default>): UNIX[Permission denied]
```
your login keychain itself is rejecting writes — independent of Claude Code. Also check the actual entry's last-modified time to confirm it's stale despite recent "successful" logins:
```bash
security find-generic-password -a "$USER" -s "Claude Code-credentials" 2>&1 | grep -E "cdat|mdat"
```
If `mdat` is much older than your most recent `/login`, that confirms writes aren't persisting.

**Root cause (in our case):** two things had gone wrong with `~/Library/Keychains/login.keychain-db`:
1. **`com.apple.quarantine` extended attribute** stamped on the keychain file itself (in our case, by Chrome at some point) — macOS blocks command-line tools like `security` from writing to quarantined files.
2. **A stale/dead keychain reference in the search list** (an old renamed/archived keychain) caused extra unlock prompts even after the main issue was fixed.

Check for both:
```bash
xattr -l ~/Library/Keychains/login.keychain-db
ls -le ~/Library/Keychains/login.keychain-db   # look for unexpected ACL entries
security list-keychains                          # look for dead/orphaned entries
```

**The fix:**
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

This Keychain problem is unrelated to the AVX2 fix and can happen on any Mac — check Keychain health first before assuming a 401 loop is a version/API incompatibility.

## Affected hardware

Any Intel Mac with a CPU older than Haswell (4th gen, 2013), including:
- Mac Pro 5,1 (2010/2012) - Westmere Xeon
- Mac Pro 4,1 (2009) - Nehalem Xeon
- Older iMacs, MacBooks, Mac Minis with Sandy Bridge or Ivy Bridge CPUs
