// Wiki W0 (DEC 254zh): what the free file map skips, how it names languages and groups files into areas. Pure functions over a path, no I/O.
//
// Order of the rules matters and is held by tests: a SECRET-shaped name wins over everything, so a path that looks like a secret is counted and never listed (not in a folder list, not in a chip, not in an area).
// Then vendored and generated folders, lock files, binary assets. Everything else is counted.

export type PathClass = "secret" | "vendored" | "generated" | "lockfile" | "asset";

const SECRET_DIRS = /^(?:\.?secrets?|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.?credentials?|\.env|private[-_]?keys?|keys|certs?|certificates)$/iu;
const SECRET_FILE = new RegExp([
  String.raw`^\.env(?:\..*)?$`, String.raw`^.*\.env$`,
  String.raw`^.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|p8|ppk|tfstate|tfvars|gpg|asc)$`,
  String.raw`^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$`,
  String.raw`^\.(?:npmrc|netrc|pypirc|htpasswd|git-credentials|dockercfg|pgpass)$`,
  String.raw`^credentials?(?:\..*)?$`, String.raw`^kubeconfig(?:\..*)?$`,
  String.raw`^service[-_]?account.*\.json$`,
].join("|"), "iu");
// "secretary" and the like are not secrets: a name is secret-shaped when "secret" stands as a word of its own (start, end or beside a separator).
const SECRET_WORD = /(?:^|[^a-z])secrets?(?:[^a-z]|$)/iu;

const VENDORED_DIRS = new Set(["vendor", "node_modules", "third_party", "third-party", "bower_components", "pods", ".yarn", ".pnpm-store", "site-packages", "__pypackages__", ".venv", "jspm_packages"]);
const GENERATED_DIRS = new Set(["dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit", "coverage", "__generated__", "generated", ".turbo", ".cache", "__pycache__", ".gradle", ".terraform", "storybook-static", ".parcel-cache", ".output"]);
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "cargo.lock", "poetry.lock", "pipfile.lock", "composer.lock", "gemfile.lock", "go.sum", "bun.lockb", "bun.lock", "uv.lock", "flake.lock", "mix.lock", "pubspec.lock", "podfile.lock", "packages.lock.json", "gradle.lockfile"]);
const GENERATED_FILE = /(?:\.min\.(?:js|css)|\.map|\.pb\.go|_pb2(?:_grpc)?\.pyi?|\.generated\.[a-z0-9]+|\.g\.dart|\.pb\.[a-z]+|\.designer\.cs)$/iu;
const ASSET_FILE = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|svgz?|avif|heic|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|bin|dat|pdf|mp[34]|mov|avi|webm|wav|ogg|flac|psd|sketch|fig|wasm|o|a|lib|pyc|sqlite3?|db)$/iu;

/** Whether one path segment (a folder or file name) looks like a secret. */
function secretShaped(name: string, isDirectory: boolean): boolean {
  // A folder is held to the same rules as a file, plus its own list: `prod-secrets/`, `secrets_prod/`, `.env/`, `private-keys/` are as secret-shaped as a file of that name.
  if (isDirectory) return SECRET_DIRS.test(name) || SECRET_WORD.test(name) || SECRET_FILE.test(name);
  return SECRET_FILE.test(name) || SECRET_WORD.test(name);
}

/** Why a path is not counted, or undefined when it is. `path` is from the repository root. */
export function classifyPath(path: string): PathClass | undefined {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  for (let index = 0; index < segments.length - 1; index += 1) if (secretShaped(segments[index]!, true)) return "secret";
  if (secretShaped(name, false)) return "secret";
  for (let index = 0; index < segments.length - 1; index += 1) if (VENDORED_DIRS.has(segments[index]!.toLowerCase())) return "vendored";
  for (let index = 0; index < segments.length - 1; index += 1) if (GENERATED_DIRS.has(segments[index]!.toLowerCase())) return "generated";
  if (LOCKFILES.has(name.toLowerCase()) || /\.lock$/iu.test(name)) return "lockfile";
  if (GENERATED_FILE.test(name)) return "generated";
  if (ASSET_FILE.test(name)) return "asset";
  return undefined;
}

/** Whether a DIRECTORY (by its path) must not be walked into or listed by name: a secret-shaped folder, or one inside such a folder. */
export function secretDirectory(path: string): boolean { return path.split("/").some((segment) => secretShaped(segment, true)); }
/** Whether a directory's own name is a vendored or generated one; `class` says which. */
export function skippedDirectoryClass(name: string): "vendored" | "generated" | undefined {
  const lower = name.toLowerCase();
  return VENDORED_DIRS.has(lower) ? "vendored" : GENERATED_DIRS.has(lower) ? "generated" : undefined;
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", swift: "Swift", cs: "C#", c: "C", h: "C", cc: "C++", cpp: "C++", hpp: "C++", php: "PHP",
  rb: "Ruby", scala: "Scala", sh: "Shell", bash: "Shell", zsh: "Shell", sql: "SQL", html: "HTML", htm: "HTML", css: "CSS", scss: "CSS", less: "CSS", vue: "Vue", svelte: "Svelte",
  dart: "Dart", ex: "Elixir", exs: "Elixir", tf: "Terraform", lua: "Lua", r: "R", m: "Objective-C", mm: "Objective-C", pl: "Perl", clj: "Clojure", hs: "Haskell", erl: "Erlang", groovy: "Groovy",
};

/** The programming language of a file by its name, or undefined for data, docs and unknown text (they are counted as files but are not part of the language mix). */
export function languageOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return "Dockerfile";
  if (name === "Makefile") return "Makefile";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : LANGUAGES[name.slice(dot + 1).toLowerCase()];
}

const CONTAINERS = new Set(["packages", "apps", "services", "libs", "lib", "modules", "src", "internal", "cmd", "plugins", "crates", "projects", "app", "pkg", "components"]);
/** The area a file belongs to: its top folder, or the two top folders under a container folder (`packages/api`). Files at the root belong to ".". */
export function areaOf(path: string): string {
  const segments = path.split("/");
  if (segments.length < 2) return ".";
  if (segments.length >= 3 && CONTAINERS.has(segments[0]!.toLowerCase())) return `${segments[0]!}/${segments[1]!}`;
  return segments[0]!;
}

const TEST_NAMES = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "integration-tests", "cypress", "playwright", "__mocks__"]);
export const isTestFolderName = (name: string): boolean => TEST_NAMES.has(name.toLowerCase());

const DOC_NAMES = new Set(["docs", "doc", "documentation", "wiki", "design", "designs"]);
const CONFIG_NAMES = new Set([".github", ".circleci", ".vscode", ".husky", "config", "configs", ".devcontainer", ".gitlab", "infra", "infrastructure", "deploy", "terraform", "k8s", "helm", "charts"]);
/** What kind of area a folder path is, from its names alone. */
export function areaKindOf(area: string): "source" | "tests" | "docs" | "config" | "other" {
  const segments = area.split("/");
  if (area === ".") return "other";
  if (segments.some(isTestFolderName)) return "tests";
  if (DOC_NAMES.has(segments[0]!.toLowerCase())) return "docs";
  if (CONFIG_NAMES.has(segments[0]!.toLowerCase())) return "config";
  return "source";
}
