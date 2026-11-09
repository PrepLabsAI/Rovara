// The Rovara env channel (test services, TS15; design test-services.md 4.0.4 and 4.0.5). The one way a run's sandboxes learn where its dependencies are: connection variables built from the catalog's and the dependency's
// templates, AWS endpoints and fake credentials for the run's AWS families, and endpoints that point the calls nobody backed at the sinkhole. Nothing here runs yet (no caller; inert while `tx` is off).
//
// Rules this module keeps, each with a test:
//   - It is a CHANNEL of its own, not `ProjectCommand.env`: project settings still refuse `AWS_*` (contracts/project-node.ts is untouched), and a dependency's own connection variables may not take a name Rovara or the system owns
//     (`reservedDependencyEnvName`), so only this module ever produces an `AWS_*` name, from the fixed templates below.
//   - The worker's own process environment is never read for these values or written with them. The builder returns data; the only place a value is written is `withServiceEnvFile`, through the `HelperFiles` seam (a file on a
//     tmpfs, mode 0600), and the only thing that reaches a docker argument is the path (`--env-file <path>`). The file is removed as soon as the call that needed it has returned, whatever it did. The end-to-end checker's guard
//     (`assertE2EEnvironmentCannotRedirect`) still refuses to start if the worker's own environment holds any of the AWS values.
//   - Every value is checked against a plain form before it is put in a line of the file (one `NAME=value` per line, so a line break would add a variable): the per-run user, password and database use the helper launcher's
//     patterns (service-helpers.ts), a host is one DNS label, a port a number, a region the AWS shape, and a template must still pass the contract's `connectTemplateProblem`.
//   - Fake AWS credentials are letters and digits only and nothing like a key shape. They are registered with the redactor with the per-run passwords, and the setup agent's secret-shape check exempts exactly these two values by
//     value (`SERVICE_ENV_EXEMPT_VALUES`), never by name; any other `AWS_*` value is still a secret.
//   - FOR TS30 (the wiring): this channel's variables must be passed to a command LAST, after anything the project or the task sets, or a name that clashes must be refused: otherwise a repository's own `AWS_ENDPOINT_URL` or
//     `DATABASE_URL` would win over Rovara's. The module itself only refuses a dependency's own clashing names (`reservedDependencyEnvName`).
//   - A per-service endpoint (`AWS_ENDPOINT_URL_<SERVICE>`) is used, not one global endpoint, so a service backed elsewhere can point elsewhere. With an emulator in the run (slice 2), every AWS service the plan did not ask
//     for, and the global `AWS_ENDPOINT_URL` in both sandboxes, point at the EMULATOR: it has them switched off, refuses the call and records it in its ledger, so the broker flags it (a literal sinkhole host is never looked up,
//     so nothing would count a call to it). Without an emulator (slice 1) there is no AWS block at all and the sealed name server counts the names that are looked up.
import { lstat, mkdir, open, rm, chmod } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { CONNECT_TEMPLATE_PLACEHOLDERS, EnvNameSchema, connectTemplateProblem, e2eSecretSpellings, redactText, reservedDependencyEnvName } from "@agentx/contracts";
import { HELPER_CREDENTIAL_PATTERNS, type HelperFiles } from "./service-helpers.js";

export const AWS_FAKE_ACCESS_KEY_ID = "ROVARATESTKEY";
export const AWS_FAKE_SECRET_ACCESS_KEY = "rovaratestsecret";
/** The only values the setup agent's secret-shape check lets through (4.0.5): matched by value, not by name. */
export const SERVICE_ENV_EXEMPT_VALUES: readonly string[] = [AWS_FAKE_ACCESS_KEY_ID, AWS_FAKE_SECRET_ACCESS_KEY];

/** The one error of this module; its message is a fixed sentence and never carries a value. */
export class ServiceEnvError extends Error {
  constructor() {
    super("The test services' environment could not be built");
    this.name = "ServiceEnvError";
  }
}
const refuse = (): never => { throw new ServiceEnvError(); };

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/u;
const VALUE = /^[\x21-\x7e]{1,2048}$/u;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
/** The sinkhole's address: a one-label name (`http://sinkhole`) or an address in the run networks' range, with an optional port. */
const SINKHOLE_URL = /^http:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|172\.30\.\d{1,3}\.\d{1,3})(?::(\d{1,5}))?$/u;

