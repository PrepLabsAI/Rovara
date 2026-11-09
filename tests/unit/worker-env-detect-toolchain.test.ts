// Setup and test health SH32: the toolchain the sandbox's base image lacks is added by a proposed dev container, at the smallest listed version that satisfies the repository's own minimum, cited; Node and
// Python (already in the base image) get none; a version that cannot be found or is not offered is a question; a repository's own dev container is used, never replaced.
import { describe, expect, it } from "vitest";
import { DEVCONTAINER_PATH_PATTERN, SETUP_DEVCONTAINER_MAX_BYTES } from "@agentx/contracts";
import { ENV_DETECT_MAX_PATHS, boundedReader } from "../../packages/worker/src/env-detect/index.js";
import { BASE_IMAGE_LANGUAGES, DEVCONTAINER_IMAGE_VERSIONS, proposeToolchain } from "../../packages/worker/src/env-detect/toolchain.js";

type Files = Record<string, string>;
const propose = (files: Files, options?: { baseLanguages?: readonly string[] }) => proposeToolchain(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader, options);
const GO_MOD = (version: string): string => `module example.com/acme/match\n\ngo ${version}\n`;
const pom = (java: string): string => `<project>\n  <properties>\n    <maven.compiler.release>${java}</maven.compiler.release>\n  </properties>\n</project>\n`;
const MVNW: Files = { mvnw: "", ".mvn/wrapper/maven-wrapper.properties": "" };
const GRADLEW: Files = { gradlew: "", "gradle/wrapper/gradle-wrapper.properties": "", "gradle/wrapper/gradle-wrapper.jar": "" };

/** What the dev container item's own reader requires of a proposed file (setup-proposal-read.ts): a path in the pattern, a JSON object within the byte cap, no control characters or code fence. */
function acceptable(result: Awaited<ReturnType<typeof propose>>): Record<string, unknown> {
  const container = result.devcontainer!;
  expect(DEVCONTAINER_PATH_PATTERN.test(container.configPath)).toBe(true);
  const text = container.proposedContent!;
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(SETUP_DEVCONTAINER_MAX_BYTES);
  expect(text.trimStart().startsWith("{")).toBe(true);
  expect(text.includes("```")).toBe(false);
  expect(/[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\t]/gu, ""))).toBe(false);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Go", () => {
  it("proposes the Go dev container image at the smallest listed version that satisfies go.mod, citing the go line", async () => {
    const result = await propose({ "go.mod": GO_MOD("1.22.3"), "a.go": "" });
    expect(result.devcontainer).toMatchObject({ configPath: ".devcontainer/devcontainer.json", exists: false, from: [{ path: "go.mod", line: 3 }, "detector:toolchain"] });
    expect(acceptable(result)).toEqual({ name: "Go 1.25 for tests", image: "mcr.microsoft.com/devcontainers/go:1.25-bookworm" });
    expect(result.notes.join(" ")).toContain("go.mod line 3");
    expect(result.notes.join(" ")).toContain("pull request a person approves");
    expect(result.questions).toEqual([]);
  });
  it("keeps the exact listed version when go.mod asks for it, and a newer patch of it", async () => {
    expect(acceptable(await propose({ "go.mod": GO_MOD("1.26"), "a.go": "" }))["image"]).toBe("mcr.microsoft.com/devcontainers/go:1.26-bookworm");
    expect(acceptable(await propose({ "go.mod": GO_MOD("1.27.4"), "a.go": "" }))["image"]).toBe("mcr.microsoft.com/devcontainers/go:1.27-bookworm");
  });
  it("proposes nothing and asks when go.mod asks for a Go newer than any listed image", async () => {
    const result = await propose({ "go.mod": GO_MOD("1.99"), "a.go": "" });
    expect(result.devcontainer).toBeUndefined();
    expect(result.notes.join(" ")).toContain("go.mod line 3");
    expect(result.questions.join(" ")).toContain("Go 1.99");
  });
  it("proposes nothing and asks when no version can be read", async () => {
    for (const files of [{ "go.mod": "module m\n", "a.go": "" }, { "go.mod": "module m\ngo $(x)\n", "a.go": "" }, { "svc/go.mod": GO_MOD("1.22"), "svc/a.go": "" }]) {
      const result = await propose(files);
      expect(result.devcontainer, JSON.stringify(Object.keys(files))).toBeUndefined();
      expect(result.questions.join(" ")).toContain("Which Go version");
    }
  });
  it("reads the version from go.work when there is one", async () => {
    const result = await propose({ "go.work": "go 1.26\nuse .\n", "go.mod": GO_MOD("1.22"), "a.go": "" });
    expect(result.devcontainer?.from[0]).toEqual({ path: "go.work", line: 1 });
    expect(acceptable(result)["image"]).toBe("mcr.microsoft.com/devcontainers/go:1.26-bookworm");
  });
});

