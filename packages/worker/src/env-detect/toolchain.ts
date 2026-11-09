// Toolchain proposal (SH32, setup-test-health 3.5): the language a repository needs that the sandbox's base image does not carry is added by a proposed dev container, which is a pull request a person approves (the
// existing `devcontainer` setup item), never a download-and-run in the sandbox: the sandbox user has no root (uid 1000), so a system package install cannot happen there.
// The base image (environments/base/Dockerfile) carries Node and Python. Everything else is read from the repository's own files: Go from go.mod / go.work, Java from the pom or the Gradle build, each cited with file
// and line. The image is a Microsoft dev container image (mcr.microsoft.com, already an allowed host), at the SMALLEST offered version that satisfies the repository's own minimum; a version Rovara cannot find in the
// files, or one no listed image offers, is a question, never a guess. Other languages are recognised and asked about (Rovara has not checked their image tags), not proposed.
// A repository that already has a dev container gets none proposed: its own file is used, and a question is asked when that file does not obviously provide the toolchain. With a cut file list nothing is proposed.
// The pull request that adds the proposed file MUST be create-only: it must fail, not overwrite, when a file already exists at the path (the list read here can be stale).
// Pure over a bounded reader: nothing is run, downloaded or written. The file content is a PROPOSAL; the dev container item's own reader re-checks its size, shape and path.
import { DEVCONTAINER_PATH_PATTERN, SETUP_DEVCONTAINER_MAX_BYTES } from "@agentx/contracts";
import { GRADLE_JAVA_VERSION, MAVEN_JAVA_VERSION, blank, blankBlocks } from "./java.js";
import { goDirectives } from "./go.js";
import { findLine, lineOf, type DetectedSource, type RepositoryReader } from "./types.js";

/** The languages the sandbox's base image carries (environments/base/Dockerfile: Node, and Python 3 with uv). */
export const BASE_IMAGE_LANGUAGES: readonly string[] = ["node", "python"];

/**
 * The image versions published under mcr.microsoft.com/devcontainers/<name>, as the images' own READMEs list them (github.com/devcontainers/images, src/go and src/java, read 2026-11-01). The tag is `<version>-bookworm`.
 * A version newer than the last entry has no listed image, so it is asked about; add a row here when a new version is published.
 */
export const DEVCONTAINER_IMAGE_VERSIONS = {
  go: ["1.25", "1.26", "1.27"],
  java: ["11", "17", "21", "25"],
} as const;

const NEW_PATH = ".devcontainer/devcontainer.json";
const LANGUAGE_NAMES: Readonly<Record<string, string>> = { go: "Go", java: "Java", rust: "Rust", dotnet: ".NET", ruby: "Ruby", php: "PHP", cpp: "C and C++", swift: "Swift", scala: "Scala", elixir: "Elixir" };
/** Languages that are recognised by a build file and at least one source file; no image is proposed for them. */
const OTHER_LANGUAGES: ReadonlyArray<{ id: string; marker: RegExp; source: RegExp }> = [
  { id: "rust", marker: /^Cargo\.toml$/u, source: /\.rs$/u },
  { id: "dotnet", marker: /(?:^|\/)(?:global\.json|[^/]+\.(?:sln|csproj|fsproj))$/u, source: /\.(?:cs|fs)$/u },
  { id: "ruby", marker: /^Gemfile$/u, source: /\.rb$/u },
  { id: "php", marker: /^composer\.json$/u, source: /\.php$/u },
  { id: "cpp", marker: /^CMakeLists\.txt$/u, source: /\.(?:cpp|cc|cxx|hpp)$/u },
  { id: "swift", marker: /^Package\.swift$/u, source: /\.swift$/u },
  { id: "scala", marker: /^build\.sbt$/u, source: /\.scala$/u },
  { id: "elixir", marker: /^mix\.exs$/u, source: /\.exs?$/u },
];

export interface ToolchainDevContainer {
  /** Where the dev container's configuration lives (an existing one, or the path proposed). */
  configPath: string;
  exists: boolean;
  /** The devcontainer.json to add; absent when one exists. */
  proposedContent?: string;
  /** Where each decision came from: the files and lines that named the version, or `detector:toolchain`. */
  from: DetectedSource[];
}
export interface ToolchainProposal {
  devcontainer?: ToolchainDevContainer;
  notes: string[];
  questions: string[];
}

interface Need { language: "go" | "java"; version?: { value: string; source: DetectedSource }; tools: string[] }

const minor = (version: string): [number, number] | undefined => {
  const match = /^(\d{1,3})\.(\d{1,3})/u.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
};
/** The smallest listed image version that is at least `required` (a "major.minor" compare for Go, a whole number for Java), or undefined when none is. */
function smallestAtLeast(language: "go" | "java", required: string): string | undefined {
  if (language === "go") {
    const need = minor(required);
    return need === undefined ? undefined : DEVCONTAINER_IMAGE_VERSIONS.go.find((offered) => { const have = minor(offered)!; return have[0] > need[0] || (have[0] === need[0] && have[1] >= need[1]); });
  }
  const number = Number(required);
  return Number.isInteger(number) ? DEVCONTAINER_IMAGE_VERSIONS.java.find((offered) => Number(offered) >= number) : undefined;
}