/** The AWS SDK's name for each service Rovara local AWS can serve (`AWS_ENDPOINT_URL_<NAME>`), by catalog service id. A service not listed here is refused: a wrong name would silently not redirect. */
const AWS_SDK_ENDPOINT_NAMES: Readonly<Record<string, string>> = {
  s3: "S3", dynamodb: "DYNAMODB", sqs: "SQS", sns: "SNS", sts: "STS", secretsmanager: "SECRETS_MANAGER", ssm: "SSM", kms: "KMS", events: "EVENTBRIDGE", lambda: "LAMBDA",
  "sagemaker-runtime": "SAGEMAKER_RUNTIME", dynamodbstreams: "DYNAMODB_STREAMS", kinesis: "KINESIS", stepfunctions: "SFN", apigateway: "API_GATEWAY", "cognito-idp": "COGNITO_IDENTITY_PROVIDER", logs: "CLOUDWATCH_LOGS",
};

/** The environment variable that points one AWS service at another address. Refuses a service id the table does not know. */
export function awsEndpointVariableName(serviceId: string): string {
  const name = Object.hasOwn(AWS_SDK_ENDPOINT_NAMES, serviceId) ? AWS_SDK_ENDPOINT_NAMES[serviceId] : undefined;
  return name === undefined ? refuse() : `AWS_ENDPOINT_URL_${name}`;
}

export interface ServiceEnvDependency {
  id: string;
  /** The alias the code reaches it by (one DNS label). */
  host: string;
  port: number;
  region?: string;
  /** The per-run credentials of the helper (the same values the launcher gave it). */
  credentials: { user?: string; password?: string; database?: string };
  connect: { env: ReadonlyArray<{ name: string; template: string }>; hostAliases: readonly string[] };
}

export interface ServiceEnvAws {
  /** The emulator helper's alias and port (`aws`, 4566). */
  alias: string;
  port: number;
  region: string;
  /** Catalog service ids Rovara local AWS serves for this run. */
  emulatedServices: readonly string[];
  /**
   * AWS services the code uses that the plan did not ask the emulator for. With an emulator in the run they point at the EMULATOR (not at a sinkhole): it has them switched off, so it refuses the call AND writes it to its
   * request ledger, which the broker reads and flags as "called AWS services that are not in the plan". A static sinkhole name would be refused too, but nothing would count it (the sealed name server counts only names it is asked
   * to resolve, and a literal endpoint host is not one), so a call whose error the code swallowed would pass unseen.
   */
  unbackedServices: readonly string[];
}

export interface ServiceEnvInput {
  /**
   * Values that must never appear in the environment (the emulator's control token and presign secret, a helper's password that the connection templates do not use). Any entry whose value contains one is refused: those two
   * belong to the helper's own env file and the redactor (`helperSecretValues`), not to the sandboxes.
   */
  neverValues?: readonly string[];
  /** The working sandbox (the agent's shell) or the sealed check sandbox. */
  sandbox: "working" | "check";
  /** Where the sinkhole answers: `http://sinkhole`, or an address of the run's slot. */
  sinkholeUrl: string;
  dependencies: readonly ServiceEnvDependency[];
  aws?: ServiceEnvAws;
}

export interface ServiceEnvironment {
  /** `[name, value]` in the order they are written. */
  entries: ReadonlyArray<readonly [string, string]>;
  /** The values that are secret for this run (passwords and the fake AWS values), for the redactor. */
  secretValues: string[];
}

function plain(value: string | undefined, pattern: RegExp): string {
  return value !== undefined && pattern.test(value) ? value : refuse();
}
function portOf(port: number): number {
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : refuse();
}

function fill(template: string, values: Readonly<Record<string, string | undefined>>): string {
  if (connectTemplateProblem(template) !== undefined) refuse();
  const known = new Set<string>(CONNECT_TEMPLATE_PLACEHOLDERS);
  return template.replace(/\{([a-z]+)\}/gu, (_whole, key: string) => {
    const value = known.has(key) ? values[key] : undefined;
    return value === undefined ? refuse() : value;
  });
}

/**
 * Builds the variables a run's sandboxes get. Pure: nothing is read from or written to the process environment. Refuses (ServiceEnvError, a fixed sentence) on any value that is not in its plain form, any name Rovara or the
 * system owns, a name set twice, a template the contract refuses, or an AWS service the table does not know.
 */