describe("Java", () => {
  it("proposes the JDK image and the Java feature's Maven when there is no Maven wrapper, citing the pom line", async () => {
    const result = await propose({ "pom.xml": pom("17"), "src/main/java/A.java": "" });
    expect(result.devcontainer?.from[0]).toEqual({ path: "pom.xml", line: 3 });
    expect(acceptable(result)).toEqual({
      name: "Java 17 for tests", image: "mcr.microsoft.com/devcontainers/java:17-bookworm",
      features: { "ghcr.io/devcontainers/features/java:1": { version: "none", installMaven: true, installGradle: false } },
    });
    expect(result.notes.join(" ")).toContain("no maven wrapper");
  });
  it("adds no build tool when the wrapper is complete, and installs Gradle when it is not", async () => {
    expect(acceptable(await propose({ "pom.xml": pom("21"), ...MVNW }))).toEqual({ name: "Java 21 for tests", image: "mcr.microsoft.com/devcontainers/java:21-bookworm" });
    expect(acceptable(await propose({ "build.gradle": "java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n", ...GRADLEW }))).toEqual({ name: "Java 21 for tests", image: "mcr.microsoft.com/devcontainers/java:21-bookworm" });
    const noWrapper = acceptable(await propose({ "build.gradle.kts": "// JavaLanguageVersion.of(8)\nsourceCompatibility = '17'\n" }));
    expect(noWrapper["features"]).toEqual({ "ghcr.io/devcontainers/features/java:1": { version: "none", installMaven: false, installGradle: true } });
    expect(noWrapper["image"]).toBe("mcr.microsoft.com/devcontainers/java:17-bookworm");
  });
  it("reads Java 8 as 1.8 or 8, and takes the smallest listed JDK that satisfies it", async () => {
    expect(acceptable(await propose({ "pom.xml": pom("1.8"), ...MVNW }))["image"]).toBe("mcr.microsoft.com/devcontainers/java:11-bookworm");
    expect(acceptable(await propose({ "pom.xml": pom("8"), ...MVNW }))["image"]).toBe("mcr.microsoft.com/devcontainers/java:11-bookworm");
    expect(acceptable(await propose({ "pom.xml": pom("22"), ...MVNW }))["image"]).toBe("mcr.microsoft.com/devcontainers/java:25-bookworm");
    expect(acceptable(await propose({ "build.gradle": "sourceCompatibility = JavaVersion.VERSION_1_8\n", ...GRADLEW }))["image"]).toBe("mcr.microsoft.com/devcontainers/java:11-bookworm");
  });
  it("asks when the version is not in the files, is commented out, or is newer than any listed image", async () => {
    for (const files of [{ "pom.xml": "<project/>", ...MVNW }, { "pom.xml": `<project><!-- <java.version>17</java.version> --></project>` }, { "build.gradle": "plugins { id 'java' }\n" }, { "pom.xml": pom("99"), ...MVNW }, { "backend/pom.xml": pom("17"), "backend/A.java": "" }]) {
      const result = await propose(files);
      expect(result.devcontainer, JSON.stringify(Object.keys(files))).toBeUndefined();
      expect(result.questions.join(" ")).toMatch(/Java/u);
    }
  });
  it("proposes the JDK with no build tool when both Maven and Gradle are there (the Java detector asks which)", async () => {
    const result = await propose({ "pom.xml": pom("17"), "build.gradle": "" });
    expect(acceptable(result)["features"]).toBeUndefined();
  });
});

