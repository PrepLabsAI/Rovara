import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BUNDLE_SHA256 = "4f61072bd5c19de3080f59322a5f8dcd4add178341d4a8d839cd1109e87d987f";
const PROVENANCE_SHA256 = "b518878bbad67ed5a4c7798e4911d53b16b13f843953fad5475d6506041d102a";
const EXPECTED_EXPORTS = ["WorkerInvocationSchema", "WorkflowSnapshotSchema"] as const;

interface SafeParsePort {
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown };
}

export interface Rollback0212Parser {
  exports: typeof EXPECTED_EXPORTS;
  WorkerInvocationSchema: SafeParsePort;
  WorkflowSnapshotSchema: SafeParsePort;
}

interface Provenance {
  status: string;
  releaseVersion: string;
  bundleSha256: string;
  bundleBytes: number;
  exports: string[];
}

export async function loadRollback0212Parser(options: {
  fixtureDirectory?: string;
  importModule?: (moduleUrl: string) => Promise<unknown>;
} = {}): Promise<Rollback0212Parser> {
  const fixtureDirectory = options.fixtureDirectory ?? join(dirname(fileURLToPath(import.meta.url)), "../fixtures/rollback-0.2.12");
  const [bundle, provenanceBytes] = await Promise.all([
    readFile(join(fixtureDirectory, "parser-bundle.txt")),
    readFile(join(fixtureDirectory, "provenance.json")),
  ]);
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  if (bundleSha256 !== BUNDLE_SHA256) throw new Error(`0.2.12 parser bundle SHA-256 mismatch: ${bundleSha256}`);
  const provenanceSha256 = createHash("sha256").update(provenanceBytes).digest("hex");
  if (provenanceSha256 !== PROVENANCE_SHA256) throw new Error(`0.2.12 parser provenance SHA-256 mismatch: ${provenanceSha256}`);
  const provenance = JSON.parse(provenanceBytes.toString("utf8")) as Provenance;
  if (provenance.status !== "LOCAL_DERIVED_NOT_PUBLISHED" || provenance.releaseVersion !== "0.2.12"
    || provenance.bundleSha256 !== BUNDLE_SHA256 || provenance.bundleBytes !== bundle.byteLength
    || JSON.stringify(provenance.exports) !== JSON.stringify(EXPECTED_EXPORTS)) {
    throw new Error("0.2.12 parser provenance does not match the pinned fixture");
  }

  const directory = await mkdtemp(join(tmpdir(), "agentx-rollback-0212-"));
  try {
    const modulePath = join(directory, "parser.mjs");
    await writeFile(modulePath, bundle, { flag: "wx" });
    const loaded: unknown = options.importModule === undefined
      ? await import(pathToFileURL(modulePath).href)
      : await options.importModule(pathToFileURL(modulePath).href);
    if (loaded === null || typeof loaded !== "object") throw new Error("0.2.12 parser module did not export an object");
    const exports = Object.keys(loaded).sort();
    if (JSON.stringify(exports) !== JSON.stringify([...EXPECTED_EXPORTS].sort())) {
      throw new Error(`0.2.12 parser exports differ from the allowlist: ${exports.join(",")}`);
    }
    const moduleExports = loaded as Record<string, unknown>;
    const worker = moduleExports.WorkerInvocationSchema;
    const workflow = moduleExports.WorkflowSnapshotSchema;
    if (!isSafeParsePort(worker) || !isSafeParsePort(workflow)) throw new Error("0.2.12 parser exports lack safeParse");
    return { exports: EXPECTED_EXPORTS, WorkerInvocationSchema: worker, WorkflowSnapshotSchema: workflow };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isSafeParsePort(value: unknown): value is SafeParsePort {
  return typeof value === "object" && value !== null && "safeParse" in value
    && typeof value.safeParse === "function";
}
