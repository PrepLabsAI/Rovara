// TE-F2 part B (M2, release 0.5.19; DECISIONS 158): the command line of the scripted-replies model helper, built and read in one place. The helper is `node dist/model-helper.js` from the worker's own image (the fake helper's
// pattern, fake-helper.ts); F1-b's `model-helper-launch.ts` imports `modelHelperArgs` to build the container's arguments, the laptop path (`model-helper-local.ts`) uses the same builder for its loopback child, and the
// helper parses the same line with `parseModelHelperArgs`. Numbers, addresses, enum words and file paths only: no secret, no URL, no host name (a project id is a plain Google id, never a secret).
//
//   SERVE      --listen <ipv4> --port <n> [--meta-port <n>] --caller <ipv4> --mode scripted|replay|record|real --rows <file> --replies <file> --digest <64 hex> --ledger <file>
//              --block-state by_name|not_blocked_here [--project-id <id>] [--record-escapes]
//   SUMMARIZE  --summarize --ledger <file>
//
// `--digest` pins the reply bundle the worker wrote (the helper serves nothing that does not hash to it). `--block-state` says whether model hosts are blocked by name in the sandbox the helper serves (`by_name`, hosted) or
// not blocked at all (`not_blocked_here`, the laptop): the worker decides it, never the request. `--record-escapes` binds ports 443 and 80 on the listen address to record the NAME of a client that ignored its redirect
// (F1-b's recorder does the reading; model-helper-http.ts). Port 0 (an ephemeral port) is allowed only on a loopback address (the laptop). PURE: no I/O.
import { isIP } from "node:net";

export const MODEL_HELPER_MODES = ["scripted", "replay", "record", "real"] as const;
export type ModelHelperMode = (typeof MODEL_HELPER_MODES)[number];
export const MODEL_BLOCK_STATES = ["by_name", "not_blocked_here"] as const;
export type ModelBlockState = (typeof MODEL_BLOCK_STATES)[number];

/** Where F1-b's launch mounts the worker's run files (read-only) and where the ledger lives (the helper's own tmpfs: F1-b's launch needs ONE `--tmpfs` line for it). */
export const MODEL_HELPER_RUN_DIR = "/rovara/models";
export const MODEL_HELPER_ROWS_PATH = `${MODEL_HELPER_RUN_DIR}/rows.json`;
export const MODEL_HELPER_REPLIES_PATH = `${MODEL_HELPER_RUN_DIR}/replies.json`;
export const MODEL_HELPER_LEDGER_DIR = "/rovara/ledger";
export const MODEL_HELPER_LEDGER_PATH = `${MODEL_HELPER_LEDGER_DIR}/model-ledger.jsonl`;
export const MODEL_HELPER_ENTRY = "/opt/agentx/packages/worker/dist/model-helper.js";
export const MODEL_HELPER_DEFAULT_PORT = 8080;
export const MODEL_HELPER_DEFAULT_META_PORT = 8081;

const DIGEST = /^[a-f0-9]{64}$/u;
const FILE_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,12}$/u;
/** A Google Cloud project id: 6 to 30 lower-case letters, digits and hyphens, a letter first, no trailing hyphen. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;

/** The one error of this module; its message is a fixed word and carries no value. */
export class ModelHelperArgsRefused extends Error {
  constructor(readonly reason: "arguments") {
    super(`model helper arguments refused: ${reason}`);
    this.name = "ModelHelperArgsRefused";
  }
}
const refuse = (): never => {
  throw new ModelHelperArgsRefused("arguments");
};

export interface ModelHelperServeArgs {
  readonly listen: string;
  readonly port: number;
  readonly metaPort: number | undefined;
  readonly caller: string;
  readonly mode: ModelHelperMode;
  readonly rows: string;
  readonly replies: string;
  readonly digest: string;
  readonly ledger: string;
  readonly blockState: ModelBlockState;
  readonly projectId: string | undefined;
  readonly recordEscapes: boolean;
}
export interface ModelHelperSummarizeArgs {
  readonly ledger: string;
}

const isLoopback = (address: string): boolean => /^127\./u.test(address);
const port = (value: number, allowZero: boolean): number => (Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65_535 ? value : refuse());
const ipv4 = (value: string): string => (isIP(value) === 4 ? value : refuse());
const filePath = (value: string): string => (FILE_PATH.test(value) && !value.split("/").includes("..") ? value : refuse());