describe("what is not proposed", () => {
  it("proposes nothing for Node and Python, which the base image carries", async () => {
    for (const files of [{ "package.json": "{}", "package-lock.json": "{}", "src/a.ts": "" }, { "pyproject.toml": "[project]\n", "app.py": "" }, {}]) {
      expect(await propose(files)).toEqual({ notes: [], questions: [] });
    }
    expect(BASE_IMAGE_LANGUAGES).toEqual(["node", "python"]);
  });
  it("proposes nothing for a language the caller says the image already has", async () => {
    expect(await propose({ "go.mod": GO_MOD("1.22"), "a.go": "" }, { baseLanguages: ["node", "python", "go"] })).toEqual({ notes: [], questions: [] });
  });
  it("uses the repository's own dev container and asks only when it does not name the language", async () => {
    const named = await propose({ "go.mod": GO_MOD("1.22"), "a.go": "", ".devcontainer/devcontainer.json": '{ "image": "mcr.microsoft.com/devcontainers/go:1.22" }' });
    expect(named.devcontainer).toEqual({ configPath: ".devcontainer/devcontainer.json", exists: true, from: [{ path: ".devcontainer/devcontainer.json", line: 1 }] });
    expect(named.devcontainer).not.toHaveProperty("proposedContent");
    expect(named.questions).toEqual([]);
    const silent = await propose({ "pom.xml": pom("17"), ".devcontainer.json": '{ "image": "ubuntu" }' });
    expect(silent.devcontainer).toMatchObject({ configPath: ".devcontainer.json", exists: true });
    expect(silent.questions.join(" ")).toContain("Does the dev container in .devcontainer.json provide Java");
    const nestedOne = await propose({ "go.mod": GO_MOD("1.22"), "a.go": "", ".devcontainer/go/devcontainer.json": "{}" });
    expect(nestedOne.devcontainer?.configPath).toBe(".devcontainer/go/devcontainer.json");
  });
  it("proposes none when the file list was cut at the limit, because an existing dev container could be hidden", async () => {
    const files: Files = { "go.mod": GO_MOD("1.22"), "a.go": "" };
    for (let n = 0; n < ENV_DETECT_MAX_PATHS; n += 1) files[`src/f${String(n)}.txt`] = "";
    const cut = await proposeToolchain(boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader);
    expect(cut.devcontainer).toBeUndefined();
    expect(cut.notes.join(" ")).toContain("more files than Rovara reads");
    expect(cut.questions.join(" ")).toContain("already have a dev container");
    expect((await propose({ "go.mod": GO_MOD("1.22"), "a.go": "" })).devcontainer).toBeDefined();
  });
  it("proposes one container for the first language and asks about the second", async () => {
    const result = await propose({ "go.mod": GO_MOD("1.22"), "a.go": "", "pom.xml": pom("17"), ...MVNW });
    expect(acceptable(result)["image"]).toBe("mcr.microsoft.com/devcontainers/go:1.25-bookworm");
    expect(result.questions.join(" ")).toContain("also needs Java");
  });
  it("recognises other languages by a build file plus a source file, asks about them and proposes no image", async () => {
    const rust = await propose({ "Cargo.toml": "", "src/lib.rs": "" });
    expect(rust.devcontainer).toBeUndefined();
    expect(rust.notes.join(" ")).toContain("Rust");
    expect(rust.questions.join(" ")).toContain("Which Rust version");
    expect(await propose({ "Cargo.toml": "" })).toEqual({ notes: [], questions: [] });
    expect(await propose({ Gemfile: "", "package.json": "{}" })).toEqual({ notes: [], questions: [] });
    expect((await propose({ "app.sln": "", "Program.cs": "" })).questions.join(" ")).toContain(".NET");
  });
  it("lists only image versions Rovara has read from the images' own pages", () => {
    expect(DEVCONTAINER_IMAGE_VERSIONS).toEqual({ go: ["1.25", "1.26", "1.27"], java: ["11", "17", "21", "25"] });
  });
});
