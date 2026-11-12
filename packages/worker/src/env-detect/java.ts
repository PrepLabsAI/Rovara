// Java detector: Maven (pom.xml, mvnw) and Gradle (build.gradle[.kts], settings.gradle[.kts], gradlew). Generic: nothing here is specific to one customer or one build host.
// Commands prefer the project's own wrapper (only when its properties file is there too, or the wrapper cannot run). Report and coverage locations come from the build's own configuration (cited with file and line)
// or from the tool's default (cited as `detector:java`); JaCoCo coverage is proposed only when the build writes the XML report. Only the top-level build files are read, so a plugin applied only inside a module is not
// seen. A multi-module build gets root-level commands and a module list but no single report path (each module writes its own). Maven and Gradle together at the top is a question, not a guess.
// No per-test selection is proposed: both tools take one pattern per flag, which the `{tests}` template (one place, separate arguments) cannot express safely, and Rovara never rewrites the customer's command.
import { awsClientCandidate, candidate, isOwnedElsewhere, mergeCandidates, normalizeAwsService, scanDrivers, type DriverRule } from "./dependency-candidates.js";
import { type DependencyCandidate, type Detection, type DetectedSource, type Detector, type DetectorContext, blocksBetween, findLine, lineOf } from "./types.js";

const TIMEOUT = { test: 1_800, integration: 3_600, lint: 600, setup: 900 } as const;
const MAX_MODULES = 20;
const MAVEN_PHASES = ["validate", "initialize", "generate-sources", "process-sources", "generate-resources", "process-resources", "compile", "process-classes", "generate-test-sources", "process-test-sources", "generate-test-resources", "process-test-resources", "test-compile", "process-test-classes", "test", "prepare-package", "package", "pre-integration-test", "integration-test", "post-integration-test", "verify", "install", "deploy"];
const TEST_SOURCE = /(?:^|\/)src\/(?:test|integrationTest|intTest)\/(?:java|kotlin|groovy|scala)\//u;
const SAFE_DIR = /^[A-Za-z0-9_./-]{1,200}$/u;
const GRADLE_BUILD_FILES = ["build.gradle", "build.gradle.kts"] as const;
const GRADLE_SETTINGS_FILES = ["settings.gradle", "settings.gradle.kts"] as const;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Replaces the matched text with spaces, keeping every newline, so a line number found afterwards is still the file's. */
export const blank = (text: string, pattern: RegExp): string => text.replace(pattern, (match) => match.replace(/[^\n]/gu, " "));
/** `blank` for the blocks that start with `open` and end at the next `close`, in one pass (see `blocksBetween`). A block with no closer is left as it is. */
export function blankBlocks(text: string, open: string, close: string): string {
  let out = "";
  let at = 0;
  for (const block of blocksBetween(text, open, close)) {
    out += text.slice(at, block.index) + block.text.replace(/[^\n]/gu, " ");
    at = block.end;
  }
  return out + text.slice(at);
}
const safeRelative = (value: string): string | undefined => (SAFE_DIR.test(value) && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..") ? value : undefined);
const cmd = (cwd: string, executable: string, args: string[], timeoutSeconds: number) => ({ cwd, executable, args, timeoutSeconds });
const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;

function moduleNote(modules: string[]): string {
  const shown = modules.slice(0, MAX_MODULES).join(", ");
  const more = modules.length > MAX_MODULES ? ` and ${String(modules.length - MAX_MODULES)} more` : "";
  return `The build has ${plural(modules.length, "module")}: ${shown}${more}. Each module writes its own test and coverage reports, so one report path cannot cover them; counts come from the exit code until a maintainer sets a report path.`;
}

/** Where a pom.xml / Gradle build file says which Java it needs; shared with the toolchain proposal. */
export const MAVEN_JAVA_VERSION = /<(?:maven\.compiler\.release|maven\.compiler\.source|java\.version|release)>[ \t\r\n]{0,200}(\d{1,2}(?:\.\d{1,2})?)[ \t\r\n]{0,200}</u;
export const GRADLE_JAVA_VERSION = /JavaLanguageVersion\.of\(\s{0,120}(\d{1,2})\s{0,40}\)|JavaVersion\.VERSION_(\d{1,2}(?:_\d{1,2})?)|\bsourceCompatibility[ \t]{0,60}=?[ \t]{0,60}['"]?(\d{1,2}(?:\.\d{1,2})?)/u;

function javaVersionNote(path: string, text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  const version = match?.slice(1).find((part) => part !== undefined);
  return match === null || version === undefined ? undefined : `The build asks for Java ${version.replace("_", ".")} (${path} line ${String(lineOf(text, match.index))}); the test environment must provide it.`;
}

type Found = Partial<Detection> & { setupCommands: NonNullable<Detection["setupCommands"]>; checks: NonNullable<Detection["checks"]>; fullSuiteOn: NonNullable<Detection["fullSuiteOn"]>; notes: string[] };

function selectionNote(): string {
  return "Rovara proposes no per-test selection for Maven or Gradle (their test filters take one pattern per flag, which the selection template cannot express safely), so every run is the whole suite.";
}

/** The wrapper downloads its build tool from the URL in its properties file; a host other than the tools' own is named so a person sees where code will come from. */
const WRAPPER_HOSTS = new Set(["services.gradle.org", "repo.maven.apache.org"]);
async function wrapperSourceNotes(repo: DetectorContext["repo"], path: string, tool: string): Promise<string[]> {
  const text = await repo.read(path);
  if (text === undefined) return [];
  const notes: string[] = [];
  for (const match of text.matchAll(/^[ \t]*(distributionUrl|wrapperUrl)[ \t]*[=:][ \t]*(\S+)/gmu)) {
    const host = /^https?:\/\/(?:[^/@\s]*@)?([A-Za-z0-9.-]{1,253})(?::\d{1,5})?(?:[/\s]|$)/u.exec(match[2]!.replace(/\\(.)/gu, "$1"))?.[1]?.toLowerCase();
    const where = `${path} line ${String(lineOf(text, match.index))}`;
    if (host === undefined) notes.push(`The ${tool} wrapper's ${match[1]!} (${where}) could not be read as a web address, so where it downloads ${tool} from is not known.`);
    else if (!WRAPPER_HOSTS.has(host)) notes.push(`The ${tool} wrapper downloads ${tool} from ${host} (${where}), not from the usual source; confirm that is a source you trust.`);
  }
  return notes;
}

// ---- Maven

interface PluginBlock { body: string; index: number; line: number }
/** The first `<plugin>` whose artifactId is `artifactId`; `line` is the artifactId's line. */
function mavenPlugin(text: string, artifactId: string): PluginBlock | undefined {
  const id = new RegExp(`<artifactId>[ \\t\\r\\n]{0,200}${escape(artifactId)}[ \\t\\r\\n]{0,200}</artifactId>`, "u");
  for (const match of blocksBetween(text, "<plugin>", "</plugin>")) {
    const inner = id.exec(match.text);
    if (inner !== null) return { body: match.text, index: match.index, line: lineOf(text, match.index + inner.index) };
  }
  return undefined;
}

/** A reports directory written in the pom, as a safe path relative to the module, or undefined when it needs a property or leaves the module. */
function mavenDirectory(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/u, "");
  const resolved = /^\$\{project\.build\.directory\}(?:\/|$)/u.test(trimmed) ? trimmed.replace(/^\$\{project\.build\.directory\}/u, "target") : /^\$\{(?:basedir|project\.basedir)\}\//u.test(trimmed) ? trimmed.replace(/^\$\{(?:basedir|project\.basedir)\}\//u, "") : trimmed;
  return resolved.includes("$") ? undefined : safeRelative(resolved);
}

const MAVEN_LINT = [
  { id: "checkstyle", label: "Lint (Checkstyle)", artifact: "maven-checkstyle-plugin", goals: ["checkstyle:check"] },
  { id: "spotbugs", label: "Static analysis (SpotBugs)", artifact: "spotbugs-maven-plugin", goals: ["compile", "spotbugs:check"] },
  { id: "pmd", label: "Static analysis (PMD)", artifact: "maven-pmd-plugin", goals: ["pmd:check"] },
  { id: "spotless", label: "Format check (Spotless)", artifact: "spotless-maven-plugin", goals: ["spotless:check"] },
] as const;

async function detectMaven(context: DetectorContext, hasTests: boolean): Promise<Partial<Detection>> {
  const { repo, cwd } = context;
  const raw = await repo.read("pom.xml");
  if (raw === undefined) return { notes: ["pom.xml could not be read."] };
  const pom = blankBlocks(raw, "<!--", "-->");
  const withoutProfiles = blankBlocks(pom, "<profiles>", "</profiles>");
  // A plugin counts as part of the build only outside pluginManagement and profiles (a profile needs a flag Rovara does not know); its configuration may also sit in pluginManagement.
  const active = blankBlocks(withoutProfiles, "<pluginManagement>", "</pluginManagement>");
  const notes: string[] = [];
  const hasWrapper = repo.paths.includes("mvnw") && repo.paths.includes(".mvn/wrapper/maven-wrapper.properties");
  if (repo.paths.includes("mvnw") && !hasWrapper) notes.push("A Maven wrapper script (mvnw) was found without .mvn/wrapper/maven-wrapper.properties, so it cannot run; the commands use mvn.");
  if (hasWrapper) notes.push(...(await wrapperSourceNotes(repo, ".mvn/wrapper/maven-wrapper.properties", "Maven")));
  const executable = hasWrapper ? "./mvnw" : "mvn";
  const run = (goals: string[], timeoutSeconds: number) => cmd(cwd, executable, ["-B", ...goals], timeoutSeconds);
  const top = findLine(pom, /<project[\s>]/u) ?? 1;
  const projectAt: DetectedSource = { path: "pom.xml", line: top };

  const modulesBlock = blocksBetween(active, "<modules>", "</modules>", 1)[0]?.inner ?? "";
  const modules = [...modulesBlock.matchAll(/<module>[ \t\r\n]{0,200}([^<\s][^<]*?)[ \t\r\n]{0,200}<\/module>/gu)].map((match) => match[1]!).filter((name) => /^[A-Za-z0-9_./-]{1,100}$/u.test(name));
  const multi = modules.length > 0;
  if (multi) notes.push(moduleNote(modules));
  const versionNote = javaVersionNote("pom.xml", pom, MAVEN_JAVA_VERSION);
  if (versionNote !== undefined) notes.push(versionNote);

  const fullSuiteOn: Array<{ value: string; source: DetectedSource }> = [{ value: "pom.xml", source: "detector:java" }];
  if (repo.paths.includes("mvnw")) fullSuiteOn.push({ value: "mvnw", source: "detector:java" });
  if (repo.paths.some((path) => path.startsWith(".mvn/"))) fullSuiteOn.push({ value: ".mvn/**", source: "detector:java" });
  if (multi || repo.paths.some((path) => path.endsWith("/pom.xml"))) fullSuiteOn.push({ value: "**/pom.xml", source: "detector:java" });

  const found: Found = { setupCommands: [{ value: run(["test-compile"], TIMEOUT.setup), source: projectAt }], checks: [], fullSuiteOn, notes };
  if (!hasTests) {
    notes.push("No Java test sources were found, so no test command is proposed.");
    return found;
  }

  // JaCoCo: coverage only when the build binds the report goal (its phase decides which Maven phase the check has to reach).
  const jacoco = mavenPlugin(active, "jacoco-maven-plugin");
  let coverage: { path: string; source: DetectedSource; phase: number } | undefined;
  if (jacoco !== undefined) {
    const execution = blocksBetween(jacoco.body, "<execution>", "</execution>").find((item) => /<goal>[ \t\r\n]{0,200}report[ \t\r\n]{0,200}<\/goal>/u.test(item.text));
    const goalAt = /<goal>[ \t\r\n]{0,200}report[ \t\r\n]{0,200}<\/goal>/u.exec(jacoco.body);
    if (execution === undefined || goalAt === null) notes.push("JaCoCo is configured but the build does not write an XML report in a normal build, so changed-line coverage will show as not measured.");
    else if (multi) notes.push("JaCoCo writes one report per module, so no coverage path is proposed.");
    else {
      const phase = /<phase>[ \t\r\n]{0,200}([a-z-]+)[ \t\r\n]{0,200}<\/phase>/u.exec(execution.text)?.[1] ?? "verify";
      const index = MAVEN_PHASES.indexOf(phase);
      const dir = mavenDirectory(/<outputDirectory>([^<]{1,200})<\/outputDirectory>/u.exec(jacoco.body)?.[1] ?? "") ?? "target/site/jacoco";
      if (index === -1 || index > MAVEN_PHASES.indexOf("verify")) notes.push("JaCoCo's report is bound to a phase after verify, so no coverage path is proposed.");
      else coverage = { path: `${dir}/jacoco.xml`, source: { path: "pom.xml", line: lineOf(pom, jacoco.index + goalAt.index) }, phase: index };
    }
  }

  // Test reports: Surefire (unit) and Failsafe (integration). The pom's own reportsDirectory wins over the tool default.
  const surefire = mavenPlugin(withoutProfiles, "maven-surefire-plugin");
  const failsafe = mavenPlugin(active, "maven-failsafe-plugin");
  const reportDirectory = (block: PluginBlock | undefined, fallback: string): { path: string; source: DetectedSource } => {
    if (block !== undefined) {
      const match = /<reportsDirectory>([^<]{1,200})<\/reportsDirectory>/u.exec(block.body);
      const dir = match === null ? undefined : mavenDirectory(match[1]!);
      if (match !== null && dir !== undefined) return { path: dir, source: { path: "pom.xml", line: lineOf(pom, block.index + match.index) } };
    }
    return { path: fallback, source: "detector:java" };
  };
  const unitReport = reportDirectory(surefire, "target/surefire-reports");
  const unitReachesCoverage = coverage !== undefined && coverage.phase <= MAVEN_PHASES.indexOf("test");
  // Without Failsafe the one test check has to reach the phase the coverage report is bound to.
  const unitGoal = coverage !== undefined && failsafe === undefined && !unitReachesCoverage ? "verify" : "test";
  found.checks.push({
    value: {
      id: "unit", label: "Unit tests (Maven)", kind: "test", command: run([unitGoal], TIMEOUT.test),
      ...(multi ? {} : { reportPath: unitReport.path, reportSource: unitReport.source }),
      ...(!multi && coverage !== undefined && (unitReachesCoverage || (failsafe === undefined && unitGoal === "verify")) ? { coveragePath: coverage.path, coverageSource: coverage.source } : {}),
    },
    source: surefire === undefined ? projectAt : { path: "pom.xml", line: surefire.line },
  });
  if (failsafe !== undefined) {
    const integrationReport = reportDirectory(failsafe, "target/failsafe-reports");
    found.checks.push({
      value: {
        id: "integration", label: "Integration tests (Maven)", kind: "test", command: run(["verify"], TIMEOUT.integration),
        ...(multi ? {} : { reportPath: integrationReport.path, reportSource: integrationReport.source }),
        ...(!multi && coverage !== undefined && !unitReachesCoverage ? { coveragePath: coverage.path, coverageSource: coverage.source } : {}),
      },
      source: { path: "pom.xml", line: failsafe.line },
    });
    notes.push("The integration check runs verify, which runs the unit tests again before the integration tests.");
  }
  if (!multi) notes.push(`JUnit XML reports are expected in ${unitReport.path}${unitReport.source === "detector:java" ? " (Maven Surefire's default location)" : " (set in the pom)"}; the Prove run checks that they are written.`);
  for (const tool of MAVEN_LINT) {
    const block = mavenPlugin(active, tool.artifact);
    if (block !== undefined) found.checks.push({ value: { id: tool.id, label: tool.label, kind: "lint", command: run([...tool.goals], TIMEOUT.lint) }, source: { path: "pom.xml", line: block.line } });
  }
  notes.push(selectionNote());
  return found;
}

// ---- Gradle

/** The line of a plugin applied in any of the usual ways (`id 'x'`, `id("x")`, `apply plugin: 'x'`, a bare name in a plugins block), or undefined. */
function gradlePluginLine(text: string, ...ids: string[]): number | undefined {
  for (const id of ids) {
    // One bounded class between `id` and the quote (blanks, line ends and an opening parenthesis), so the pattern never splits a long run of blanks between two quantifiers.
    const pattern = new RegExp(String.raw`(?:\bid[\s(]{0,40}|\bapply[ \t]{1,40}plugin[ \t]{0,40}:[ \t]{0,40}|^[ \t]*)["'` + "`" + String.raw`]?${escape(id)}["'` + "`" + String.raw`]?(?=[ \t]{0,40}(?:\)|$|version\b|apply\b))`, "mu");
    const line = findLine(text, pattern);
    if (line !== undefined) return line;
  }
  return undefined;
}

const GRADLE_LINT = [
  { id: "checkstyle", label: "Lint (Checkstyle)", plugins: ["checkstyle"], tasks: ["checkstyleMain", "checkstyleTest"] },
  { id: "spotbugs", label: "Static analysis (SpotBugs)", plugins: ["com.github.spotbugs"], tasks: ["spotbugsMain", "spotbugsTest"] },
  { id: "pmd", label: "Static analysis (PMD)", plugins: ["pmd"], tasks: ["pmdMain", "pmdTest"] },
  { id: "spotless", label: "Format check (Spotless)", plugins: ["com.diffplug.spotless", "spotless"], tasks: ["spotlessCheck"] },
] as const;

async function detectGradle(context: DetectorContext, hasTests: boolean): Promise<Partial<Detection>> {
  const { repo, cwd } = context;
  const buildName = GRADLE_BUILD_FILES.find((name) => repo.paths.includes(name));
  const settingsName = GRADLE_SETTINGS_FILES.find((name) => repo.paths.includes(name));
  const clean = (text: string): string => blank(blankBlocks(text, "/*", "*/"), /(^|[ \t])\/\/[^\n]*/gmu);
  const buildRaw = buildName === undefined ? "" : await repo.read(buildName);
  const settingsRaw = settingsName === undefined ? "" : await repo.read(settingsName);
  if (buildRaw === undefined || settingsRaw === undefined) return { notes: [`${buildRaw === undefined ? (buildName ?? "The Gradle build file") : (settingsName ?? "The Gradle settings file")} could not be read.`] };
  const build = clean(buildRaw);
  const settings = clean(settingsRaw);
  const notes: string[] = [];
  const hasWrapper = repo.paths.includes("gradlew") && repo.paths.includes("gradle/wrapper/gradle-wrapper.properties") && repo.paths.includes("gradle/wrapper/gradle-wrapper.jar");
  if (repo.paths.includes("gradlew") && !hasWrapper) notes.push("A Gradle wrapper script (gradlew) was found without gradle/wrapper/gradle-wrapper.properties and gradle/wrapper/gradle-wrapper.jar, so it cannot run; the commands use gradle.");
  if (hasWrapper) notes.push(...(await wrapperSourceNotes(repo, "gradle/wrapper/gradle-wrapper.properties", "Gradle")));
  const executable = hasWrapper ? "./gradlew" : "gradle";
  const run = (tasks: string[], timeoutSeconds: number) => cmd(cwd, executable, ["--console=plain", ...tasks], timeoutSeconds);
  const buildPath = buildName ?? settingsName ?? "build.gradle";
  const topLine = findLine(build, /^[ \t]*(?:plugins\s{0,40}\{|apply\s{1,40}plugin)/mu) ?? 1;
  const topAt: DetectedSource = { path: buildPath, line: topLine };

  const modules: string[] = [];
  for (const match of settings.matchAll(/\binclude[\s(]{0,40}((?:["'][^"'\n]{1,100}["'][\s,]{0,40}){1,200})/gu)) {
    for (const item of match[1]!.matchAll(/["']([^"'\n]{1,100})["']/gu)) {
      const name = item[1]!.replace(/^:/u, "");
      if (/^[A-Za-z0-9_.:/-]{1,100}$/u.test(name) && !modules.includes(name)) modules.push(name);
    }
  }
  const multi = modules.length > 0;
  if (multi) notes.push(moduleNote(modules));
  const versionNote = buildName === undefined ? undefined : javaVersionNote(buildName, build, GRADLE_JAVA_VERSION);
  if (versionNote !== undefined) notes.push(versionNote);

  const fullSuiteOn: Array<{ value: string; source: DetectedSource }> = [];
  for (const name of [...GRADLE_BUILD_FILES, ...GRADLE_SETTINGS_FILES, "gradle.properties", "gradle.lockfile", "gradle/libs.versions.toml", "gradle/wrapper/gradle-wrapper.properties", "gradlew"]) if (repo.paths.includes(name)) fullSuiteOn.push({ value: name, source: "detector:java" });
  for (const dir of ["buildSrc", "build-logic", "gradle/dependency-locks"]) if (repo.paths.some((path) => path.startsWith(`${dir}/`))) fullSuiteOn.push({ value: `${dir}/**`, source: "detector:java" });
  for (const name of GRADLE_BUILD_FILES) if (multi || repo.paths.some((path) => path.endsWith(`/${name}`))) fullSuiteOn.push({ value: `**/${name}`, source: "detector:java" });

  const found: Found = { setupCommands: [{ value: run(["testClasses"], TIMEOUT.setup), source: topAt }], checks: [], fullSuiteOn, notes };
  if (!hasTests) {
    notes.push("No Java test sources were found, so no test command is proposed.");
    return found;
  }

  // JaCoCo: coverage only when the build enables the XML report; the report task is added to the command unless the build already runs it after the tests.
  let coverage: { path: string; source: DetectedSource; extraTask: boolean } | undefined;
  if (gradlePluginLine(build, "jacoco") !== undefined) {
    const xmlAt = jacocoXmlReportAt(build);
    if (xmlAt === undefined) notes.push("JaCoCo is configured but the build does not write an XML report, so changed-line coverage will show as not measured.");
    else if (multi) notes.push("JaCoCo writes one report per module, so no coverage path is proposed.");
    else coverage = { path: "build/reports/jacoco/test/jacocoTestReport.xml", source: { path: buildPath, line: lineOf(build, xmlAt) }, extraTask: !/finalizedBy[^\n]*jacocoTestReport/u.test(build) };
  }
  const ownLocation = /junitXml|testResultsDir/u.test(build);
  if (ownLocation) notes.push("The build sets its own test result location, which Rovara does not read; no report path is proposed until a maintainer sets one.");
  const report = !multi && !ownLocation;
  found.checks.push({
    value: {
      id: "unit", label: "Unit tests (Gradle)", kind: "test", command: run(["test", ...(coverage?.extraTask === true ? ["jacocoTestReport"] : [])], TIMEOUT.test),
      ...(report ? { reportPath: "build/test-results/test", reportSource: "detector:java" as const } : {}),
      ...(coverage === undefined ? {} : { coveragePath: coverage.path, coverageSource: coverage.source }),
    },
    source: topAt,
  });
  const integration = /(?:register|create)[ \t]{0,40}(?:<[^<>\n]{0,100}>)?[ \t]{0,40}\(\s{0,120}["'](integrationTest|intTest|functionalTest|componentTest)["']|\btask[\s(]{0,40}["']?(integrationTest|intTest|functionalTest|componentTest)\b/u.exec(build);
  const integrationName = integration?.[1] ?? integration?.[2];
  if (integration !== null && integrationName !== undefined) {
    found.checks.push({
      value: {
        id: "integration", label: "Integration tests (Gradle)", kind: "test", command: run([integrationName], TIMEOUT.integration),
        ...(report ? { reportPath: `build/test-results/${integrationName}`, reportSource: { path: buildPath, line: lineOf(build, integration.index) } } : {}),
      },
      source: { path: buildPath, line: lineOf(build, integration.index) },
    });
  }
  if (report) notes.push("JUnit XML reports are expected in build/test-results/test (Gradle's default location); the Prove run checks that they are written.");
  for (const tool of GRADLE_LINT) {
    const line = gradlePluginLine(build, ...tool.plugins);
    if (line !== undefined) found.checks.push({ value: { id: tool.id, label: tool.label, kind: "lint", command: run([...tool.tasks], TIMEOUT.lint) }, source: { path: buildPath, line } });
  }
  notes.push(selectionNote());
  return found;
}

const detectJavaBuild: Detector = async (context) => {
  const { repo } = context;
  const hasMaven = repo.paths.includes("pom.xml");
  const hasGradle = [...GRADLE_BUILD_FILES, ...GRADLE_SETTINGS_FILES].some((name) => repo.paths.includes(name));
  if (!hasMaven && !hasGradle) {
    const nested = repo.paths.filter((path) => /\/(?:pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts)$/u.test(path));
    if (nested.length === 0 || !repo.paths.some((path) => TEST_SOURCE.test(path) || /\.(?:java|kt)$/u.test(path))) return {};
    return {
      notes: ["Java build files were found only in subfolders, not at the top of the repository, so no Java command is proposed."],
      questions: ["Which folder is the Java build run from (Maven or Gradle)? Its files are in a subfolder, not at the top of the repository."],
    };
  }
  if (hasMaven && hasGradle) {
    return {
      notes: ["Both Maven and Gradle build files were found at the top of the repository, so no Java command is proposed."],
      questions: ["This repository has both Maven (pom.xml) and Gradle (build.gradle or settings.gradle) files. Which one builds and tests it?"],
    };
  }
  const hasTests = repo.paths.some((path) => TEST_SOURCE.test(path) || /(?:^|\/)[A-Za-z0-9_]*Tests?\.(?:java|kt|groovy|scala)$/u.test(path));
  return hasMaven ? detectMaven(context, hasTests) : detectGradle(context, hasTests);
};

// ---- dependencies (test services D4 manifests, D5 code)

const JAVA_ARTIFACTS: ReadonlyArray<[RegExp, string]> = [
  [/^org\.postgresql:postgresql$/u, "postgres"],
  [/^(?:mysql:mysql-connector-java|com\.mysql:mysql-connector-j)$/u, "mysql"],
  [/^org\.mariadb\.jdbc:/u, "mariadb"],
  [/^(?:redis\.clients:jedis|io\.lettuce:lettuce-core|org\.redisson:[a-z-]+|org\.springframework\.boot:spring-boot-starter-data-redis(?:-reactive)?)$/u, "redis"],
  [/^(?:org\.mongodb:[a-z-]+|org\.springframework\.boot:spring-boot-starter-data-mongodb(?:-reactive)?)$/u, "mongodb"],
  [/^(?:org\.apache\.kafka:kafka-clients|org\.springframework\.kafka:spring-kafka)$/u, "kafka"],
  [/^(?:com\.rabbitmq:amqp-client|org\.springframework\.amqp:[a-z-]+|org\.springframework\.boot:spring-boot-starter-amqp)$/u, "rabbitmq"],
  [/^(?:co\.elastic\.clients:[a-z-]+|org\.elasticsearch\.client:[a-z-]+|org\.springframework\.boot:spring-boot-starter-data-elasticsearch)$/u, "elasticsearch"],
  [/^org\.opensearch\.client:[a-z-]+$/u, "opensearch"],
];
/** `software.amazon.awssdk:<artifact>` artifacts that are not a service client. */
const AWS_SDK_NON_SERVICE = new Set(["sdk-core", "aws-core", "bom", "auth", "regions", "apache-client", "url-connection-client", "netty-nio-client", "utils", "http-client-spi", "protocol-core", "aws-sdk-java", "arns", "profiles", "annotations", "metrics-spi", "crt-core", "sts-credentials", "imds", "json-utils", "third-party-jackson-core", "retries", "retries-spi", "checksums", "checksums-spi", "endpoints-spi", "identity-spi", "http-auth", "http-auth-spi", "http-auth-aws", "aws-json-protocol", "aws-query-protocol", "aws-xml-protocol", "aws-cbor-protocol", "codegen", "ssooidc"]);
const AWS_V1_NON_SERVICE = new Set(["core", "bom", "osgi", "bundle", "test-utils", "swf-libraries", "java-sdk"]);
const AWS_SDK_SUFFIX = /-(?:enhanced|transfer-manager|crt)$/u;

function javaArtifactFamily(key: string): string | undefined {
  for (const [pattern, family] of JAVA_ARTIFACTS) if (pattern.test(key)) return family;
  const v2 = /^software\.amazon\.awssdk:([a-z0-9-]+)$/u.exec(key)?.[1];
  const v1 = /^com\.amazonaws:aws-java-sdk-([a-z0-9-]+)$/u.exec(key)?.[1];
  const raw = (v2 ?? v1)?.replace(AWS_SDK_SUFFIX, "");
  if (raw === undefined || (v2 !== undefined && AWS_SDK_NON_SERVICE.has(raw)) || (v1 !== undefined && AWS_V1_NON_SERVICE.has(raw))) return undefined;
  const id = normalizeAwsService(raw, "java");
  return id === undefined || isOwnedElsewhere(`aws:${id}`) ? undefined : `aws:${id}`;
}

/** Candidates for the drivers and AWS SDK modules the Maven and Gradle build files list (every build file, not only the top one). Strength `mentioned`. */
export async function javaManifestCandidates(repo: DetectorContext["repo"]): Promise<DependencyCandidate[]> {
  const found: DependencyCandidate[] = [];
  for (const path of repo.paths.filter((candidatePath) => /(?:^|\/)(?:pom\.xml|build\.gradle|build\.gradle\.kts)$/u.test(candidatePath)).slice(0, 30)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    if (path.endsWith("pom.xml")) {
      for (const block of blocksBetween(text, "<dependency>", "</dependency>")) {
        const group = /<groupId>[ \t\r\n]{0,200}([^<\s]+)[ \t\r\n]{0,200}<\/groupId>/u.exec(block.text)?.[1];
        const artifact = /<artifactId>[ \t\r\n]{0,200}([^<\s]+)[ \t\r\n]{0,200}<\/artifactId>/u.exec(block.text)?.[1];
        const family = group === undefined || artifact === undefined ? undefined : javaArtifactFamily(`${group}:${artifact}`);
        if (family !== undefined) found.push(candidate(family, "mentioned", { path, line: lineOf(text, block.index) }, { seenBy: ["driver"] }));
      }
    } else {
      for (const match of text.matchAll(/["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::[^"']*)?["']/gu)) {
        const family = javaArtifactFamily(`${match[1]!}:${match[2]!}`);
        if (family !== undefined) found.push(candidate(family, "mentioned", { path, line: lineOf(text, match.index) }, { seenBy: ["driver"] }));
      }
    }
  }
  return mergeCandidates(found);
}

export const JAVA_DRIVERS: readonly DriverRule[] = [
  { family: "postgres", uses: /^[ \t]*import\s{1,40}org\.postgresql\./mu, call: /DriverManager\.getConnection\s{0,120}\(|\.setUrl\s{0,120}\(|\.jdbcUrl\s{0,120}\(|\.setServerNames?\s{0,120}\(/u },
  { family: "mysql", uses: /^[ \t]*import\s{1,40}com\.mysql\./mu, call: /DriverManager\.getConnection\s{0,120}\(|\.setUrl\s{0,120}\(|\.jdbcUrl\s{0,120}\(/u },
  { family: "redis", uses: /^[ \t]*import\s{1,40}(?:redis\.clients\.jedis|io\.lettuce|org\.redisson)\./mu, call: /new\s{1,40}Jedis(?:Pool)?\s{0,120}\(|RedisClient\.create\s{0,120}\(|\.setAddress\s{0,120}\(/u },
  { family: "mongodb", uses: /^[ \t]*import\s{1,40}com\.mongodb\./mu, call: /MongoClients\.create\s{0,120}\(|new\s{1,40}MongoClient\s{0,120}\(|new\s{1,40}ConnectionString\s{0,120}\(/u },
  { family: "kafka", uses: /^[ \t]*import\s{1,40}org\.apache\.kafka\./mu, call: /\.put\s{0,120}\(\s{0,120}["']bootstrap\.servers["']|BOOTSTRAP_SERVERS_CONFIG\s{0,40},/u },
  { family: "rabbitmq", uses: /^[ \t]*import\s{1,40}com\.rabbitmq\./mu, call: /\.setHost\s{0,120}\(|\.setUri\s{0,120}\(/u },
  { family: "elasticsearch", uses: /^[ \t]*import\s{1,40}(?:org\.elasticsearch|co\.elastic)\./mu, call: /RestClient\.builder\s{0,120}\(|new\s{1,40}HttpHost\s{0,120}\(/u },
];

/** AWS SDK clients (v2 `S3Client.builder()`, v1 imports) and drivers a Java or Kotlin file uses (test services D5). An `endpointOverride` / endpoint configuration written as a string is flagged. */
export function javaCodeCandidates(path: string, text: string): DependencyCandidate[] {
  const found = scanDrivers(path, text, JAVA_DRIVERS);
  const builders = [...text.matchAll(/\b([A-Za-z0-9]+?)(?:Async)?Client\.builder\s{0,120}\(\s{0,120}\)([\s\S]{0,800}?)\.build\s{0,120}\(/gu)].map((match) => ({ name: match[1]!.toLowerCase(), explicit: /endpointOverride\s{0,120}\(\s{0,120}URI\.create\s{0,120}\(\s{0,120}"|EndpointConfiguration\s{0,120}\(\s{0,120}"/u.test(match[2]!) }));
  for (const match of text.matchAll(/^[ \t]*import\s{1,40}(?:software\.amazon\.awssdk\.services|com\.amazonaws\.services)\.([a-z0-9]+)\./gmu)) {
    const id = normalizeAwsService(match[1]!, "java");
    const explicit = id !== undefined && builders.some((builder) => builder.explicit && builder.name === id.replace(/-/gu, ""));
    const item = awsClientCandidate(path, text, match.index, match[1]!, explicit, "java");
    if (item !== undefined) found.push(item);
  }
  return found;
}

/**
 * Where a Gradle build turns on JaCoCo's XML report (`xml.required = true`, `xml.enabled true`, or `xml { required.set(true) }`), or undefined: the leftmost, as one alternation found it.
 * The block form is not a pattern: `xml\s{0,40}\{[^}]*required…` rescanned to the next `}` from every `xml {`, so a build of `xml{` repeated took seconds (quadratic). Here each `}` and
 * each `required … true` is looked for once and reused while it is still ahead: a block with none before its `}` makes every later `xml {` before that `}` fail the same way.
 */
function jacocoXmlReportAt(build: string): number | undefined {
  const direct = /xml\.required(?:\.set)?\s{0,40}(?:=|\()\s{0,40}true|xml\.enabled\s{0,40}(?:=\s{0,40})?true/u.exec(build)?.index;
  const required = /required\s{0,40}(?:=|\.set\()\s{0,40}true/gu;
  let close = -1;
  let next = -1;
  for (const opener of build.matchAll(/xml\s{0,40}\{/gu)) {
    if (direct !== undefined && opener.index >= direct) break;
    const inside = opener.index + opener[0].length;
    if (inside <= close) continue;
    close = build.indexOf("}", inside);
    if (close === -1) close = build.length;
    if (next < inside) { required.lastIndex = inside; next = required.exec(build)?.index ?? Number.POSITIVE_INFINITY; }
    if (next < close) return opener.index;
  }
  return direct;
}

export const detectJava: Detector = async (context) => {
  const found = await detectJavaBuild(context);
  const dependencies = await javaManifestCandidates(context.repo);
  return dependencies.length === 0 ? found : { ...found, dependencies };
};