export function buildServiceEnvironment(input: ServiceEnvInput): ServiceEnvironment {
  const entries: Array<readonly [string, string]> = [];
  const names = new Set<string>();
  const secrets = new Set<string>();
  const add = (name: string, value: string): void => {
    if (!EnvNameSchema.safeParse(name).success || names.has(name) || !VALUE.test(value) || (input.neverValues ?? []).some((secret) => secret.length > 0 && value.includes(secret))) refuse();
    names.add(name);
    entries.push([name, value]);
  };
  if (input.sandbox !== "working" && input.sandbox !== "check") refuse();
  const sinkhole = SINKHOLE_URL.exec(input.sinkholeUrl);
  if (sinkhole === null || input.sinkholeUrl.length > 64) refuse();
  if (sinkhole?.[1] !== undefined) portOf(Number(sinkhole[1]));

  const seenIds = new Set<string>();
  for (const dependency of input.dependencies) {
    if (seenIds.has(dependency.id)) refuse();
    seenIds.add(dependency.id);
    const host = plain(dependency.host, DNS_LABEL);
    const port = portOf(dependency.port);
    const user = dependency.credentials.user === undefined ? undefined : plain(dependency.credentials.user, HELPER_CREDENTIAL_PATTERNS.user);
    const password = dependency.credentials.password === undefined ? undefined : plain(dependency.credentials.password, HELPER_CREDENTIAL_PATTERNS.password);
    const db = dependency.credentials.database === undefined ? undefined : plain(dependency.credentials.database, HELPER_CREDENTIAL_PATTERNS.database);
    const region = dependency.region === undefined ? undefined : plain(dependency.region, REGION);
    if (password !== undefined) secrets.add(password);
    const values = { user, password, db, region, host, port: String(port), endpoint: `http://${host}:${String(port)}` };
    for (const variable of dependency.connect.env) {
      // Rovara and the system own their names; a dependency (a repository's proposal) may not take one, `AWS_*` included.
      if (reservedDependencyEnvName(variable.name)) refuse();
      add(variable.name, fill(variable.template, values));
    }
  }

  if (input.aws !== undefined) {
    const aws = input.aws;
    const alias = plain(aws.alias, DNS_LABEL);
    const port = portOf(aws.port);
    const region = plain(aws.region, REGION);
    const emulated = new Set(aws.emulatedServices);
    if (emulated.size !== aws.emulatedServices.length || aws.unbackedServices.some((service) => emulated.has(service)) || new Set(aws.unbackedServices).size !== aws.unbackedServices.length) refuse();
    for (const service of aws.emulatedServices) add(awsEndpointVariableName(service), `http://${alias}:${String(port)}`);
    // Every other service, and the GLOBAL endpoint (for a service no per-service variable names), point at the emulator in both sandboxes: it refuses what it has switched off and counts it in its ledger.
    for (const service of aws.unbackedServices) add(awsEndpointVariableName(service), `http://${alias}:${String(port)}`);
    add("AWS_ENDPOINT_URL", `http://${alias}:${String(port)}`);
    add("AWS_ACCESS_KEY_ID", AWS_FAKE_ACCESS_KEY_ID);
    add("AWS_SECRET_ACCESS_KEY", AWS_FAKE_SECRET_ACCESS_KEY);
    add("AWS_REGION", region);
    add("AWS_DEFAULT_REGION", region);
    add("AWS_EC2_METADATA_DISABLED", "true");
    // Empty, read-only files in every container: no profile, no shared credentials.
    add("AWS_CONFIG_FILE", "/dev/null");
    add("AWS_SHARED_CREDENTIALS_FILE", "/dev/null");
    for (const value of SERVICE_ENV_EXEMPT_VALUES) secrets.add(value);
  }
  return { entries, secretValues: [...secrets] };
}

/**
 * Every secret value of a run's helpers, for the redactor: each helper's password (for Rovara local AWS, its presign secret), its control token and its SQS receipt-handle secret. Pass the result to `createServiceRedactor` and to
 * `ServiceEnvInput.neverValues`; never to `buildServiceEnvironment` as a variable.
 */
export function helperSecretValues(helpers: ReadonlyArray<{ credentials?: { password?: string; controlToken?: string; sqsReceiptSecret?: string } }>): string[] {
  return helpers.flatMap((helper) => [helper.credentials?.password, helper.credentials?.controlToken, helper.credentials?.sqsReceiptSecret]).filter((value): value is string => value !== undefined && value !== "");
}

/**
 * The AWS services of a run that Rovara local AWS does NOT serve: every service the endpoint table knows except the emulated ones. Hand it to `ServiceEnvAws.unbackedServices` so each of them points at the emulator, which refuses and counts it (a call to a
 * service nobody backed fails loudly instead of reaching real AWS). Refuses an emulated id the table does not know.
 */
export function unbackedAwsServices(emulated: readonly string[]): string[] {
  const known = Object.keys(AWS_SDK_ENDPOINT_NAMES);
  if (emulated.some((service) => !Object.hasOwn(AWS_SDK_ENDPOINT_NAMES, service))) refuse();
  return known.filter((service) => !emulated.includes(service));
}

