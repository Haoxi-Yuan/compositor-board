#!/bin/sh
# Builds compositor-engine: Compositor's own document, rendering and file code (upstream/, read only) compiled
# without its windows and SwiftUI views, plus the request loop in Sources/. Needs only the Command Line Tools: the
# app's Metal shaders compile at run time from source, and the SwiftUI files that need Xcode's macro plugins are left
# out. The build settings mirror the upstream Xcode project (Swift 5 mode, MainActor by default, approachable
# concurrency).
set -e
cd "$(dirname "$0")"
UPSTREAM=../upstream
OUT=bin
WORK=.build
mkdir -p "$OUT" "$WORK"

# Window, app and SwiftUI-view code the engine has no use for.
EXCLUDE='Compositor/IO/UpdateDriver.swift
Compositor/IO/CompositorApplicationDelegate.swift
Compositor/IO/ProjectController.swift
Compositor/IO/ProjectController+ExternalChanges.swift
Compositor/IO/ImageFileDrop.swift
Compositor/Document/ProjectWorkspace.swift
Compositor/Rendering/EditorCanvas.swift
Compositor/Rendering/InlineTextEditor.swift'
# UI files that hold model types the engine needs and compile without SwiftUI's macros.
UI_KEEP='BlendModePicker CameraRawSlider CanvasThumbnail HeldModifiers IndicatorlessScrollView ProjectTabLayout PSDConversionSheet SliderSnap'

(cd "$UPSTREAM" && find Compositor/Document Compositor/Rendering Compositor/IO -name '*.swift' | sort) > "$WORK/all.txt"
echo "$EXCLUDE" | sort > "$WORK/exclude.txt"
comm -23 "$WORK/all.txt" "$WORK/exclude.txt" | sed "s|^|$UPSTREAM/|" > "$WORK/files.txt"
for name in $UI_KEEP; do echo "$UPSTREAM/Compositor/UI/$name.swift" >> "$WORK/files.txt"; done
ls Sources/*.swift >> "$WORK/files.txt"

for c in "$UPSTREAM"/Compositor/Rendering/*.c; do
    clang -O2 -c "$c" -o "$WORK/$(basename "$c" .c).o" -I"$UPSTREAM/Compositor/Rendering"
done

cat > "$WORK/flags.txt" <<FLAGS
-O
-parse-as-library
-swift-version
5
-default-isolation
MainActor
-enable-upcoming-feature
NonisolatedNonsendingByDefault
-enable-upcoming-feature
InferIsolatedConformances
-enable-upcoming-feature
InferSendableFromCaptures
-enable-upcoming-feature
GlobalActorIsolatedTypesUsability
-enable-upcoming-feature
DisableOutwardActorInference
-enable-upcoming-feature
MemberImportVisibility
-target
arm64-apple-macosx26.0
-import-objc-header
$UPSTREAM/Compositor/Compositor-Bridging-Header.h
-I$UPSTREAM/Compositor/Rendering
FLAGS

swiftc @"$WORK/flags.txt" @"$WORK/files.txt" "$WORK"/*.o -o "$OUT/compositor-engine"
# Camera Raw's lookup tables, which the app finds with Bundle.main: for a command-line tool, the executable's folder.
cp "$UPSTREAM"/Compositor/Resources/*.bin "$OUT/"
echo "built $OUT/compositor-engine ($(wc -l < "$WORK/files.txt" | tr -d ' ') Swift files, upstream $(git -C "$UPSTREAM" rev-parse --short HEAD))"
