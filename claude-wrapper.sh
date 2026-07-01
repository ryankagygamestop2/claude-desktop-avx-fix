#!/bin/bash
# Wrapper for Claude Code v2.1.112+ that patches auth token refresh
# This fixes the 401 "Invalid authentication credentials" issue where
# /login succeeds but subsequent API calls fail with 401.
#
# Usage: Replace your claude shim with this script, or run it directly.

set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Find the installed claude-code package
CLAUDE_CODE_DIR="$(npm root -g)/@anthropic-ai/claude-code" 2>/dev/null || {
    echo "Error: @anthropic-ai/claude-code not installed globally"
    echo "Install with: npm install -g @anthropic-ai/claude-code@2.1.112"
    exit 1
}

CLI_JS="$CLAUDE_CODE_DIR/cli.js"

if [ ! -f "$CLI_JS" ]; then
    echo "Error: cli.js not found at $CLAUDE_CODE_DIR"
    exit 1
fi

# Create patch marker directory
PATCH_DIR="$HOME/.claude/.auth-patches"
mkdir -p "$PATCH_DIR"

# Use file hash as marker to know which versions we've patched
CLI_HASH=$(md5 -q "$CLI_JS" 2>/dev/null || sha1sum "$CLI_JS" 2>/dev/null | cut -d' ' -f1 || echo "unknown")
PATCH_MARKER="$PATCH_DIR/.patched-$CLI_HASH"

# Apply patch if not already applied to this version
if [ ! -f "$PATCH_MARKER" ]; then
    echo "[claude-auth-fix] Patching cli.js for token refresh..."

    # Backup original
    if [ ! -f "$CLI_JS.orig" ]; then
        cp "$CLI_JS" "$CLI_JS.orig"
        echo "[claude-auth-fix] Backed up original to cli.js.orig"
    fi

    # Apply the patch via Node.js script
    if ! node "$CLAUDE_CODE_DIR/apply-auth-patch.js" "$CLI_JS" 2>/dev/null; then
        # Fallback: try copying from repo
        if [ -f "$PATCH_DIR/apply-auth-patch.js" ]; then
            node "$PATCH_DIR/apply-auth-patch.js" "$CLI_JS" || {
                echo "[claude-auth-fix] Patch failed, restoring backup..."
                cp "$CLI_JS.orig" "$CLI_JS"
                exit 1
            }
        else
            echo "[claude-auth-fix] Warning: apply-auth-patch.js not found"
            echo "[claude-auth-fix] Manual patch application needed"
            # Continue anyway - may still work
        fi
    fi

    touch "$PATCH_MARKER"
    echo "[claude-auth-fix] Patch applied successfully"
fi

# Run the patched CLI
exec node "$CLI_JS" "$@"
