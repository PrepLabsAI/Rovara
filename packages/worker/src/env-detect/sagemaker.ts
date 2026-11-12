// SageMaker endpoint detector (SM4; design: SageMaker endpoint shim, "How setup detects the need"). Reads the project for the signs that its code calls SageMaker endpoints and says which endpoints, as one dependency
// candidate of the family `aws:sagemaker-runtime`. What it reads:
//   - the SageMaker Runtime client in boto3, the JavaScript SDK v3, the Java SDK v2 and the Go SDK v2, and its invoke calls (the SDK names come from the generated service table, not from a list kept here);
//   - the SageMaker Python SDK's `Predictor`, `ModelBuilder` and `LocalSession` (and `instance_type="local"`);
//   - endpoint names written as literals next to a call, in settings (`*_ENDPOINT_NAME`) and in infrastructure code: CloudFormation and SAM `AWS::SageMaker::Endpoint`, CDK `CfnEndpoint`, Terraform `aws_sagemaker_endpoint`;
//   - the signs of a model the project could serve itself: a `model.tar.gz`, an `inference.py` with the SageMaker handler functions, an inference Dockerfile;
//   - test doubles of the Runtime client (`Stubber`, moto, a mocked client, a cassette): the candidate then carries `fakedByTests`, and Rovara starts nothing.
// Only names, numbers and fixed words leave this file: an endpoint name that is a plain SageMaker name (never one shaped like a key), a signal word and a line. No value from a setting, no host, no payload.
// A call with no literal endpoint name anywhere is a question for a maintainer, never a guess. Detection reads; nothing is run.
import { awsEmulatorServiceRow, looksLikeSecretValue, SAGEMAKER_DETECTION_SIGNALS, SageMakerEndpointNameSchema, type SageMakerDetectionSignal } from "@agentx/contracts";
import { callArguments, candidate, DEPENDENCY_SKIP_DIRS, mergeCandidates } from "./dependency-candidates.js";
import { ownEntries, ownGet, parseSafeYaml } from "./safe-yaml.js";
import { lineOf, type DependencyCandidate, type Detection, type Detector } from "./types.js";

export const SAGEMAKER_FAMILY = "aws:sagemaker-runtime";
export const SAGEMAKER_MAX_CODE_FILES = 400;
export const SAGEMAKER_MAX_CONFIG_FILES = 120;
const MAX_NAMES = 16;

// ---- the names the SDKs use, from the generated table

const ROW = awsEmulatorServiceRow("sagemaker-runtime");
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The three invoke operations, by their SDK-neutral names; every language's spelling is derived from them. */
const OPERATIONS = ["InvokeEndpoint", "InvokeEndpointAsync", "InvokeEndpointWithResponseStream"] as const;
const snake = (name: string): string => name.replace(/(?<!^)([A-Z])/gu, "_$1").toLowerCase();
const camel = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);
/** `SageMaker Runtime` is the table's SDK id: the clients are `SageMakerRuntimeClient` (and `...AsyncClient` in Java). */
const CLIENT = `${(ROW?.sdkId ?? "SageMaker Runtime").replace(/\s+/gu, "")}`;

interface LanguageRules {
  /** The file extensions this language's code uses. */
  files: RegExp;
  /** Text that builds or imports the Runtime client. */
  client: RegExp;
  /** Text that calls an invoke operation. */
  invoke: RegExp;
  /** An endpoint name written as a literal; the name is the first capture group. */
  names: readonly RegExp[];
}

