// Proof and test environment E2 (Java): the Maven and Gradle detector. Commands prefer the project's wrapper, report and coverage locations are cited, and a multi-module or ambiguous build is listed or asked about, never guessed.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema } from "@rovara-code/contracts";
import { boundedReader, buildEnvironmentDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "service");
}
const pom = (body: string, head = ""): string => ["<project>", "  <modelVersion>4.0.0</modelVersion>", head, "  <build>", "    <plugins>", body, "    </plugins>", "  </build>", "</project>", ""].join("\n");
const plugin = (artifactId: string, config = ""): string => `      <plugin>\n        <artifactId>${artifactId}</artifactId>\n${config}      </plugin>`;
const TEST_FILE: Files = { "src/test/java/com/acme/MatchTest.java": "class MatchTest {}\n" };
const MAVEN_WRAPPER: Files = { mvnw: "#!/bin/sh\n", ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.zip\n" };
const GRADLE_WRAPPER: Files = { gradlew: "#!/bin/sh\n", "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip\n", "gradle/wrapper/gradle-wrapper.jar": "" };
const byId = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.checks.find((check) => check.value.id === id);

describe("Maven", () => {
  it("proposes the wrapper's commands and the Surefire default report location, each with where it came from", async () => {
    const detection = await detect({ "pom.xml": pom(plugin("maven-surefire-plugin")), ...MAVEN_WRAPPER, ...TEST_FILE });
    expect(detection.setupCommands.map((item) => [item.value.executable, item.value.args, item.source])).toEqual([["./mvnw", ["-B", "test-compile"], { path: "pom.xml", line: 1 }]]);
    const unit = byId(detection, "unit")!;
    expect(unit.value).toMatchObject({ kind: "test", reportPath: "target/surefire-reports", command: { cwd: "service", executable: "./mvnw", args: ["-B", "test"], timeoutSeconds: 1_800 } });
    expect(unit.value.selectArgs).toBeUndefined();
    expect(unit.source).toEqual({ path: "pom.xml", line: 7 });
    expect(unit.value.reportSource).toBe("detector:java");
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["pom.xml", "mvnw", ".mvn/**"]));
    expect(detection.notes.join(" ")).toContain("Surefire");
    expect(detection.notes.join(" ")).toContain("no per-test selection");
  });
  it("uses mvn when there is no wrapper, or the wrapper script has no properties file to run with", async () => {
    const plain = await detect({ "pom.xml": pom(""), ...TEST_FILE });
    expect(plain.checks[0]?.value.command.executable).toBe("mvn");
    const broken = await detect({ "pom.xml": pom(""), mvnw: "#!/bin/sh\n", ...TEST_FILE });
    expect(broken.checks[0]?.value.command.executable).toBe("mvn");
    expect(broken.notes.join(" ")).toContain("wrapper script");
  });
  it("reads a literal reportsDirectory from the build's own Surefire configuration and cites its line", async () => {
    const detection = await detect({ "pom.xml": pom(plugin("maven-surefire-plugin", "        <configuration>\n          <reportsDirectory>${project.build.directory}/junit-out</reportsDirectory>\n        </configuration>\n")), ...TEST_FILE });
    const unit = byId(detection, "unit")!;
    expect(unit.value.reportPath).toBe("target/junit-out");
    expect(unit.value.reportSource).toEqual({ path: "pom.xml", line: 9 });
  });
  it("ignores a reportsDirectory it cannot resolve to a safe relative path", async () => {
    for (const dir of ["${some.property}/out", "/abs/out", "../escape", "a b"]) {
      const detection = await detect({ "pom.xml": pom(plugin("maven-surefire-plugin", `        <configuration><reportsDirectory>${dir}</reportsDirectory></configuration>\n`)), ...TEST_FILE });
      expect(byId(detection, "unit")?.value.reportPath, dir).toBe("target/surefire-reports");
    }
  });
  it("adds an integration check with the Failsafe report location when Failsafe is configured", async () => {
    const detection = await detect({ "pom.xml": pom(plugin("maven-failsafe-plugin")), ...TEST_FILE });
    expect(byId(detection, "unit")?.value.command.args).toEqual(["-B", "test"]);
    const integration = byId(detection, "integration")!;
    expect(integration.value).toMatchObject({ kind: "test", reportPath: "target/failsafe-reports", command: { args: ["-B", "verify"] } });
    expect(integration.source).toEqual({ path: "pom.xml", line: 7 });
    expect(detection.notes.join(" ")).toContain("runs the unit tests again");
  });
  it("proposes JaCoCo coverage only when the build binds its report goal, and runs verify when the report comes after the test phase", async () => {
    const report = (phase = "") => plugin("jacoco-maven-plugin", `        <executions><execution>\n          <goals><goal>report</goal></goals>\n${phase}        </execution></executions>\n`);
    const late = await detect({ "pom.xml": pom(report()), ...TEST_FILE });
    const unit = byId(late, "unit")!;
    expect(unit.value).toMatchObject({ coveragePath: "target/site/jacoco/jacoco.xml", command: { args: ["-B", "verify"] } });
    expect(unit.value.coverageSource).toEqual({ path: "pom.xml", line: 9 });
    const early = await detect({ "pom.xml": pom(report("          <phase>test</phase>\n")), ...TEST_FILE });
    expect(byId(early, "unit")?.value).toMatchObject({ coveragePath: "target/site/jacoco/jacoco.xml", command: { args: ["-B", "test"] } });
    const prepareOnly = await detect({ "pom.xml": pom(plugin("jacoco-maven-plugin", "        <executions><execution><goals><goal>prepare-agent</goal></goals></execution></executions>\n")), ...TEST_FILE });
    expect(byId(prepareOnly, "unit")?.value.coveragePath).toBeUndefined();
    expect(prepareOnly.notes.join(" ")).toContain("JaCoCo is configured but the build does not write an XML report");
  });
  it("proposes nothing from a plugin that is only managed, in a profile, or commented out", async () => {
    const text = [
      "<project>", "<!-- <plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin> -->",
      "<build><pluginManagement><plugins><plugin><artifactId>maven-pmd-plugin</artifactId></plugin></plugins></pluginManagement></build>",
      "<profiles><profile><build><plugins><plugin><artifactId>spotless-maven-plugin</artifactId></plugin></plugins></build></profile></profiles>", "</project>", "",
    ].join("\n");
    const detection = await detect({ "pom.xml": text, ...TEST_FILE });
    expect(detection.checks.map((check) => check.value.id)).toEqual(["unit"]);
  });
  it("proposes the lint and static-analysis goals the build configures", async () => {
    const detection = await detect({ "pom.xml": pom([plugin("maven-checkstyle-plugin"), plugin("spotbugs-maven-plugin"), plugin("maven-pmd-plugin"), plugin("spotless-maven-plugin")].join("\n")), ...TEST_FILE });
    expect(detection.checks.filter((check) => check.value.kind === "lint").map((check) => [check.value.id, check.value.command.args])).toEqual([
      ["checkstyle", ["-B", "checkstyle:check"]], ["spotbugs", ["-B", "compile", "spotbugs:check"]], ["pmd", ["-B", "pmd:check"]], ["spotless", ["-B", "spotless:check"]],
    ]);
  });
  it("lists the modules and proposes root commands without a single report path", async () => {
    const detection = await detect({ "pom.xml": pom(plugin("jacoco-maven-plugin", "        <executions><execution><goals><goal>report</goal></goals></execution></executions>\n"), "  <modules>\n    <module>api</module>\n    <module>core</module>\n  </modules>"), "api/pom.xml": "<project/>", "core/pom.xml": "<project/>", "api/src/test/java/ApiTest.java": "" });
    const unit = byId(detection, "unit")!;
    expect(unit.value.command.args).toEqual(["-B", "test"]);
    expect(unit.value.reportPath).toBeUndefined();
    expect(unit.value.coveragePath).toBeUndefined();
    expect(detection.notes.join(" ")).toContain("2 modules: api, core");
    expect(detection.notes.join(" ")).toContain("one report path cannot cover them");
    expect(detection.fullSuiteOn.map((item) => item.value)).toContain("**/pom.xml");
  });
  it("lists at most 20 modules and says how many more there are", async () => {
    const modules = Array.from({ length: 30 }, (_, index) => `    <module>m${String(index)}</module>`).join("\n");
    const detection = await detect({ "pom.xml": pom("", `  <modules>\n${modules}\n  </modules>`), ...TEST_FILE });
    expect(detection.notes.join(" ")).toContain("30 modules: m0, m1");
    expect(detection.notes.join(" ")).toContain("and 10 more");
    expect(detection.notes.join(" ")).not.toContain("m25");
  });
  it("notes the Java version the build asks for", async () => {
    const detection = await detect({ "pom.xml": pom("", "  <properties>\n    <maven.compiler.release>21</maven.compiler.release>\n  </properties>"), ...TEST_FILE });
    expect(detection.notes.join(" ")).toContain("Java 21 (pom.xml line 4)");
  });
  it("proposes no test check, and says so, when the repository has no Java tests", async () => {
    const detection = await detect({ "pom.xml": pom(""), "src/main/java/App.java": "" });
    expect(detection.checks).toEqual([]);
    expect(detection.setupCommands).toHaveLength(1);
    expect(detection.notes.join(" ")).toContain("No Java test sources were found");
  });
  it("copes with a pom.xml that cannot be read", async () => {
    const bounded = boundedReader(["pom.xml"], () => Promise.resolve(undefined));
    const detection = await runDetectors(bounded.reader, "service");
    expect(detection.notes).toContain("pom.xml could not be read.");
    expect(detection.checks).toEqual([]);
  });
});

