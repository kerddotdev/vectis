#!/usr/bin/env bash
set -euo pipefail

test "$(uname -m)" = arm64
xcodebuild -version | tee "$RUNNER_TEMP/xcode-version.txt"
grep -qx 'Xcode 27.0' "$RUNNER_TEMP/xcode-version.txt"
xcrun --sdk macosx --show-sdk-path
xcrun --find notarytool
xcrun --find stapler
command -v codesign
test "$(node --version)" = v24.21.0
test "$(pnpm --version)" = 10.24.0
swift build --package-path native/apple --configuration release

app="$RUNNER_TEMP/VectisValidation"
mkdir -p "$app/VectisValidation.xcodeproj"
cat > "$app/main.swift" <<'SWIFT'
import AppKit

let application = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 200),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Vectis environment validation"
window.makeKeyAndOrderFront(nil)
application.run()
SWIFT
cat > "$app/VectisValidation.xcodeproj/project.pbxproj" <<'PROJECT'
{
  archiveVersion = 1;
  objectVersion = 56;
  objects = {
    A00000000000000000000001 = {isa = PBXProject; buildConfigurationList = A00000000000000000000002; compatibilityVersion = "Xcode 14.0"; mainGroup = A00000000000000000000003; productRefGroup = A00000000000000000000004; targets = (A00000000000000000000005); };
    A00000000000000000000002 = {isa = XCConfigurationList; buildConfigurations = (A00000000000000000000006); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    A00000000000000000000003 = {isa = PBXGroup; children = (A00000000000000000000007, A00000000000000000000004); sourceTree = "<group>"; };
    A00000000000000000000004 = {isa = PBXGroup; children = (A00000000000000000000008); name = Products; sourceTree = "<group>"; };
    A00000000000000000000005 = {isa = PBXNativeTarget; buildConfigurationList = A00000000000000000000009; buildPhases = (A00000000000000000000010); buildRules = (); dependencies = (); name = VectisValidation; productName = VectisValidation; productReference = A00000000000000000000008; productType = "com.apple.product-type.application"; };
    A00000000000000000000006 = {isa = XCBuildConfiguration; buildSettings = {SDKROOT = macosx; MACOSX_DEPLOYMENT_TARGET = 26.0; }; name = Release; };
    A00000000000000000000007 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = main.swift; sourceTree = "<group>"; };
    A00000000000000000000008 = {isa = PBXFileReference; explicitFileType = wrapper.application; path = VectisValidation.app; sourceTree = BUILT_PRODUCTS_DIR; };
    A00000000000000000000009 = {isa = XCConfigurationList; buildConfigurations = (A00000000000000000000011); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    A00000000000000000000010 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A00000000000000000000012); runOnlyForDeploymentPostprocessing = 0; };
    A00000000000000000000011 = {isa = XCBuildConfiguration; buildSettings = {ARCHS = arm64; CODE_SIGNING_ALLOWED = NO; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = dev.kerd.vectis.environmentvalidation; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_VERSION = 6.0; }; name = Release; };
    A00000000000000000000012 = {isa = PBXBuildFile; fileRef = A00000000000000000000007; };
  };
  rootObject = A00000000000000000000001;
}
PROJECT
xcodebuild -project "$app/VectisValidation.xcodeproj" -target VectisValidation \
  -configuration Release CODE_SIGNING_ALLOWED=NO CONFIGURATION_BUILD_DIR="$app/output" build
test -x "$app/output/VectisValidation.app/Contents/MacOS/VectisValidation"
lipo -verify_arch arm64 "$app/output/VectisValidation.app/Contents/MacOS/VectisValidation"
