import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: hash(text), kind: "blob" as const });
const candidate = createCandidateManifest([{ repositoryId: "fixture/native-inventory", commitSha: "b".repeat(40), treeSha: "c".repeat(40) }]);
const snapshot = (files: ReturnType<typeof file>[]): E2ESourceSnapshot => ({ candidate, commitSha: "b".repeat(40), treeSha: "c".repeat(40), treeComplete: true, treePaths: files.map(({ path }) => path), sources: files });
const inspect = (files: ReturnType<typeof file>[]) => inspectE2ERepository(snapshot(files), candidate).inspection;

const plist = `<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>fixture.app</string></dict></plist>`;
const pbxProject = (targetRefs: string, configurations: string, targetDefinitions: string, configDefinitions: string) => `{
  objects = {
    P = { isa = PBXProject; targets = (${targetRefs}); };
    ${targetDefinitions}
    ${configurations}
    ${configDefinitions}
  };
  rootObject = P;
}`;
const nativeTarget = (ref: string, configList = "L") => `${ref} = { isa = PBXNativeTarget; productType = "com.apple.product-type.application"; buildConfigurationList = ${configList}; };`;
const configurationList = (refs: string) => `L = { isa = XCConfigurationList; buildConfigurations = (${refs}); };`;
const configuration = (ref: string, settings: string) => `${ref} = { isa = XCBuildConfiguration; buildSettings = { ${settings} }; };`;
const completeSettings = `SDKROOT = iphoneos; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; PRODUCT_BUNDLE_IDENTIFIER = fixture.app; INFOPLIST_FILE = "App/Info.plist";`;
const pairedFiles = (project: string) => [
  file("App/Info.plist", plist),
  file("App.xcodeproj/project.pbxproj", project),
];