describe("Gradle", () => {
  it("proposes the wrapper's commands and the default test-results folder, each with where it came from", async () => {
    const detection = await detect({ "build.gradle.kts": 'plugins {\n  java\n}\n', "settings.gradle.kts": 'rootProject.name = "svc"\n', ...GRADLE_WRAPPER, "gradle/libs.versions.toml": "", "gradle.lockfile": "", ...TEST_FILE });
    expect(detection.setupCommands.map((item) => [item.value.executable, item.value.args, item.source])).toEqual([["./gradlew", ["--console=plain", "testClasses"], { path: "build.gradle.kts", line: 1 }]]);
    const unit = byId(detection, "unit")!;
    expect(unit.value).toMatchObject({ kind: "test", reportPath: "build/test-results/test", command: { executable: "./gradlew", args: ["--console=plain", "test"], timeoutSeconds: 1_800 } });
    expect(unit.value.reportSource).toBe("detector:java");
    expect(unit.value.selectArgs).toBeUndefined();
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["build.gradle.kts", "settings.gradle.kts", "gradle/wrapper/gradle-wrapper.properties", "gradle.lockfile", "gradle/libs.versions.toml", "gradlew"]));
    expect(detection.notes.join(" ")).toContain("no per-test selection");
  });
  it("uses gradle when there is no wrapper, and reads a Groovy build the same way", async () => {
    const detection = await detect({ "build.gradle": "apply plugin: 'java'\n", ...TEST_FILE });
    expect(detection.checks[0]?.value.command.executable).toBe("gradle");
    expect(detection.checks[0]?.source).toEqual({ path: "build.gradle", line: 1 });
  });
  it("proposes JaCoCo coverage only when the build enables the XML report, and runs the report task unless the build already finishes with it", async () => {
    const enabled = await detect({ "build.gradle": "plugins {\n  id 'jacoco'\n}\njacocoTestReport {\n  reports {\n    xml.required = true\n  }\n}\n", ...TEST_FILE });
    const unit = byId(enabled, "unit")!;
    expect(unit.value).toMatchObject({ coveragePath: "build/reports/jacoco/test/jacocoTestReport.xml", command: { args: ["--console=plain", "test", "jacocoTestReport"] } });
    expect(unit.value.coverageSource).toEqual({ path: "build.gradle", line: 6 });
    const finalized = await detect({ "build.gradle.kts": 'plugins {\n  jacoco\n}\ntasks.test {\n  finalizedBy(tasks.jacocoTestReport)\n}\ntasks.jacocoTestReport {\n  reports { xml.required.set(true) }\n}\n', ...TEST_FILE });
    expect(byId(finalized, "unit")?.value.command.args).toEqual(["--console=plain", "test"]);
    expect(byId(finalized, "unit")?.value.coveragePath).toBe("build/reports/jacoco/test/jacocoTestReport.xml");
    const htmlOnly = await detect({ "build.gradle": "plugins {\n  id 'jacoco'\n}\n", ...TEST_FILE });
    expect(byId(htmlOnly, "unit")?.value.coveragePath).toBeUndefined();
    expect(htmlOnly.notes.join(" ")).toContain("JaCoCo is configured but the build does not write an XML report");
  });
  it("proposes the lint tasks of the plugins the build applies, in every way a plugin is written", async () => {
    const detection = await detect({ "build.gradle": ["plugins {", "  id 'checkstyle'", '  id("com.github.spotbugs") version "5.0.0"', "  pmd", "}", "apply plugin: 'com.diffplug.spotless'", "// id 'jacoco'", ""].join("\n"), ...TEST_FILE });
    expect(detection.checks.filter((check) => check.value.kind === "lint").map((check) => [check.value.id, check.value.command.args.slice(1)])).toEqual([
      ["checkstyle", ["checkstyleMain", "checkstyleTest"]], ["spotbugs", ["spotbugsMain", "spotbugsTest"]], ["pmd", ["pmdMain", "pmdTest"]], ["spotless", ["spotlessCheck"]],
    ]);
    expect(byId(detection, "unit")?.value.coveragePath).toBeUndefined();
    expect(detection.notes.join(" ")).not.toContain("JaCoCo");
  });
  it("adds an integration check for a conventionally named test task, with its own results folder", async () => {
    const detection = await detect({ "build.gradle.kts": 'val integrationTest by tasks.registering(Test::class)\ntasks.register<Test>("integrationTest") {\n}\n', ...TEST_FILE });
    const integration = byId(detection, "integration")!;
    expect(integration.value).toMatchObject({ reportPath: "build/test-results/integrationTest", command: { args: ["--console=plain", "integrationTest"] } });
    expect(integration.source).toEqual({ path: "build.gradle.kts", line: 2 });
  });
  it("lists the modules from include(...) in every spelling, and proposes root commands without a single report path", async () => {
    const detection = await detect({ "settings.gradle": "rootProject.name = 'svc'\ninclude 'api', ':core'\ninclude(\n  \":worker\"\n)\nincludeBuild 'tools'\n", "build.gradle": "", "api/build.gradle": "", "api/src/test/java/ApiTest.java": "" });
    expect(detection.notes.join(" ")).toContain("3 modules: api, core, worker");
    const unit = byId(detection, "unit")!;
    expect(unit.value.reportPath).toBeUndefined();
    expect(unit.value.command.args).toEqual(["--console=plain", "test"]);
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["**/build.gradle", "settings.gradle"]));
  });
  it("does not claim the default results folder when the build moves it", async () => {
    const detection = await detect({ "build.gradle": "test {\n  reports.junitXml.outputLocation = file('out/junit')\n}\n", ...TEST_FILE });
    expect(byId(detection, "unit")?.value.reportPath).toBeUndefined();
    expect(detection.notes.join(" ")).toContain("sets its own test result location");
  });
  it("notes the Java version the build asks for", async () => {
    const detection = await detect({ "build.gradle.kts": "java {\n  toolchain { languageVersion.set(JavaLanguageVersion.of(17)) }\n}\n", ...TEST_FILE });
    expect(detection.notes.join(" ")).toContain("Java 17 (build.gradle.kts line 2)");
  });
});

