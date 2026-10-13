import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, canonicalJson, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: hash(text), kind: "blob" as const });
const candidate = createCandidateManifest([{ repositoryId: "fixture/fix4", commitSha: "d".repeat(40), treeSha: "e".repeat(40) }]);
const snapshot = (files: ReturnType<typeof file>[]): E2ESourceSnapshot => ({ candidate, commitSha: "d".repeat(40), treeSha: "e".repeat(40), treeComplete: true, treePaths: files.map((item) => item.path), sources: files });
const rootWeb = () => file("package.json", JSON.stringify({ name: "root-workspace", private: true, workspaces: ["apps/*"], scripts: { start: "vite" } }));
const mobile = (directory: string) => file(`${directory}/package.json`, JSON.stringify({ name: `@fixture/${directory.replaceAll("/", "-")}`, dependencies: { "react-native": "1" } }));
const plist = (id: string) => `<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`;
const inspect = (files: ReturnType<typeof file>[]) => inspectE2ERepository(snapshot(files), candidate).inspection;

describe("Task2A review fix4 ownership corrections", () => {
  it("assigns one-component app roots deeper than root regardless of inventory order", () => {
    for (const appRoot of ["m", "mobile"]) {
      const childFiles = [mobile(appRoot), file(`${appRoot}/ios/App/Info.plist`, plist(`fixture.${appRoot}`))];
      const rootFirst = inspect([rootWeb(), ...childFiles]);
      const rootLast = inspect([...childFiles, rootWeb()]);
      for (const result of [rootFirst, rootLast]) {
        const target = result.proposedTargets.find((item) => item.kind === "mobile" && item.os === "ios");
        expect(target?.applicationId).toBe(`@fixture/${appRoot}`);
        expect(result.applications.find((item) => item.applicationId === target?.applicationId)?.sourcePaths).toContain(`${appRoot}/ios/App/Info.plist`);
        expect(result.missingInputs.some((item) => /no native platform manifest/.test(item.reason))).toBe(false);
      }
      expect(canonicalJson(rootFirst.proposedTargets)).toBe(canonicalJson(rootLast.proposedTargets));
      expect(canonicalJson(rootFirst.missingInputs)).toBe(canonicalJson(rootLast.missingInputs));
    }
  });

  it("uses component depth and stable ownership for nested and equal-depth packages", () => {
    const sources = [
      rootWeb(), mobile("a/m"), file("a/m/ios/App/Info.plist", plist("fixture.short")),
      mobile("a/mobile"), file("a/mobile/ios/App/Info.plist", plist("fixture.long")),
      mobile("apps/one"), file("apps/one/ios/App/Info.plist", plist("fixture.one")),
      mobile("apps/two"), file("apps/two/ios/App/Info.plist", plist("fixture.two")),
      mobile("apps/one/nested"), file("apps/one/nested/ios/App/Info.plist", plist("fixture.nested")),
    ];
    const forward = inspect(sources);
    const reverse = inspect([...sources].reverse());
    expect(canonicalJson(forward.proposedTargets)).toBe(canonicalJson(reverse.proposedTargets));
    expect(canonicalJson(forward.applications)).toBe(canonicalJson(reverse.applications));
    for (const [id, name] of [["fixture.short", "@fixture/a-m"], ["fixture.long", "@fixture/a-mobile"], ["fixture.one", "@fixture/apps-one"], ["fixture.two", "@fixture/apps-two"], ["fixture.nested", "@fixture/apps-one-nested"]]) {
      const target = forward.proposedTargets.filter((item) => item.kind === "mobile").find((item) => item.appId === id);
      expect(forward.applications.find((app) => app.applicationId === target?.applicationId)?.applicationId).toBe(name);
    }
  });

  it("retains native desktop project identity and runtime gap beside a root web workspace", () => {
    const project = file("apps/mac/App.xcodeproj/project.pbxproj", "PBXProject = { rootObject = A; };");
    const standalone = inspect([project]);
    const withRootFirst = inspect([rootWeb(), project]);
    const withRootLast = inspect([project, rootWeb()]);
    for (const result of [standalone, withRootFirst, withRootLast]) {
      expect(result.proposedTargets.some((item) => item.kind === "desktop" && item.os === "macos" && item.driver === "native")).toBe(true);
      expect(result.missingInputs.some((item) => item.kind === "runtime" && /native build and launch profile/.test(item.reason))).toBe(true);
    }
    expect(withRootFirst.proposedTargets.some((item) => item.kind === "web")).toBe(true);
    expect(withRootFirst.applications.find((item) => item.kind === "web")?.sourcePaths).not.toContain(project.path);
    expect(canonicalJson(withRootFirst.proposedTargets)).toBe(canonicalJson(withRootLast.proposedTargets));
    expect(canonicalJson(withRootFirst.missingInputs)).toBe(canonicalJson(withRootLast.missingInputs));
    expect(canonicalJson(withRootFirst.applications)).toBe(canonicalJson(withRootLast.applications));
  });

  it("retains Gradle-only project metadata as unresolved identity, with or without a root workspace", () => {
    const gradleOnly = file("apps/native/android/app/build.gradle.kts", "plugins { id(\"com.android.application\") }");
    for (const files of [[gradleOnly], [rootWeb(), gradleOnly], [gradleOnly, rootWeb()]] as ReturnType<typeof file>[][]) {
      const result = inspect(files);
      expect(result.applications.some((item) => item.kind === "mobile" && item.sourcePaths.includes(gradleOnly.path))).toBe(true);
      expect(result.missingInputs.some((item) => item.kind === "target-selection" && /no resolvable application identifier/.test(item.reason) && item.sourcePaths.includes(gradleOnly.path))).toBe(true);
      expect(result.proposedTargets.some((item) => item.kind === "mobile" && item.appId === "fixture.gradle")).toBe(false);
    }
    const matched = inspect([
      file("android/app/build.gradle", "plugins { id 'com.android.application' }"),
      file("android/app/src/main/AndroidManifest.xml", '<manifest package="fixture.gradle"><application /></manifest>'),
    ]);
    expect(matched.proposedTargets.filter((item) => item.kind === "mobile" && item.os === "android")).toHaveLength(1);
    expect(matched.proposedTargets.filter((item) => item.kind === "mobile").find((item) => item.os === "android")?.appId).toBe("fixture.gradle");

    const siblingGradle = inspect([
      file("android/One/build.gradle", "plugins { id 'com.android.application' }"),
      file("android/Two/build.gradle.kts", "plugins { id(\"com.android.application\") }"),
    ]);
    expect(siblingGradle.applications.filter((item) => item.kind === "mobile")).toHaveLength(2);
    expect(siblingGradle.missingInputs.filter((item) => item.kind === "target-selection" && /no resolvable application identifier/.test(item.reason))).toHaveLength(2);
  });

  it("keeps a native Xcode project under a declared mobile framework with that mobile app", () => {
    const sources = [
      mobile("apps/rn"),
      file("apps/rn/ios/App/Info.plist", plist("fixture.rn")),
      file("apps/rn/ios/App.xcodeproj/project.pbxproj", "PBXProject = { rootObject = A; };")
    ];
    const result = inspect(sources);
    expect(result.applications.filter((item) => item.kind === "mobile")).toHaveLength(1);
    expect(result.proposedTargets.filter((item) => item.kind === "mobile" && item.os === "ios")).toHaveLength(1);
    expect(result.proposedTargets.some((item) => item.kind === "desktop" && item.os === "macos")).toBe(false);
    const unresolved = inspect([mobile("apps/unresolved"), file("apps/unresolved/ios/App.xcodeproj/project.pbxproj", "PBXProject = { rootObject = A; };")]);
    expect(unresolved.proposedTargets.some((item) => item.kind === "desktop")).toBe(false);
    expect(unresolved.missingInputs.some((item) => item.kind === "target-selection" && /no native platform manifest/.test(item.reason))).toBe(true);
  });
});