const NAME = String.raw`([A-Za-z0-9](?:-*[A-Za-z0-9]){0,62})`;
const QUOTE = String.raw`["']`;
const LANGUAGES: Readonly<Record<"python" | "javascript" | "java" | "go", LanguageRules>> = {
  python: {
    files: /\.py$/u,
    client: new RegExp(String.raw`\.client\(\s*(?:service_name\s*=\s*)?${QUOTE}${escape(ROW?.boto3Name ?? "sagemaker-runtime")}${QUOTE}`, "u"),
    invoke: new RegExp(String.raw`\b(?:${OPERATIONS.map(snake).join("|")})\s*\(`, "u"),
    names: [
      new RegExp(String.raw`\b(?:EndpointName|endpoint_name)\s*[=:]\s*${QUOTE}${NAME}${QUOTE}`, "gu"),
      new RegExp(String.raw`${QUOTE}EndpointName${QUOTE}\s*:\s*${QUOTE}${NAME}${QUOTE}`, "gu"),
      new RegExp(String.raw`\bPredictor\(\s*(?:endpoint_name\s*=\s*)?${QUOTE}${NAME}${QUOTE}`, "gu"),
    ],
  },
  javascript: {
    files: /\.[cm]?[jt]sx?$/u,
    client: new RegExp(String.raw`${escape(ROW?.jsPackage ?? "@aws-sdk/client-sagemaker-runtime")}|\b${CLIENT}Client\b`, "u"),
    invoke: new RegExp(String.raw`\b(?:${OPERATIONS.map((operation) => `${operation}Command`).join("|")})\b`, "u"),
    names: [new RegExp(String.raw`\bEndpointName\s*:\s*[${"\"'`"}]${NAME}[${"\"'`"}]`, "gu")],
  },
  java: {
    files: /\.(?:java|kt)$/u,
    client: new RegExp(String.raw`${escape(ROW?.javaPackage ?? "software.amazon.awssdk.services.sagemakerruntime")}|\b${CLIENT}(?:Async)?Client\b`, "u"),
    invoke: new RegExp(String.raw`\b(?:${OPERATIONS.map((operation) => `${operation}Request`).join("|")})\b|\.(?:${OPERATIONS.map(camel).join("|")})\s*\(`, "u"),
    names: [new RegExp(String.raw`\.endpointName\(\s*"${NAME}"\s*\)`, "gu"), new RegExp(String.raw`\bendpointName\s*=\s*"${NAME}"`, "gu")],
  },
  go: {
    files: /\.go$/u,
    client: new RegExp(String.raw`${escape(ROW?.goPackage ?? "github.com/aws/aws-sdk-go-v2/service/sagemakerruntime")}|\bsagemakerruntime\.New`, "u"),
    invoke: new RegExp(String.raw`\b(?:${OPERATIONS.map((operation) => `${operation}Input`).join("|")})\b|\.(?:${OPERATIONS.join("|")})\(`, "u"),
    names: [new RegExp(String.raw`\bEndpointName:\s*aws\.String\(\s*"${NAME}"\s*\)`, "gu")],
  },
};
type Language = keyof typeof LANGUAGES;
const languageOf = (path: string): Language | undefined => (Object.keys(LANGUAGES) as Language[]).find((name) => LANGUAGES[name].files.test(path));

// ---- the SageMaker Python SDK

const PYTHON_SDK = {
  // `[ \t]*`, never `\s*`, after a multiline `^`: `\s*` would run across every following blank line from each line start (quadratic on a file of newlines).
  imported: /^[ \t]*(?:from|import)[ \t]+sagemaker\b/mu,
  predictor: /\bPredictor\s*\(/u,
  modelBuilder: /\bModelBuilder\s*\(/u,
  localSession: /\bLocalSession\b|\binstance_type\s*=\s*["']local(?:_gpu)?["']/u,
} as const;

// ---- test doubles of the Runtime client

const RUNTIME_WORDS = new RegExp(String.raw`${escape(ROW?.boto3Name ?? "sagemaker-runtime")}|${CLIENT}|\b(?:${OPERATIONS.map(snake).join("|")})\b|\bPredictor\b`, "u");
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|integration|src\/test|testing)\/|(?:^|\/)conftest\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|(?:Tests?|IT)\.(?:java|kt)$/u;
/** A double of the client or its calls: botocore's `Stubber`, moto, aws-sdk-client-mock, a module mock, Mockito, a recorded cassette, a patch of an invoke call. */
const DOUBLES = new RegExp(
  [
    String.raw`\bStubber\s*\(`, String.raw`\bmock_aws\b`, String.raw`\bmock_sagemaker_?runtime\b`, String.raw`\bmockClient\s*\(\s*${CLIENT}Client`,
    String.raw`\b(?:jest|vi)\.mock\(\s*["']${escape(ROW?.jsPackage ?? "@aws-sdk/client-sagemaker-runtime")}["']`, String.raw`\bmock\(\s*${CLIENT}(?:Async)?Client\.class`, String.raw`@Mock\b[^\n]{0,40}${CLIENT}`,
    String.raw`\b(?:vcr|use_cassette|betamax)\b`, String.raw`\bpatch(?:\.object)?\([^)\n]{0,120}\b(?:${OPERATIONS.map(snake).join("|")}|${CLIENT})`, String.raw`\.(?:${OPERATIONS.map(snake).join("|")})\.return_value\b`,
  ].join("|"),
  "u",
);

// ---- settings

const CONFIG_FILE = /(?:^|\/)(?:\.env(?:\.[A-Za-z0-9_-]+)?|[^/]+\.(?:ya?ml|toml|ini|cfg|json|properties|env))$/u;
/** `SAGEMAKER_ENDPOINT_NAME=fraud-scorer`, `sagemaker_endpoint: fraud-scorer`, `"fraudEndpointName": "fraud-scorer"`. The key is group 1 and the literal group 2; a value with a `${}`, a space or a slash is not a name. */
// One line only: every gap is `[ \t]*`, so no match can start at one line and scan the blank lines after it.
const SETTING_LINE = new RegExp(String.raw`^[ \t]*${QUOTE}?([A-Za-z0-9_.-]{0,60}?(?:endpoint[_.-]?name|sagemaker[_.-]?endpoint)[A-Za-z0-9_.-]{0,20})${QUOTE}?[ \t]*[:=][ \t]*${QUOTE}?${NAME}${QUOTE}?[ \t]*,?[ \t]*(?:[#;][^\n]*)?$`, "gimu");

// ---- infrastructure code

const TERRAFORM_ENDPOINT = /resource\s+"aws_sagemaker_endpoint"\s+"[A-Za-z0-9_-]{1,64}"\s*\{/gu;
const TERRAFORM_NAME = new RegExp(String.raw`^[ \t]*name[ \t]*=[ \t]*"${NAME}"`, "mu");
const CDK_ENDPOINT = /\b(?:Cfn)?Endpoint\s*\(/gu;
const CDK_NAMES = [new RegExp(String.raw`\bendpointName\s*:\s*[${"\"'`"}]${NAME}[${"\"'`"}]`, "u"), new RegExp(String.raw`\bendpoint_name\s*=\s*${QUOTE}${NAME}${QUOTE}`, "u"), new RegExp(String.raw`\.endpointName\(\s*"${NAME}"\s*\)`, "u")];
const IAC_FILE = /\.(?:ya?ml|json|template|tf)$/u;

// ---- model signs

const INFERENCE_SCRIPT = /^[ \t]*def[ \t]+(?:model_fn|predict_fn|input_fn|output_fn)[ \t]*\(/mu;
const DOCKERFILE = /(?:^|\/)(?:Dockerfile(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.-]+\.dockerfile)$/u;
/** An inference image: a base image named for inference or SageMaker, the `/opt/ml` layout, or a container that exposes 8080 and starts `serve` (SageMaker's own contract). */
// Three line-bounded patterns joined in code. The single pattern this replaces put `(?=[\s\S]*^\s*EXPOSE...)` lookaheads in an alternation tried at
// every position: cubic on a Dockerfile of blank lines (12 s at 4 KB), so the hostile-input suite never finished.
const INFERENCE_FROM = /^[ \t]*FROM[ \t]+([^\s]{1,300})/gimu;
const OPT_ML = /\/opt\/ml\b/u;
const EXPOSE_8080 = /^[ \t]*EXPOSE[ \t]+8080\b/imu;
const SERVE_START = /^[ \t]*(?:ENTRYPOINT|CMD)\b[^\n]*\bserve\b/imu;
/** Where a Dockerfile shows an inference image, or undefined: a base image named for inference or SageMaker, the `/opt/ml` layout, or both `EXPOSE 8080` and a start command that runs `serve` (then the file's start, as before). */
function inferenceImageAt(text: string): number | undefined {
  // the old pattern's lookahead branch matched at the file's start, before any later line, so it still wins
  if (EXPOSE_8080.test(text) && SERVE_START.test(text)) return 0;
  INFERENCE_FROM.lastIndex = 0;
  let at: number | undefined;
  for (const match of text.matchAll(INFERENCE_FROM)) {
    const image = (match[1] ?? "").toLowerCase();
    if (image.includes("-inference") || image.includes("sagemaker")) { at = match.index; break; }
  }
  const optMl = OPT_ML.exec(text);
  if (optMl !== null && (at === undefined || optMl.index < at)) at = optMl.index;
  return at;
}

/** The endpoint names a text writes as literals, each with its index. A name that is not SageMaker's own, or is shaped like a key, is not one. */
function literalNames(text: string, patterns: readonly RegExp[]): Array<{ name: string; index: number }> {
  const found: Array<{ name: string; index: number }> = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && SageMakerEndpointNameSchema.safeParse(name).success && !looksLikeSecretValue(name)) found.push({ name, index: match.index });
      if (found.length >= 200) return found;
    }
  }
  return found;
}

interface Sighting { path: string; line: number }
interface Findings {
  signals: Map<SageMakerDetectionSignal, Sighting>;
  names: Map<string, { sighting: Sighting; strength: "used" | "declared" | "mentioned"; code: boolean }>;
  /** Setting names that carry no SageMaker word in their key: kept only when the project uses SageMaker some other way. */
  genericSettings: Map<string, Sighting>;
  doubled: Sighting | undefined;
  /** A code file that calls the Runtime client but names no endpoint (asked about, for Java and Go: Python and JavaScript are asked by the services detector). */
  unnamed: Array<{ path: string; line: number }>;
}

const signal = (found: Findings, name: SageMakerDetectionSignal, path: string, line: number): void => {
  if (!found.signals.has(name)) found.signals.set(name, { path, line });
};
const addName = (found: Findings, name: string, sighting: Sighting, strength: "used" | "declared" | "mentioned", code: boolean): void => {
  const known = found.names.get(name);
  if (known === undefined && found.names.size < MAX_NAMES) found.names.set(name, { sighting, strength, code });
  else if (known !== undefined && code && !known.code) found.names.set(name, { ...known, code });
};

function readCode(path: string, text: string, found: Findings): void {
  const language = languageOf(path);
  if (language === undefined) return;
  if (TEST_FILE.test(path)) {
    const double = DOUBLES.exec(text);
    if (double !== null && RUNTIME_WORDS.test(text) && found.doubled === undefined) found.doubled = { path, line: lineOf(text, double.index) };
    return;
  }
  const rules = LANGUAGES[language];
  const client = rules.client.exec(text);
  const invoke = rules.invoke.exec(text);
  const python = language === "python" && PYTHON_SDK.imported.test(text);
  const predictor = python ? PYTHON_SDK.predictor.exec(text) : null;
  const builder = python ? PYTHON_SDK.modelBuilder.exec(text) : null;
  const local = python ? PYTHON_SDK.localSession.exec(text) : null;
  if (client !== null) signal(found, "runtime_client", path, lineOf(text, client.index));
  if (invoke !== null && (client !== null || python)) signal(found, "invoke_call", path, lineOf(text, invoke.index));
  if (predictor !== null) signal(found, "predictor", path, lineOf(text, predictor.index));
  if (builder !== null) signal(found, "model_builder", path, lineOf(text, builder.index));
  if (local !== null) signal(found, "local_session", path, lineOf(text, local.index));
  const uses = client !== null || predictor !== null || builder !== null || (python && invoke !== null);
  if (!uses) return;
  const names = literalNames(text, rules.names);
  for (const item of names) addName(found, item.name, { path, line: lineOf(text, item.index) }, "used", true);
  // Python and JavaScript are asked about by the services detector; this one asks about the languages it adds.
  if (names.length === 0 && (client !== null || invoke !== null) && (language === "java" || language === "go")) found.unnamed.push({ path, line: lineOf(text, (client ?? invoke)!.index) });
}

function readSettings(path: string, text: string, found: Findings): void {
  SETTING_LINE.lastIndex = 0;
  for (const match of text.matchAll(SETTING_LINE)) {
    const key = match[1] ?? "";
    const name = match[2];
    if (name === undefined || !SageMakerEndpointNameSchema.safeParse(name).success || looksLikeSecretValue(name) || /^(?:true|false|null|none|yes|no|\d+)$/iu.test(name)) continue;
    const sighting = { path, line: lineOf(text, match.index) };
    if (/sagemaker/iu.test(key) || /sagemaker/iu.test(text.slice(Math.max(0, match.index - 400), match.index))) { signal(found, "endpoint_name_setting", path, sighting.line); addName(found, name, sighting, "mentioned", false); }
    else if (found.genericSettings.size < MAX_NAMES && !found.genericSettings.has(name)) found.genericSettings.set(name, sighting);
  }
}

function readTemplate(path: string, text: string, found: Findings): void {
  if (!text.includes("AWS::SageMaker::Endpoint")) return;
  let document: unknown;
  if (path.endsWith(".json")) {
    try { document = JSON.parse(text); } catch { return; }
  } else {
    const parsed = parseSafeYaml(text);
    if (!parsed.ok) return;
    document = parsed.value.toPlain(parsed.value.document.contents);
  }
  for (const [logicalId, resource] of ownEntries(ownGet(document, "Resources")).slice(0, 500)) {
    if (ownGet(resource, "Type") !== "AWS::SageMaker::Endpoint") continue;
    const at = text.indexOf(logicalId);
    const sighting = { path, line: at < 0 ? 1 : lineOf(text, at) };
    signal(found, "endpoint_in_iac", path, sighting.line);
    const literal = ownGet(ownGet(resource, "Properties"), "EndpointName");
    if (typeof literal === "string" && SageMakerEndpointNameSchema.safeParse(literal).success && !looksLikeSecretValue(literal)) addName(found, literal, sighting, "declared", false);
  }
}

function readTerraform(path: string, text: string, found: Findings): void {
  if (!text.includes("aws_sagemaker_endpoint")) return;
  TERRAFORM_ENDPOINT.lastIndex = 0;
  for (const match of text.matchAll(TERRAFORM_ENDPOINT)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("\n}", start);
    const body = text.slice(start, end < 0 ? Math.min(text.length, start + 4_000) : end);
    const sighting = { path, line: lineOf(text, match.index) };
    signal(found, "endpoint_in_iac", path, sighting.line);
    const name = TERRAFORM_NAME.exec(body)?.[1];
    if (name !== undefined && SageMakerEndpointNameSchema.safeParse(name).success && !looksLikeSecretValue(name)) addName(found, name, sighting, "declared", false);
  }
}

function readCdk(path: string, text: string, found: Findings): void {
  if (!/sagemaker/iu.test(text) || !/aws[-_]cdk|CfnEndpoint/u.test(text)) return;
  CDK_ENDPOINT.lastIndex = 0;
  for (const match of text.matchAll(CDK_ENDPOINT)) {
    const open = text.indexOf("(", match.index);
    const args = open < 0 ? "" : callArguments(text, open);
    const sighting = { path, line: lineOf(text, match.index) };
    signal(found, "endpoint_in_iac", path, sighting.line);
    for (const pattern of CDK_NAMES) {
      const name = pattern.exec(args)?.[1];
      if (name !== undefined && SageMakerEndpointNameSchema.safeParse(name).success && !looksLikeSecretValue(name)) { addName(found, name, sighting, "declared", false); break; }
    }
  }
}

/** The model signs of a project: files that say the project builds or serves its own model. Names the first of each. */
function readModelSigns(path: string, text: string | undefined, found: Findings): void {
  if (/(?:^|\/)model\.tar\.gz$/u.test(path)) signal(found, "model_archive", path, 1);
  if (text === undefined) return;
  if (/(?:^|\/)inference\.py$/u.test(path)) { const match = INFERENCE_SCRIPT.exec(text); if (match !== null) signal(found, "inference_script", path, lineOf(text, match.index)); }
  else if (DOCKERFILE.test(path)) { const at = inferenceImageAt(text); if (at !== undefined) signal(found, "inference_image", path, lineOf(text, at)); }
}

const ENDPOINT_SIGNALS: readonly SageMakerDetectionSignal[] = ["runtime_client", "invoke_call", "predictor", "model_builder", "local_session", "endpoint_in_iac", "endpoint_name_setting"];

/** The code signals: the project's own code reaches for a Runtime client, a call, or the Python SDK's endpoint classes. */
const CODE_SIGNALS: readonly SageMakerDetectionSignal[] = ["runtime_client", "invoke_call", "predictor", "model_builder", "local_session"];

/** The candidate and the legacy service entries one repository gives. */
function sagemakerFindings(found: Findings): Partial<Pick<Detection, "dependencies" | "services" | "questions">> {
  if (!ENDPOINT_SIGNALS.some((name) => found.signals.has(name))) return {};
  // A setting whose key does not say SageMaker is read as an endpoint name now that the project is known to use SageMaker.
  for (const [name, sighting] of found.genericSettings) { addName(found, name, sighting, "mentioned", false); signal(found, "endpoint_name_setting", sighting.path, sighting.line); }
  const names = [...found.names.keys()];
  const strength = CODE_SIGNALS.some((name) => found.signals.has(name)) ? "used" : found.signals.has("endpoint_in_iac") ? "declared" : "mentioned";
  const sightings = [...new Map([
    ...[...found.signals.entries()].filter(([name]) => ENDPOINT_SIGNALS.includes(name)).map(([, item]) => item),
    ...[...found.names.values()].map((entry) => entry.sighting),
    ...(found.doubled === undefined ? [] : [found.doubled]),
  ].map((item) => [`${item.path}:${String(item.line)}`, item] as const)).values()];
  const hints = {
    ...(names.length === 0 ? {} : { endpointNames: names }),
    sagemakerSignals: SAGEMAKER_DETECTION_SIGNALS.filter((name) => found.signals.has(name)),
    ...(found.doubled === undefined ? {} : { fakedByTests: true }),
    seenBy: ["sagemaker"],
  };
  // Every sighting is evidence; the first carries the hints and the merge combines them.
  const candidates = sightings.map((item, index): DependencyCandidate => candidate(SAGEMAKER_FAMILY, strength, item, index === 0 ? hints : {}, "model_endpoint"));
  const services = [...found.names.entries()].filter(([, entry]) => entry.code).map(([name, entry]) => ({ value: { kind: "sagemaker_runtime" as const, target: name }, source: entry.sighting }));
  const questions = names.length > 0 ? [] : found.unnamed.slice(0, 4).map((item) => `Which SageMaker endpoint does ${item.path} call? Its name is not written in the code, so it cannot be faked until a maintainer names it (call at line ${String(item.line)}).`);
  return { dependencies: mergeCandidates(candidates), services, questions };
}

export const detectSageMaker: Detector = async ({ repo }) => {
  const found: Findings = { signals: new Map(), names: new Map(), genericSettings: new Map(), doubled: undefined, unnamed: [] };
  const paths = repo.paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path));
  // Model signs need no reading for an archive; the others read the file.
  for (const path of paths) if (/(?:^|\/)model\.tar\.gz$/u.test(path)) readModelSigns(path, undefined, found);
  let code = 0;
  let other = 0;
  for (const path of paths) {
    const isCode = languageOf(path) !== undefined;
    const isConfig = CONFIG_FILE.test(path);
    const isIac = IAC_FILE.test(path);
    const isModel = /(?:^|\/)inference\.py$/u.test(path) || DOCKERFILE.test(path);
    if (!isCode && !isConfig && !isIac && !isModel) continue;
    if (isCode ? code >= SAGEMAKER_MAX_CODE_FILES : other >= SAGEMAKER_MAX_CONFIG_FILES) continue;
    const text = await repo.read(path);
    if (isCode) code += 1; else other += 1;
    if (text === undefined) continue;
    if (isCode) { readCode(path, text, found); if (!TEST_FILE.test(path)) readCdk(path, text, found); if (/(?:^|\/)inference\.py$/u.test(path)) readModelSigns(path, text, found); continue; }
    if (isModel) readModelSigns(path, text, found);
    if (path.endsWith(".tf")) readTerraform(path, text, found);
    else if (isIac) readTemplate(path, text, found);
    // A template is read as a template above; its `EndpointName` is not a setting.
    if (isConfig && !TEST_FILE.test(path) && !text.includes("AWS::")) readSettings(path, text, found);
  }
  return sagemakerFindings(found);
};