describe("ambiguous or unusual Java repositories", () => {
  it("asks which build to use, and proposes no command, when Maven and Gradle are both at the top", async () => {
    const detection = await detect({ "pom.xml": pom(""), "build.gradle": "", ...TEST_FILE });
    expect(detection.checks).toEqual([]);
    expect(detection.setupCommands).toEqual([]);
    expect(detection.questions.join(" ")).toContain("both Maven (pom.xml) and Gradle");
  });
  it("asks where the build is when build files are only in subfolders", async () => {
    const detection = await detect({ "backend/pom.xml": pom(""), "backend/src/test/java/A.java": "" });
    expect(detection.checks).toEqual([]);
    expect(detection.questions.join(" ")).toContain("Which folder is the Java build run from");
  });
  it("says nothing about a repository with no Java build", async () => {
    expect(await detect({ "README.md": "hello" })).toMatchObject({ checks: [], setupCommands: [], questions: [], notes: [] });
  });
  it("makes a proposal that passes the environment schema, with the report and coverage citations attached", async () => {
    const detection = await detect({ "pom.xml": pom(plugin("jacoco-maven-plugin", "        <executions><execution><goals><goal>report</goal></goals></execution></executions>\n")), ...MAVEN_WRAPPER, ...TEST_FILE });
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(TestEnvironmentBodySchema.safeParse(draft.environment).success).toBe(true);
    expect(draft.environment.repos[0]?.checks[0]).toMatchObject({ id: "unit", reportPath: "target/surefire-reports", coveragePath: "target/site/jacoco/jacoco.xml" });
    expect(draft.environment.repos[0]?.checks[0]).not.toHaveProperty("reportSource");
    expect(draft.valueSources).toEqual(expect.arrayContaining([
      { field: "repos[0].checks[0].reportPath", source: "detector:java" },
      { field: "repos[0].checks[0].coveragePath", source: { path: "pom.xml", line: 8 } },
    ]));
  });
});