function validate(args: ModelHelperServeArgs): ModelHelperServeArgs {
  const listen = ipv4(args.listen);
  if (listen === "0.0.0.0") refuse();
  const loopback = isLoopback(listen);
  const checked: ModelHelperServeArgs = {
    listen,
    port: port(args.port, loopback),
    metaPort: args.metaPort === undefined ? undefined : port(args.metaPort, loopback),
    caller: ipv4(args.caller),
    mode: (MODEL_HELPER_MODES as readonly string[]).includes(args.mode) ? args.mode : refuse(),
    rows: filePath(args.rows),
    replies: filePath(args.replies),
    digest: DIGEST.test(args.digest) ? args.digest : refuse(),
    ledger: filePath(args.ledger),
    blockState: (MODEL_BLOCK_STATES as readonly string[]).includes(args.blockState) ? args.blockState : refuse(),
    projectId: args.projectId === undefined ? undefined : PROJECT_ID.test(args.projectId) ? args.projectId : refuse(),
    recordEscapes: args.recordEscapes === true,
  };
  // The metadata port and the main port are two listeners: on a fixed port pair they must differ.
  if (checked.metaPort !== undefined && checked.metaPort === checked.port && checked.port !== 0) refuse();
  return checked;
}

/** The argv of serving, for the launch (F1-b) and the laptop child. Throws `ModelHelperArgsRefused` for any value that is not one the helper accepts. */
export function modelHelperArgs(input: ModelHelperServeArgs): string[] {
  const args = validate(input);
  return [
    "--listen", args.listen,
    "--port", String(args.port),
    ...(args.metaPort === undefined ? [] : ["--meta-port", String(args.metaPort)]),
    "--caller", args.caller,
    "--mode", args.mode,
    "--rows", args.rows,
    "--replies", args.replies,
    "--digest", args.digest,
    "--ledger", args.ledger,
    "--block-state", args.blockState,
    ...(args.projectId === undefined ? [] : ["--project-id", args.projectId]),
    ...(args.recordEscapes ? ["--record-escapes"] : []),
  ];
}

/** The argv of the summary read (`docker exec ... node dist/model-helper.js --summarize --ledger <file>`). */
export function modelHelperSummarizeArgs(ledger: string): string[] {
  return ["--summarize", "--ledger", filePath(ledger)];
}

function valuesOf(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] !== `--${name}`) continue;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) refuse();
    values.push(value as string);
  }
  return values;
}
function one(argv: readonly string[], name: string): string {
  const values = valuesOf(argv, name);
  return values.length === 1 ? (values[0] as string) : refuse();
}
const optionalOne = (argv: readonly string[], name: string): string | undefined => {
  const values = valuesOf(argv, name);
  return values.length === 0 ? undefined : values.length === 1 ? values[0] : refuse();
};
const wholeNumber = (text: string): number => (/^\d{1,5}$/u.test(text) ? Number(text) : refuse());

/** Strict: an unknown flag, a repeated one, a flag with no value, a name instead of an address, a wildcard listen address or a path with `..` is refused. */
export function parseModelHelperArgs(argv: readonly string[]): ModelHelperServeArgs {
  const flags = new Set(["listen", "port", "meta-port", "caller", "mode", "rows", "replies", "digest", "ledger", "block-state", "project-id", "record-escapes"]);
  const valueFlags = new Set([...flags].filter((flag) => flag !== "record-escapes"));
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at] as string;
    if (!token.startsWith("--")) {
      // A value: it must follow a value flag.
      if (!valueFlags.has((argv[at - 1] ?? "").slice(2))) refuse();
      continue;
    }
    if (!flags.has(token.slice(2))) refuse();
  }
  const records = argv.filter((token) => token === "--record-escapes").length;
  if (records > 1) refuse();
  const meta = optionalOne(argv, "meta-port");
  return validate({
    listen: one(argv, "listen"),
    port: wholeNumber(one(argv, "port")),
    metaPort: meta === undefined ? undefined : wholeNumber(meta),
    caller: one(argv, "caller"),
    mode: one(argv, "mode") as ModelHelperMode,
    rows: one(argv, "rows"),
    replies: one(argv, "replies"),
    digest: one(argv, "digest"),
    ledger: one(argv, "ledger"),
    blockState: one(argv, "block-state") as ModelBlockState,
    projectId: optionalOne(argv, "project-id"),
    recordEscapes: records === 1,
  });
}

export function parseModelHelperSummarizeArgs(argv: readonly string[]): ModelHelperSummarizeArgs {
  const known = new Set(["summarize", "ledger"]);
  for (const token of argv) if (token.startsWith("--") && !known.has(token.slice(2))) refuse();
  if (argv.filter((token) => token === "--summarize").length !== 1) refuse();
  const extras = argv.filter((token, at) => !token.startsWith("--") && argv[at - 1] !== "--ledger");
  if (extras.length > 0) refuse();
  return { ledger: filePath(one(argv, "ledger")) };
}