/** Java's "1.8" is version 8; "11" is 11. */
function javaMajor(raw: string): string | undefined {
  const text = raw.replace("_", ".");
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/u.exec(text);
  if (match === null) return undefined;
  const major = match[1] === "1" && match[2] !== undefined ? match[2] : match[1]!;
  return Number(major) >= 1 ? major : undefined;
}

async function goNeed(repo: RepositoryReader): Promise<Need | undefined> {
  const hasMod = repo.paths.includes("go.mod");
  const hasWork = repo.paths.includes("go.work");
  const nested = repo.paths.some((path) => path.endsWith("/go.mod") && !path.split("/").slice(0, -1).some((part) => part === "vendor" || part === "testdata" || part.startsWith(".") || part.startsWith("_")));
  if (!hasMod && !hasWork && !(nested && repo.paths.some((path) => path.endsWith(".go")))) return undefined;
  for (const file of [hasWork ? "go.work" : undefined, hasMod ? "go.mod" : undefined]) {
    if (file === undefined) continue;
    const text = await repo.read(file);
    const go = text === undefined ? undefined : goDirectives(text, "go")[0];
    if (go !== undefined && /^\d{1,2}\.\d{1,3}(?:\.\d{1,3})?(?:rc\d{1,3}|beta\d{1,3})?$/u.test(go.value)) return { language: "go", version: { value: go.value, source: { path: file, line: go.line } }, tools: [] };
  }
  return { language: "go", tools: [] };
}

type JavaFacts = { version?: NonNullable<Need["version"]>; tools: string[] };

async function mavenFacts(repo: RepositoryReader): Promise<JavaFacts> {
  const raw = await repo.read("pom.xml");
  const pom = raw === undefined ? undefined : blankBlocks(raw, "<!--", "-->");
  const match = pom === undefined ? null : MAVEN_JAVA_VERSION.exec(pom);
  const value = match === null ? undefined : javaMajor(match[1]!);
  const wrapper = repo.paths.includes("mvnw") && repo.paths.includes(".mvn/wrapper/maven-wrapper.properties");
  return { tools: wrapper ? [] : ["maven"], ...(match === null || value === undefined || pom === undefined ? {} : { version: { value, source: { path: "pom.xml", line: lineOf(pom, match.index) } } }) };
}

async function gradleFacts(repo: RepositoryReader, file: string | undefined): Promise<JavaFacts> {
  const raw = file === undefined ? undefined : await repo.read(file);
  const build = raw === undefined ? undefined : blank(blankBlocks(raw, "/*", "*/"), /(^|[ \t])\/\/[^\n]*/gmu);
  const match = build === undefined ? null : GRADLE_JAVA_VERSION.exec(build);
  const value = match === null ? undefined : javaMajor(match.slice(1).find((part) => part !== undefined) ?? "");
  const wrapper = repo.paths.includes("gradlew") && repo.paths.includes("gradle/wrapper/gradle-wrapper.properties") && repo.paths.includes("gradle/wrapper/gradle-wrapper.jar");
  return { tools: wrapper ? [] : ["gradle"], ...(match === null || value === undefined || build === undefined || file === undefined ? {} : { version: { value, source: { path: file, line: lineOf(build, match.index) } } }) };
}

async function javaNeed(repo: RepositoryReader): Promise<Need | undefined> {
  const hasMaven = repo.paths.includes("pom.xml");
  const gradleFile = ["build.gradle", "build.gradle.kts"].find((name) => repo.paths.includes(name));
  const hasGradle = gradleFile !== undefined || ["settings.gradle", "settings.gradle.kts"].some((name) => repo.paths.includes(name));
  const nested = repo.paths.some((path) => /\/(?:pom\.xml|build\.gradle|build\.gradle\.kts)$/u.test(path)) && repo.paths.some((path) => /\.(?:java|kt)$/u.test(path));
  if (!hasMaven && !hasGradle) return nested ? { language: "java", tools: [] } : undefined;
  if (hasMaven && hasGradle) {
    // Maven and Gradle together: the Java detector asks which one builds; the JDK is still needed, and no build tool is added for either.
    const facts = (await mavenFacts(repo)).version !== undefined ? await mavenFacts(repo) : await gradleFacts(repo, gradleFile);
    return { language: "java", tools: [], ...(facts.version === undefined ? {} : { version: facts.version }) };
  }
  const facts = hasMaven ? await mavenFacts(repo) : await gradleFacts(repo, gradleFile);
  return { language: "java", ...facts };
}