describe("fix round 1: wrapper files and where the wrapper downloads from", () => {
  it("uses gradle, and says why, when gradlew has its properties file but no wrapper jar", async () => {
    const detection = await detect({ "build.gradle": "", gradlew: "", "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip\n", ...TEST_FILE });
    expect(byId(detection, "unit")?.value.command.executable).toBe("gradle");
    expect(detection.notes.join(" ")).toContain("gradle-wrapper.jar");
    const complete = await detect({ "build.gradle": "", ...GRADLE_WRAPPER, ...TEST_FILE });
    expect(byId(complete, "unit")?.value.command.executable).toBe("./gradlew");
    expect(complete.notes.join(" ")).not.toContain("downloads");
  });
  it("names the host the wrapper downloads from when it is not the tool's own, and says nothing for the usual ones", async () => {
    const gradle = await detect({ "build.gradle": "", gradlew: "", "gradle/wrapper/gradle-wrapper.jar": "", "gradle/wrapper/gradle-wrapper.properties": "# wrapper\ndistributionUrl=https\\://downloads.evil.example/gradle-8.zip\n", ...TEST_FILE });
    expect(gradle.notes.join(" ")).toContain("downloads Gradle from downloads.evil.example (gradle/wrapper/gradle-wrapper.properties line 2)");
    const maven = await detect({ "pom.xml": pom(""), mvnw: "", ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=https://repo.maven.apache.org/x.zip\nwrapperUrl=http://mirror.evil.example:8080/maven-wrapper.jar\n", ...TEST_FILE });
    expect(maven.notes.join(" ")).toContain("downloads Maven from mirror.evil.example (.mvn/wrapper/maven-wrapper.properties line 2)");
    expect(maven.notes.join(" ")).not.toContain("repo.maven.apache.org");
    const unreadable = await detect({ "pom.xml": pom(""), mvnw: "", ".mvn/wrapper/maven-wrapper.properties": "distributionUrl=x\n", ...TEST_FILE });
    expect(unreadable.notes.join(" ")).toContain("could not be read as a web address");
  });
});

