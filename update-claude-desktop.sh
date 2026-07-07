#!/bin/bash
# update-claude-desktop.sh
# Patches Claude Code binaries to use the npm (Node.js) version of claude-code
# instead of the native Bun binary, which crashes on older Intel CPUs (pre-AVX2).
#
# Usage: ./update-claude-desktop.sh
#
# Safe to re-run anytime — it patches every version directory it finds under
# the desktop app's claude-code folder (the app creates a NEW version dir on
# each update rather than overwriting the old one in place), skips binaries
# that are already patched, and locks each patched binary with chflags uchg
# so the app's own launch-time integrity check can't silently revert it.
# It also maintains the `claude` CLI wrapper in nvm's bin dir the same way.

set -e

# ---------------------------------------------------------------------------
# Mutex: a background watcher can fire more than once in quick succession
# (once on load, again because this script's own writes under claude-code
# trigger the watch a second time before the first run finishes). Without
# this, two concurrent `npm install` runs can race on npm's temp staging
# directory and fail with a confusing EPERM/unlink error.
# ---------------------------------------------------------------------------
LOCK_DIR="/tmp/claude-desktop-avx-fix.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Another instance is already running (lock: $LOCK_DIR) — exiting."
    exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

CLAUDE_CODE_DIR="$HOME/Library/Application Support/Claude/claude-code"
NVM_DIR="$HOME/.nvm"

# Load nvm
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Check node/npm are available
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    echo "Error: node/npm not found. Make sure nvm is installed and a node version is active."
    exit 1
fi

NODE_PATH="$(which node)"
NVM_BIN_DIR="$(dirname "$NODE_PATH")"
CLI_WRAPPER="$NVM_BIN_DIR/claude"
echo "Using node: $NODE_PATH ($(node -v))"

# ---------------------------------------------------------------------------
# Install the pinned npm package — but only if it isn't already correctly
# installed. Later versions dropped the bundled cli.js in favor of a
# platform-specific native binary (same AVX2 requirement this script exists
# to work around), so "@latest" silently breaks this fix. Skipping the
# reinstall when nothing needs to change also means most watcher-triggered
# runs never touch npm at all, which is the safest way to avoid races.
# ---------------------------------------------------------------------------
CLI_JS="$(npm root -g)/@anthropic-ai/claude-code/cli.js"
INSTALLED_VERSION=""
if [ -f "$CLI_JS" ]; then
    INSTALLED_VERSION=$(node -e "console.log(require('$(npm root -g)/@anthropic-ai/claude-code/package.json').version)" 2>/dev/null || echo "")
fi

if [ "$INSTALLED_VERSION" != "2.1.112" ]; then
    # Unlock the CLI wrapper first if it's locked (chflags uchg) — npm
    # refuses to overwrite a non-symlink file at a package's bin path, and
    # needs to manage this path during install.
    chflags nouchg "$CLI_WRAPPER" 2>/dev/null || true
    rm -f "$CLI_WRAPPER"

    echo "Installing @anthropic-ai/claude-code@2.1.112..."
    npm install -g @anthropic-ai/claude-code@2.1.112

    if [ ! -f "$CLI_JS" ]; then
        echo "Error: cli.js not found at $CLI_JS"
        exit 1
    fi
    NPM_VERSION=$(node -e "console.log(require('$(npm root -g)/@anthropic-ai/claude-code/package.json').version)")
    echo "npm claude-code version: $NPM_VERSION"
else
    echo "npm claude-code already at 2.1.112 — skipping reinstall."
fi

# ---------------------------------------------------------------------------
# Recreate and lock the CLI wrapper if it isn't already our wrapper script
# (npm's install replaces it with its own symlink to cli.js when it runs).
# ---------------------------------------------------------------------------
if ! head -1 "$CLI_WRAPPER" 2>/dev/null | grep -q "^#!/bin/bash"; then
    chflags nouchg "$CLI_WRAPPER" 2>/dev/null || true
    rm -f "$CLI_WRAPPER"
    cat > "$CLI_WRAPPER" << EOF
#!/bin/bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
exec node "$CLI_JS" "\$@"
EOF
    chmod +x "$CLI_WRAPPER"
    chflags uchg "$CLI_WRAPPER"
    echo "Patched + locked CLI: $CLI_WRAPPER"
fi

# ---------------------------------------------------------------------------
# Patch every version directory found under the desktop app's claude-code
# folder. The app creates a new version dir on each update rather than
# overwriting the old one, so old and new can coexist — patch all of them.
# ---------------------------------------------------------------------------
if [ ! -d "$CLAUDE_CODE_DIR" ]; then
    echo ""
    echo "No desktop app directory found at $CLAUDE_CODE_DIR — nothing more to patch."
    echo "(This is normal if you only use the CLI, not the desktop app.)"
    exit 0
fi

PATCHED_ANY=false
for VERSION_DIR in "$CLAUDE_CODE_DIR"/*/; do
    [ -d "$VERSION_DIR" ] || continue
    VERSION_DIR="${VERSION_DIR%/}"
    VERSION_NAME="$(basename "$VERSION_DIR")"
    APP_BINARY_PATH="$VERSION_DIR/claude.app/Contents/MacOS/claude"
    STANDALONE_BINARY_PATH="$VERSION_DIR/claude"

    for BINARY_PATH in "$APP_BINARY_PATH" "$STANDALONE_BINARY_PATH"; do
        if [ ! -e "$BINARY_PATH" ] && [ ! -L "$BINARY_PATH" ]; then
            continue
        fi

        # Already patched (and presumably locked)? Skip — keeps re-runs cheap
        # and idempotent so this is safe to call from a watcher/cron job.
        if head -1 "$BINARY_PATH" 2>/dev/null | grep -q "^#!/bin/bash"; then
            continue
        fi

        if file "$BINARY_PATH" 2>/dev/null | grep -q "Mach-O"; then
            chflags nouchg "$BINARY_PATH" 2>/dev/null || true
            echo "Backing up native binary: $BINARY_PATH -> ${BINARY_PATH}.bun.bak"
            mv "$BINARY_PATH" "${BINARY_PATH}.bun.bak"
        fi

        cat > "$BINARY_PATH" << EOF
#!/bin/bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
exec node "$CLI_JS" "\$@"
EOF
        chmod +x "$BINARY_PATH"
        chflags uchg "$BINARY_PATH"
        echo "Patched + locked: $BINARY_PATH (version $VERSION_NAME)"
        PATCHED_ANY=true
    done
done

echo ""
if [ "$PATCHED_ANY" = true ]; then
    echo "Done! Restart the Claude desktop app to apply."
else
    echo "Done! Every version directory was already patched — nothing to do."
fi
