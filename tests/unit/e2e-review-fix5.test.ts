import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, createCandidateManifest, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository, proposeE2ESetup } from "../../packages/broker/src/e2e/discovery.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: hash(text), kind: "blob" as const });
const candidate = createCandidateManifest([{ repositoryId: "fixture/fix5", commitSha: "f".repeat(40), treeSha: "a".repeat(40) }]);
const snapshot = (files: ReturnType<typeof file>[]): E2ESourceSnapshot => ({ candidate, commitSha: "f".repeat(40), treeSha: "a".repeat(40), treeComplete: true, treePaths: files.map((item) => item.path), sources: files });
const inspect = (files: ReturnType<typeof file>[]) => inspectE2ERepository(snapshot(files), candidate).inspection;
const propose = (files: ReturnType<typeof file>[]) => proposeE2ESetup({ inspection: inspect(files), snapshot: snapshot(files), expectedCandidate: candidate });

const plist = (id: string, platform: "iPhoneOS" | "MacOSX" = "iPhoneOS") => `<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleSupportedPlatforms</key><array><string>${platform}</string></array></dict></plist>`;
const pbx = (sdk: "iphoneos" | "macosx", id: string, plistPath = "App/Info.plist") => `// !$*UTF8*$!
{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {
AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXProject; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; mainGroup = CCCCCCCCCCCCCCCCCCCCCCCC; targets = (DDDDDDDDDDDDDDDDDDDDDDDD,); };
BBBBBBBBBBBBBBBBBBBBBBBB = { isa = XCConfigurationList; buildConfigurations = (EEEEEEEEEEEEEEEEEEEEEEEE,); defaultConfigurationName = Debug; };
CCCCCCCCCCCCCCCCCCCCCCCC = { isa = PBXGroup; children = (FFFFFFFFFFFFFFFFFFFFFFFF,); sourceTree = "<group>"; };
DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; buildPhases = (); buildRules = (); dependencies = (); name = App; productName = App; productType = "com.apple.product-type.application"; };
EEEEEEEEEEEEEEEEEEEEEEEE = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = ${sdk}; SUPPORTED_PLATFORMS = "${sdk} ${sdk === "iphoneos" ? "iphonesimulator" : ""}"; INFOPLIST_FILE = "${plistPath}"; PRODUCT_BUNDLE_IDENTIFIER = ${id}; }; name = Debug; };
FFFFFFFFFFFFFFFFFFFFFFFF = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = ${plistPath.slice(plistPath.lastIndexOf("/") + 1)}; sourceTree = "<group>"; };
}; rootObject = AAAAAAAAAAAAAAAAAAAAAAAA; }`;