describe("native inventory prerequisite", () => {
  it("retains every distinct proven PBX target and its runtime gap for one shared plist", () => {
    const project = pbxProject(
      "T0, T1",
      configurationList("C"),
      `${nativeTarget("T0")} ${nativeTarget("T1")}`,
      configuration("C", completeSettings),
    );
    const files = pairedFiles(project);
    const forward = inspect(files);
    const reverse = inspect([...files].reverse());
    const reversedTargets = inspect(pairedFiles(project.replace("targets = (T0, T1)", "targets = (T1, T0)")));
    const targets = forward.proposedTargets.filter((target) => target.kind === "mobile" && target.os === "ios");

    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((target) => target.targetId)).size).toBe(2);
    expect(new Set(targets.map((target) => target.applicationId)).size).toBe(1);
    expect(forward.missingInputs.filter((input) => input.kind === "runtime" && input.sourcePaths.includes("App.xcodeproj/project.pbxproj"))).toHaveLength(2);
    expect(forward.proposedTargets).toEqual(reverse.proposedTargets);
    expect(forward.missingInputs).toEqual(reverse.missingInputs);
    expect(forward.proposedTargets).toEqual(reversedTargets.proposedTargets);
    expect(forward.missingInputs).toEqual(reversedTargets.missingInputs);
  });

  it("keeps same-project targets with different plist and bundle identities distinct", () => {
    const project = `{
      objects = {
        P = { isa = PBXProject; targets = (T0, T1); };
        ${nativeTarget("T0", "L0")}
        ${nativeTarget("T1", "L1")}
        L0 = { isa = XCConfigurationList; buildConfigurations = (C0); };
        L1 = { isa = XCConfigurationList; buildConfigurations = (C1); };
        C0 = { isa = XCBuildConfiguration; name = Debug; buildSettings = { SDKROOT = iphoneos; PRODUCT_BUNDLE_IDENTIFIER = fixture.one; INFOPLIST_FILE = "App/One.plist"; }; };
        C1 = { isa = XCBuildConfiguration; name = Debug; buildSettings = { SDKROOT = iphoneos; PRODUCT_BUNDLE_IDENTIFIER = fixture.two; INFOPLIST_FILE = "App/Two.plist"; }; };
      };
      rootObject = P;
    }`;
    const result = inspect([
      file("App/One.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.one</string></dict></plist>"),
      file("App/Two.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.two</string></dict></plist>"),
      file("App.xcodeproj/project.pbxproj", project),
    ]);
    const targets = result.proposedTargets.filter((target) => target.kind === "mobile" && target.os === "ios");

    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((target) => target.targetId)).size).toBe(2);
    expect(new Set(targets.map((target) => target.applicationId)).size).toBe(2);
  });

  it("corroborates one preexisting framework target and retains the other PBX target under its owner", () => {
    const project = pbxProject(
      "T0, T1",
      configurationList("C"),
      `${nativeTarget("T0")} ${nativeTarget("T1")}`,
      configuration("C", completeSettings),
    );
    const inputs = [
      file("package.json", JSON.stringify({ name: "native-shell", dependencies: { "react-native": "1" } })),
      file("ios/App/Info.plist", plist),
      file("ios/App.xcodeproj/project.pbxproj", project),
    ];
    const result = inspect(inputs);
    const targets = result.proposedTargets.filter((target) => target.kind === "mobile" && target.os === "ios");
    const ownerIds = new Set(targets.map((target) => target.applicationId));

    expect(targets).toHaveLength(2);
    expect(ownerIds).toHaveLength(1);
    expect(result.applications.find((application) => application.applicationId === targets[0]?.applicationId)?.sourcePaths).toContain("ios/App.xcodeproj/project.pbxproj");
    expect(result.missingInputs.filter((input) => input.kind === "runtime" && input.targetIds.some((targetId) => targets.some((target) => target.targetId === targetId)))).toHaveLength(2);
  });

  it("does not infer an Apple platform from an ios directory when plist metadata is generic", () => {
    const generic = "<plist><dict><key>CFBundleIdentifier</key><string>fixture.unproven</string></dict></plist>";

    for (const path of ["ios/App/Info.plist", "macos/App/Info.plist", "renamed/App/Info.plist"]) {
      const result = inspect([file(path, generic)]);
      expect(result.proposedTargets.filter((target) => target.kind === "mobile" || target.kind === "desktop")).toHaveLength(0);
      expect(result.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes(path))).toBe(true);
    }
  });

  it("keeps a missing actual PBX configuration unresolved instead of borrowing sibling facts", () => {
    const project = pbxProject(
      "T0",
      configurationList("C, D"),
      nativeTarget("T0"),
      `${configuration("C", completeSettings)} ${configuration("D", "")}`,
    );
    const result = inspect(pairedFiles(project));

    expect(result.proposedTargets.filter((target) => target.kind === "mobile" || target.kind === "desktop")).toHaveLength(0);
    expect(result.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("App.xcodeproj/project.pbxproj"))).toBe(true);
  });

  it("resolves missing target settings only through the matching project configuration name", () => {
    const project = `{
      objects = {
        P = { isa = PBXProject; buildConfigurationList = PL; targets = (T0); };
        PL = { isa = XCConfigurationList; buildConfigurations = (PC); };
        PC = { isa = XCBuildConfiguration; name = Debug; buildSettings = { ${completeSettings} }; };
        ${nativeTarget("T0")}
        ${configurationList("C")}
        C = { isa = XCBuildConfiguration; name = Debug; buildSettings = {}; };
      };
      rootObject = P;
    }`;
    const result = inspect(pairedFiles(project));

    expect(result.proposedTargets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(1);
    expect(result.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("App.xcodeproj/project.pbxproj"))).toBe(false);

    const externalTargetConfig = project.replace("name = Debug; buildSettings = {};", "name = Debug; baseConfigurationReference = EXTERNAL_XCCONFIG; buildSettings = {};");
    const external = inspect(pairedFiles(externalTargetConfig));
    expect(external.proposedTargets.filter((target) => target.kind === "mobile" || target.kind === "desktop")).toHaveLength(0);
    expect(external.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("App.xcodeproj/project.pbxproj"))).toBe(true);

    const externalProjectConfig = project.replace("PC = { isa = XCBuildConfiguration;", "PC = { isa = XCBuildConfiguration; baseConfigurationReference = PROJECT_XCCONFIG;");
    const projectExternal = inspect(pairedFiles(externalProjectConfig));
    expect(projectExternal.proposedTargets.filter((target) => target.kind === "mobile" || target.kind === "desktop")).toHaveLength(0);
    expect(projectExternal.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("App.xcodeproj/project.pbxproj"))).toBe(true);

    const duplicateProjectConfigs = project.replace("buildConfigurations = (PC);", "buildConfigurations = (PC, PD);").replace(
      "      };\n      rootObject = P;",
      "        PD = { isa = XCBuildConfiguration; name = Debug; buildSettings = {}; };\n      };\n      rootObject = P;",
    );
    const duplicateName = inspect(pairedFiles(duplicateProjectConfigs));
    expect(duplicateName.proposedTargets.filter((target) => target.kind === "mobile" || target.kind === "desktop")).toHaveLength(0);
    expect(duplicateName.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("App.xcodeproj/project.pbxproj"))).toBe(true);
  });

  it("rejects duplicate source-target references visibly", () => {
    const project = pbxProject(
      "T0, T0",
      configurationList("C"),
      nativeTarget("T0"),
      configuration("C", completeSettings),
    );
    const result = inspect(pairedFiles(project));

    expect(result.proposedTargets.filter((target) => target.kind === "mobile" || target.kind === "desktop")).toHaveLength(0);
    expect(result.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("App.xcodeproj/project.pbxproj"))).toBe(true);
  });
});
