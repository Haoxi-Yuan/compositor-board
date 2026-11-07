#!/bin/sh
# Copies the shared core/ library and the built compositor-engine into each package, which must stay self-contained
# once installed.
set -e
cd "$(dirname "$0")/.."
for target in vscode-extension/core claude-plugin/server/core; do
    rm -rf "$target"
    mkdir -p "$target"
    cp core/*.js "$target/"
done
if [ -x engine/bin/compositor-engine ]; then
    for target in vscode-extension/bin claude-plugin/server/bin; do
        # A new file, not one copied over: macOS kills a binary rewritten in place (its signature is cached per file).
        rm -rf "$target"
        mkdir -p "$target"
        cp engine/bin/compositor-engine engine/bin/*.bin "$target/"
    done
    echo "core and compositor-engine synced into vscode-extension and claude-plugin"
else
    echo "core synced; engine/bin/compositor-engine not built yet (run engine/build.sh)"
fi
