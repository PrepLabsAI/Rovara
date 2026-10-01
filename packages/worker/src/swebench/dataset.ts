import { SWEBENCH_DATASETS, type SwebenchDataset } from "@agentx/contracts";

/**
 * The fields of a row the runner reads; the swebench harness gets the whole row. A SWE-Bench Pro row
 * names its image `docker_image`, which the loader copies to `image` (spec 044).
 */
export interface SwebenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** The prebuilt x86 image. */
  image: string;
  [field: string]: unknown;
}

const DATASETS_SERVER = "https://datasets-server.huggingface.co";
const PAGE_LENGTH = 100;
/** The filter endpoint answers "the dataset index is loading" while it warms up. */
const FILTER_ATTEMPTS = 6;
const FILTER_RETRY_MS = 10_000;

export interface DatasetOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One instance's row from Hugging Face's datasets server: the filter endpoint first, then a scan of
 * the test split's pages when the filter's index stays unavailable. Throws when the instance is not
 * in the dataset.
 */
export async function loadSwebenchInstance(dataset: SwebenchDataset, instanceId: string, options: DatasetOptions = {}): Promise<SwebenchInstance> {
  const fetchImplementation = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { name, config, family } = SWEBENCH_DATASETS[dataset];
  const where = `"instance_id"='${instanceId.replace(/'/g, "''")}'`;
  const filterUrl = `${DATASETS_SERVER}/filter?${new URLSearchParams({ dataset: name, config, split: "test", where, offset: "0", length: "1" }).toString()}`;
  const instanceRow = (row: Record<string, unknown>, id: string) => normalizedRow(family === "pro" && row.image === undefined ? { ...row, image: row.docker_image } : row, id);
  for (let attempt = 1; attempt <= FILTER_ATTEMPTS; attempt += 1) {
    const page = await readPage(fetchImplementation, filterUrl);
    if (page.rows !== undefined) {
      const row = page.rows[0];
      if (row === undefined) throw new Error(`${instanceId} is not in ${name}`);
      return instanceRow(row, instanceId);
    }
    if (attempt < FILTER_ATTEMPTS) await sleep(FILTER_RETRY_MS);
  }
  // The filter index never became available: scan the split instead.
  for (let offset = 0; ; offset += PAGE_LENGTH) {
    const url = `${DATASETS_SERVER}/rows?${new URLSearchParams({ dataset: name, config, split: "test", offset: String(offset), length: String(PAGE_LENGTH) }).toString()}`;
    const page = await readPage(fetchImplementation, url);
    if (page.rows === undefined) throw new Error(`could not read ${name} from the Hugging Face datasets server: ${page.error ?? "no rows"}`);
    const row = page.rows.find((candidate) => candidate.instance_id === instanceId);
    if (row !== undefined) return instanceRow(row, instanceId);
    if (page.rows.length < PAGE_LENGTH || (page.total !== undefined && offset + PAGE_LENGTH >= page.total)) {
      throw new Error(`${instanceId} is not in ${name}`);
    }
  }
}

async function readPage(fetchImplementation: typeof fetch, url: string): Promise<{ rows?: Array<Record<string, unknown>>; total?: number; error?: string }> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const body = await response.json().catch(() => undefined) as { rows?: unknown; num_rows_total?: unknown; error?: unknown } | undefined;
  if (!response.ok || !Array.isArray(body?.rows)) {
    return { error: typeof body?.error === "string" ? body.error : `HTTP ${response.status}` };
  }
  const rows = body.rows
    .map((entry: unknown) => (entry && typeof entry === "object" ? (entry as { row?: unknown }).row : undefined))
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  return { rows, ...(typeof body.num_rows_total === "number" ? { total: body.num_rows_total } : {}) };
}

function normalizedRow(row: Record<string, unknown>, instanceId: string): SwebenchInstance {
  for (const field of ["instance_id", "repo", "base_commit", "problem_statement", "image"] as const) {
    if (typeof row[field] !== "string" || row[field] === "") throw new Error(`${instanceId}'s row has no ${field}`);
  }
  if (row.instance_id !== instanceId) throw new Error(`the datasets server returned ${String(row.instance_id)} for ${instanceId}`);
  if (!/^[0-9a-f]{40}$/.test(row.base_commit as string)) throw new Error(`${instanceId}'s base commit is not a commit ID`);
  return row as SwebenchInstance;
}

/** A FAIL_TO_PASS or PASS_TO_PASS list, which some datasets store as a JSON string. */
export function testList(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}