describe("Task2A review fix5 discovery ownership", () => {
  it("discovers standalone Android application metadata independently of an android path prefix", () => {
    const files = [
      file("app/build.gradle", 'plugins { id "com.android.application" }'),
      file("app/src/main/AndroidManifest.xml", '<manifest package="fixture.android"><application/></manifest>'),
    ];
    const withRoot = [file("package.json", JSON.stringify({ name: "root", scripts: { start: "vite" } })), ...files];
    for (const inventory of [files, withRoot, [...withRoot].reverse()]) {
      const result = propose(inventory);
      expect(result.targets.filter((target) => target.kind === "mobile" && target.os === "android")).toHaveLength(1);
      expect(result.missingInputs.some((item) => item.kind === "runtime" && item.sourcePaths.includes("app/src/main/AndroidManifest.xml"))).toBe(true);
    }
    const prefixed = propose(files.map((item) => ({ ...item, path: `android/${item.path}` })));
    expect(prefixed.targets.filter((target) => target.kind === "mobile" && target.os === "android")).toHaveLength(1);
    const gradleOnly = propose([file("native/mobile/build.gradle.kts", 'plugins { id("com.android.application") }')]);
    expect(gradleOnly.applications.some((application) => application.kind === "mobile" && application.sourcePaths.includes("native/mobile/build.gradle.kts"))).toBe(true);
    expect(gradleOnly.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("native/mobile/build.gradle.kts"))).toBe(true);
  });

  it("binds standalone API target and recipe IDs to canonical source paths", () => {
    const schema = JSON.stringify({ openapi: "3.1.0", info: { title: "Fixture", version: "1" }, paths: { "/status": { get: { responses: { "200": { description: "ok" } } } } } });
    const apis = [file("one/openapi.json", schema), file("two/openapi.json", schema)];
    expect(canonicalJson(propose(apis))).toBe(canonicalJson(propose([...apis].reverse())));
    const apiTargets = propose(apis).targets;
    expect(new Set(apiTargets.map((target) => target.targetId)).size).toBe(2);
    expect(apiTargets.every((target) => target.kind === "api")).toBe(true);

  });

  it("keeps duplicate dependency suppliers as a visible ambiguity instead of selecting by inventory order", () => {
    const packages = [
      file("app/package.json", JSON.stringify({ name: "consumer", dependencies: { same: "1" }, scripts: { start: "node app.js" } })),
      file("one/package.json", JSON.stringify({ name: "same" })),
      file("two/package.json", JSON.stringify({ name: "same" })),
    ];
    const forward = propose(packages);
    const reverse = propose([...packages].reverse());
    expect(canonicalJson(forward)).toBe(canonicalJson(reverse));
    expect(forward.dependencyEdges.filter((edge) => edge.fromApplicationId === "consumer")).toHaveLength(0);
    expect(forward.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("app/package.json") && input.sourcePaths.includes("one/package.json") && input.sourcePaths.includes("two/package.json"))).toBe(true);
    const explicitlyLinked = [
      file("app/package.json", JSON.stringify({ name: "consumer", dependencies: { same: "file:../one" }, scripts: { start: "node app.js" } })),
      file("one/package.json", JSON.stringify({ name: "same" })),
      file("two/package.json", JSON.stringify({ name: "same" })),
    ];
    const linked = propose(explicitlyLinked);
    const edge = linked.dependencyEdges.find((item) => item.fromApplicationId === "consumer");
    expect(edge?.sourcePaths).toEqual(["app/package.json", "one/package.json"]);
    expect(linked.missingInputs.some((item) => item.inputId.startsWith("dependency-source-") && item.sourcePaths.includes("two/package.json"))).toBe(false);
  });

  it("uses PBX target configuration to own one plist instead of splitting one target", () => {
    const paired = [
      file("workspace/App/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.ios</string></dict></plist>"),
      file("workspace/App.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.ios")),
    ];
    const pairedProposal = propose(paired);
    expect(pairedProposal.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(1);
    expect(pairedProposal.targets.some((target) => target.kind === "desktop" && target.os === "macos")).toBe(false);
    expect(pairedProposal.applications.filter((application) => application.sourcePaths.includes("workspace/App/Info.plist"))).toHaveLength(1);
    const root = file("package.json", JSON.stringify({ name: "root", scripts: { start: "vite" } }));
    expect(canonicalJson(propose([root, ...paired]))).toBe(canonicalJson(propose([...paired, root].reverse())));
    const standaloneIos = propose([file("native/App/Info.plist", "<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>fixture.standalone</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>")]);
    expect(standaloneIos.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(1);

  });

  it("retains distinct PBX application targets associated with one framework-owned plist", () => {
    const multiTargetProject = pbx("iphoneos", "fixture.multi")
      .replace("targets = (DDDDDDDDDDDDDDDDDDDDDDDD,);", "targets = (DDDDDDDDDDDDDDDDDDDDDDDD, GGGGGGGGGGGGGGGGGGGGGGGGGG,);")
      .replace("};\nEEEEEEEEEEEEEEEEEEEEEEEE =", "};\nGGGGGGGGGGGGGGGGGGGGGGGGGG = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; buildPhases = (); buildRules = (); dependencies = (); name = AppVariant; productName = AppVariant; productType = \"com.apple.product-type.application\"; };\nEEEEEEEEEEEEEEEEEEEEEEEE =");
    const files = [
      file("ios/App/Info.plist", plist("fixture.multi")),
      file("ios/App.xcodeproj/project.pbxproj", multiTargetProject),
      file("package.json", JSON.stringify({ name: "native-shell", dependencies: { "react-native": "1" } })),
    ];
    const proposal = propose(files);
    const iosTargets = proposal.targets.filter((target) => target.kind === "mobile" && target.os === "ios");
    expect(iosTargets).toHaveLength(3);
    expect(new Set(iosTargets.map((target) => target.targetId)).size).toBe(3);
    expect(new Set(iosTargets.map((target) => target.applicationId)).size).toBe(1);
    expect(iosTargets.every((target) => proposal.applications.some((application) => application.applicationId === target.applicationId && application.sourcePaths.includes("ios/App.xcodeproj/project.pbxproj")))).toBe(true);
    expect(iosTargets.filter((target) => target.targetId.startsWith("apple-target-"))).toHaveLength(2);
    expect(proposal.missingInputs.filter((input) => input.inputId.startsWith("native-association-") && input.targetIds.length === 1)).toHaveLength(2);
  });

  it("preserves unrelated same-bundle projects as distinct applications", () => {
    const twoProjects = [
      file("ios/One/App/Info.plist", plist("fixture.same")), file("ios/One/App.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.same")),
      file("ios/Two/App/Info.plist", plist("fixture.same")), file("ios/Two/App.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.same")),
    ];
    const separate = propose(twoProjects);
    expect(separate.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(2);
    expect(new Set(separate.targets.filter((target) => target.kind === "mobile").map((target) => target.applicationId)).size).toBe(2);

  });

  it("recognizes corroborated macOS metadata and leaves unclassified plist metadata unresolved", () => {
    const mac = propose([file("mac/App/Info.plist", plist("fixture.mac", "MacOSX")), file("mac/App.xcodeproj/project.pbxproj", pbx("macosx", "fixture.mac"))]);
    expect(mac.targets.filter((target) => target.kind === "desktop" && target.os === "macos")).toHaveLength(1);
    const unknown = propose([file("unknown/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.unknown</string></dict></plist>")]);
    expect(unknown.targets.some((target) => target.kind === "mobile" || target.kind === "desktop")).toBe(false);
    expect(unknown.missingInputs.some((input) => input.sourcePaths.includes("unknown/Info.plist"))).toBe(true);
    const contradictory = propose([
      file("ios/App/Info.plist", plist("fixture.conflict", "MacOSX")),
      file("ios/Conflict.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.conflict")),
    ]);
    expect(contradictory.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(0);
    expect(contradictory.targets.filter((target) => target.kind === "desktop" && target.os === "macos")).toHaveLength(0);
    expect(contradictory.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("ios/Conflict.xcodeproj/project.pbxproj"))).toBe(true);
    const malformed = propose([
      file("ios/App/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.broken</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>"),
      file("ios/Broken.xcodeproj/project.pbxproj", "{ rootObject = MISSING; objects = {}; }"),
    ]);
    expect(malformed.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("ios/Broken.xcodeproj/project.pbxproj"))).toBe(true);
  });
});
