// Service-call detector: the outside services the code calls, from the code itself. A SageMaker Runtime client and its endpoint name (boto3 or the JS SDK), and HTTP hosts named in configuration files.
// Hosts that are always local, reserved or just a namespace (localhost, example.*, w3.org) are not services.
import { mergeCandidates, urlLiteralCandidates } from "./dependency-candidates.js";
import { codeEnvReferences, codeReferenceFindings, ormConfigCandidates } from "./env-config.js";
import { goCodeCandidates } from "./go.js";
import { javaCodeCandidates } from "./java.js";
import { nodeCodeCandidates, nodeManifestCandidates } from "./node.js";
import { pythonCodeCandidates, pythonManifestCandidates } from "./python.js";
import { type DependencyCandidate, type Detection, type Detector, findLine, lineOf } from "./types.js";

const SOURCE_FILE = /\.(?:py|ts|tsx|js|mjs|cjs)$/u;
const CONFIG_FILE = /(?:^|\/)(?:\.env\.example|[^/]+\.(?:ya?ml|toml|ini|cfg|json|properties))$/u;
const SKIP_DIRS = /(?:^|\/)(?:node_modules|dist|build|\.git|venv|\.venv|vendor|tests?|__tests__|fixtures?)\//u;
const IGNORED_HOSTS = /^(?:localhost|127\.|0\.0\.0\.0|.*\.example\.(?:com|org|net)|example\.(?:com|org|net)|.*\.test|.*\.invalid|.*\.local|www\.w3\.org|json-schema\.org|schemas\.[a-z.]+|xmlns\.com|purl\.org|opensource\.org|github\.com|raw\.githubusercontent\.com|pypi\.org|files\.pythonhosted\.org|registry\.npmjs\.org|npmjs\.org)$/u;
const MAX_FILES = 150;
const MAX_HTTP = 20;
const ENDPOINT = /EndpointName\s{0,40}[=:]\s{0,40}["']([A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))["']/u;

export const detectServices: Detector = async ({ repo }) => {
  const services: Detection["services"] = [];
  const questions: string[] = [];
  const seen = new Set<string>();
  const add = (kind: "sagemaker_runtime" | "http", target: string, source: { path: string; line: number }) => {
    const key = `${kind}:${target}`;
    if (seen.has(key) || (kind === "http" && services.filter((service) => service.value.kind === "http").length >= MAX_HTTP)) return;
    seen.add(key);
    services.push({ value: { kind, target }, source });
  };
  const files = repo.paths.filter((path) => !SKIP_DIRS.test(path));
  for (const path of files.filter((candidate) => SOURCE_FILE.test(candidate)).slice(0, MAX_FILES)) {
    const text = await repo.read(path);
    if (text === undefined || !/sagemaker[-_ ]?runtime|SageMakerRuntime|invoke_endpoint|InvokeEndpoint/iu.test(text)) continue;
    const endpoint = ENDPOINT.exec(text);
    const callLine = findLine(text, /sagemaker[-_ ]?runtime|SageMakerRuntime|invoke_endpoint|InvokeEndpoint/iu) ?? 1;
    if (endpoint?.[1] !== undefined) add("sagemaker_runtime", endpoint[1], { path, line: lineOf(text, endpoint.index) });
    else questions.push(`Which SageMaker endpoint does ${path} call? Its name is not written in the code, so it cannot be mocked until a maintainer names it (call at line ${String(callLine)}).`);
  }
  for (const path of files.filter((candidate) => CONFIG_FILE.test(candidate)).slice(0, MAX_FILES)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::\d{1,5})?(?=[/"'\s,;)]|$)/gu)) {
      const host = match[1]!.toLowerCase();
      if (!host.includes(".") || IGNORED_HOSTS.test(host)) continue;
      add("http", host, { path, line: lineOf(text, match.index) });
    }
  }
  return services.length === 0 && questions.length === 0 ? {} : { services, questions };
};

// ---- SDK calls and drivers in code (test services D5), all languages

const CODE_FILE = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|java|kt|go)$/u;
/** Source files read for SDK calls and drivers; a repository's files beyond this many are not looked at. */
export const SDK_MAX_FILES = 400;

/**
 * AWS clients by service id (`boto3.client("s3")`, `new S3Client`, `S3Client.builder()`, `s3.NewFromConfig`), database / cache / broker / search drivers, and connection URLs written as string literals, in the project's own
 * source (never test folders: the test-side reader is `test-fakes.ts`). A client or driver whose endpoint is written into the code is flagged (`explicitEndpoint`): it bypasses the endpoint variables, and v1 supports
 * connection settings only (owner Q1), so the setup agent proposes a task to move it into a setting. SageMaker Runtime stays with the model-endpoint rule above. Runs as its own detector, after the others, so its
 * reads never take budget from them.
 */
export const detectSdkCalls: Detector = async ({ repo }) => {
  const found: DependencyCandidate[] = [];
  // The settings the code reads (TS-UX-1): a dependency named only by `process.env.DATABASE_URL` is still a dependency.
  const references: Array<{ path: string; name: string; line: number }> = [];
  for (const path of repo.paths.filter((candidate) => CODE_FILE.test(candidate) && !SKIP_DIRS.test(candidate)).slice(0, SDK_MAX_FILES)) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    if (references.length < 400) references.push(...codeEnvReferences(path, text).map((item) => ({ path, ...item })));
    if (path.endsWith(".py")) found.push(...pythonCodeCandidates(path, text));
    else if (path.endsWith(".java") || path.endsWith(".kt")) found.push(...javaCodeCandidates(path, text));
    else if (path.endsWith(".go")) found.push(...goCodeCandidates(path, text));
    else found.push(...nodeCodeCandidates(path, text));
    found.push(...urlLiteralCandidates(path, text));
  }
  // A bare database setting goes to the one database the drivers (in code and in the manifests) name; the manifests are read (cached) only when a reference needs them.
  const fromCode = references.length === 0 ? undefined : codeReferenceFindings(references, [...found, ...await nodeManifestCandidates(repo), ...await pythonManifestCandidates(repo), ...await ormConfigCandidates(repo)]);
  if (fromCode !== undefined) found.push(...fromCode.dependencies);
  const dependencies = mergeCandidates(found);
  const hardCoded = dependencies.filter((item) => item.hints.explicitEndpoint === true);
  const extra = { ...(fromCode === undefined || fromCode.notes.length === 0 ? {} : { notes: fromCode.notes }), ...(fromCode === undefined || fromCode.questions.length === 0 ? {} : { questions: fromCode.questions }) };
  if (dependencies.length === 0) return extra;
  return {
    ...extra,
    dependencies,
    ...(hardCoded.length === 0 ? {} : { notes: [...(extra.notes ?? []), "Some code writes the address of a service into the source instead of reading it from a setting. Rovara points code at its test services through settings only, so a setting has to replace each address first; the setup agent can propose a task for it."] }),
  };
};