/** The devcontainer.json for one need, as the setup item carries it: a JSON object, one image, and the Java feature only for a build tool the repository has no wrapper for. */
function contentFor(need: Need, image: string, version: string): string {
  const name = `${LANGUAGE_NAMES[need.language]!} ${version} for tests`;
  const config: Record<string, unknown> = { name, image };
  if (need.language === "java" && need.tools.length > 0) {
    config["features"] = { "ghcr.io/devcontainers/features/java:1": { version: "none", installMaven: need.tools.includes("maven"), installGradle: need.tools.includes("gradle") } };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

const where = (source: DetectedSource): string => (typeof source === "string" ? source : `${source.path} line ${String(source.line)}`);
const MENTIONS: Readonly<Record<string, RegExp>> = { go: /\bgolang\b|devcontainers\/go\b|features\/go\b|\bgo:\d/iu, java: /\bjava\b|\bjdk\b|temurin|corretto|openjdk|maven|gradle/iu };

export async function proposeToolchain(repo: RepositoryReader, options: { baseLanguages?: readonly string[] } = {}): Promise<ToolchainProposal> {
  const base = new Set(options.baseLanguages ?? BASE_IMAGE_LANGUAGES);
  const notes: string[] = [];
  const questions: string[] = [];
  const needs = (await Promise.all([goNeed(repo), javaNeed(repo)])).filter((need): need is Need => need !== undefined && !base.has(need.language));

  for (const other of OTHER_LANGUAGES) {
    if (base.has(other.id)) continue;
    if (repo.paths.some((path) => other.marker.test(path)) && repo.paths.some((path) => other.source.test(path))) {
      const name = LANGUAGE_NAMES[other.id]!;
      notes.push(`This looks like a ${name} project, and the sandbox image has no ${name} toolchain.`);
      questions.push(`Which ${name} version should the tests run with? A dev container can provide it; Rovara has no checked image for ${name} yet.`);
    }
  }
  if (needs.length === 0) return { notes, questions };

  const names = needs.map((need) => LANGUAGE_NAMES[need.language]!).join(" and ");
  // A cut file list may hide a dev container the repository already has, so nothing is proposed from it. Whoever opens the pull request must also create the file only (never overwrite a file at that path).
  if (repo.truncated === true) {
    notes.push("The repository has more files than Rovara reads, so it could not tell whether a dev container already exists; no dev container is proposed.");
    questions.push(`Does the repository already have a dev container that provides ${names}?`);
    return { notes, questions };
  }
  const existing = repo.paths.find((path) => DEVCONTAINER_PATH_PATTERN.test(path));
  if (existing !== undefined) {
    const text = await repo.read(existing);
    const missing = needs.filter((need) => text === undefined || !MENTIONS[need.language]!.test(text));
    notes.push(`The repository already has a dev container (${existing}), so none is proposed; it is used for the ${names} toolchain.`);
    if (missing.length > 0) questions.push(`Does the dev container in ${existing} provide ${missing.map((need) => LANGUAGE_NAMES[need.language]!).join(" and ")}? Its file does not name ${missing.length === 1 ? "it" : "them"}.`);
    return { devcontainer: { configPath: existing, exists: true, from: [{ path: existing, line: findLine(text ?? "", /\S/u) ?? 1 }] }, notes, questions };
  }

  const [primary, ...rest] = needs as [Need, ...Need[]];
  const name = LANGUAGE_NAMES[primary.language]!;
  let proposal: ToolchainDevContainer | undefined;
  if (primary.version === undefined) {
    notes.push(`${name} is needed, but the repository's files do not say which version, so no dev container is proposed.`);
    questions.push(`Which ${name} version should the tests run with? The repository's files do not say, and the sandbox image has no ${name}.`);
  } else {
    const offered = smallestAtLeast(primary.language, primary.version.value);
    if (offered === undefined) {
      notes.push(`The repository asks for ${name} ${primary.version.value} or newer (${where(primary.version.source)}), which none of the listed dev container images offers, so none is proposed.`);
      questions.push(`Which dev container image should provide ${name} ${primary.version.value}? None of the images Rovara knows offers it.`);
    } else {
      const image = `mcr.microsoft.com/devcontainers/${primary.language}:${offered}-bookworm`;
      const content = `${contentFor(primary, image, offered)}`;
      if (Buffer.byteLength(content, "utf8") > SETUP_DEVCONTAINER_MAX_BYTES) {
        notes.push("The proposed dev container file is larger than a proposal may carry, so none is proposed.");
      } else {
        proposal = { configPath: NEW_PATH, exists: false, proposedContent: content, from: [primary.version.source, "detector:toolchain"] };
        notes.push(`The sandbox image has no ${name}. A dev container (${image}) is proposed: the repository asks for ${name} ${primary.version.value} or newer (${where(primary.version.source)}), and ${offered} is the smallest version offered. It is added by a pull request a person approves.`);
        if (primary.language === "java" && primary.tools.length > 0) notes.push(`The repository has no ${primary.tools.join(" or ")} wrapper, so the dev container's Java feature installs ${primary.tools.join(" and ")}.`);
      }
    }
  }
  for (const other of rest) questions.push(`The repository also needs ${LANGUAGE_NAMES[other.language]!}. A single dev container proposed here covers ${name} only; should ${LANGUAGE_NAMES[other.language]!} be added to it?`);
  return { ...(proposal === undefined ? {} : { devcontainer: proposal }), notes, questions };
}