/**
 * Writes the environment as an env file through the seam (a tmpfs, mode 0600), hands `--env-file <path>` to `use`, and removes the file as soon as `use` has finished, whatever it did. An empty environment writes nothing and
 * passes no argument. The name is a plain file name (the file is `<name>.env`).
 */
export async function withServiceEnvFile<T>(files: HelperFiles, name: string, environment: ServiceEnvironment, use: (envFileArgs: string[]) => Promise<T>): Promise<T> {
  if (!FILE_NAME.test(name)) refuse();
  for (const [variable, value] of environment.entries) if (!EnvNameSchema.safeParse(variable).success || !VALUE.test(value)) refuse();
  if (environment.entries.length === 0) return use([]);
  const fileName = `${name}.env`;
  // Written BEFORE the try: a write that fails (the file exists, the disk is full) must not run the removal, which would delete a file that is not this call's.
  const path = await files.write(fileName, `${environment.entries.map(([variable, value]) => `${variable}=${value}`).join("\n")}\n`, 0o600);
  try {
    return await use(["--env-file", path]);
  } finally {
    await files.remove(fileName).catch(() => undefined);
  }
}

// ---- the redactor

const REDACTED = "<redacted>";
/** A value shorter than this is never registered: it would rewrite ordinary words and numbers. */
const MIN_SECRET_LENGTH = 8;

export interface ServiceRedactor {
  /** The text with every registered value, in every spelling, replaced. Also applies the contracts' general credential rule. */
  text(text: string): string;
  /** Whether the bytes hold a registered value in any spelling. */
  contains(bytes: Uint8Array): boolean;
}

/** Registers the run's secret values (passwords and the fake AWS values; fake ones too, so a later mistake cannot make them look like real keys in evidence). */
export function createServiceRedactor(values: readonly string[]): ServiceRedactor {
  const forms = [...new Set(values.filter((value) => value.length >= MIN_SECRET_LENGTH).flatMap((value) => e2eSecretSpellings(value)))].sort((a, b) => b.length - a.length);
  // Case-insensitive, in text and in bytes: a tool that upper- or lower-cases its output (an HTTP header name, a hex dump, an error banner) must not slip a value past. (Closes TS-SEALED-1.)
  const patterns = forms.map((form) => new RegExp(form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"));
  const lowered = forms.map((form) => Buffer.from(form.toLowerCase(), "utf8").toString("latin1"));
  return {
    text(text) {
      let out = text;
      for (const pattern of patterns) out = out.replace(pattern, REDACTED);
      return redactText(out);
    },
    contains(bytes) {
      const haystack = Buffer.from(bytes).toString("latin1").toLowerCase();
      return lowered.some((form) => haystack.includes(form));
    },
  };
}

// ---- the run's directory (the HelperFiles seam's implementation)

/** The only modes a run's directory may have: owner only, or owner plus group search (no read or list, no write) for a helper user that must reach a file it is given by path. */
const RUN_DIRECTORY_MODES: readonly number[] = [0o700, 0o710];

/**
 * Creates a run's directory (`<parent>/<name>`; the caller puts `parent` on a tmpfs) with mode 0700 (or 0710) and checks it afterwards: a real directory (not a link), owned by this process, with exactly that mode, whatever
 * the umask said. An existing directory is refused, so a path somebody else prepared is never reused. Answers the files seam for the directory.
 */
export async function createRunDirectoryFiles(parent: string, name: string, mode: number = 0o700): Promise<HelperFiles & { directory: string }> {
  if (!RUN_DIRECTORY_MODES.includes(mode) || !isAbsolute(parent) || !FILE_NAME.test(name)) refuse();
  const directory = join(parent, name);
  try {
    await mkdir(directory, { mode });
    await chmod(directory, mode);
    const found = await lstat(directory);
    const owner = process.getuid?.();
    if (!found.isDirectory() || found.isSymbolicLink() || (found.mode & 0o777) !== mode || (owner !== undefined && found.uid !== owner)) refuse();
  } catch (error) {
    if (error instanceof ServiceEnvError) throw error;
    return refuse();
  }
  return {
    directory,
    async write(fileName, content, fileMode) {
      if (!FILE_NAME.test(fileName) || !Number.isInteger(fileMode) || fileMode < 0 || fileMode > 0o777) refuse();
      const path = join(directory, fileName);
      // `wx`: the file must not exist (and a link is never followed); the mode is set again after, whatever the umask did.
      const handle = await open(path, "wx", fileMode).catch(() => refuse());
      try {
        await handle.chmod(fileMode);
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return path;
    },
    async remove(fileName) {
      if (!FILE_NAME.test(fileName)) refuse();
      await rm(join(directory, fileName), { force: true });
    },
  };
}

/** Removes the run's directory and everything in it. Never throws. */
export async function removeRunDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
