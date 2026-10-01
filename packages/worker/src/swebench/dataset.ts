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
/** Pages read at once; the whole of Verified is five pages. */
const PAGE_CONCURRENCY = 6;
const PAGE_ATTEMPTS = 3;

export interface DatasetOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One instance's row from Hugging Face's datasets server, by reading the test split's pages, several
 * at once. Its filter endpoint is not used: while its search index warms up it answers HTTP 500 after
 * up to 90 seconds, which cost runs 4 to 7 minutes on 2026-10-01, while a page answers in under a
 * second. Throws when the instance is not in the dataset.
 */
export async function loadSwebenchInstance(dataset: SwebenchDataset, instanceId: string, options: DatasetOptions = {}): Promise<SwebenchInstance> {
  const fetchImplementation = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { name, config, family } = SWEBENCH_DATASETS[dataset];
  const instanceRow = (row: Record<string, unknown>) => normalizedRow(family === "pro" && row.image === undefined ? { ...row, image: row.docker_image } : row, instanceId);
  const page = async (offset: number) => {
    const url = `${DATASETS_SERVER}/rows?${new URLSearchParams({ dataset: name, config, split: "test", offset: String(offset), length: String(PAGE_LENGTH) }).toString()}`;
    let read = await readPage(fetchImplementation, url);
    for (let attempt = 2; read.rows === undefined && attempt <= PAGE_ATTEMPTS; attempt += 1) {
      await sleep(2_000 * attempt);
      read = await readPage(fetchImplementation, url);
    }
    if (read.rows === undefined) throw new Error(`could not read ${name} from the Hugging Face datasets server: ${read.error ?? "no rows"}`);
    return read;
  };
  const first = await page(0);
  const found = first.rows!.find((candidate) => candidate.instance_id === instanceId);
  if (found !== undefined) return instanceRow(found);
  const total = first.total ?? (first.rows!.length < PAGE_LENGTH ? first.rows!.length : undefined);
  if (total === undefined) throw new Error(`the Hugging Face datasets server did not say how many rows ${name} has`);
  const offsets: number[] = [];
  for (let offset = PAGE_LENGTH; offset < total; offset += PAGE_LENGTH) offsets.push(offset);
  for (let index = 0; index < offsets.length; index += PAGE_CONCURRENCY) {
    const pages = await Promise.all(offsets.slice(index, index + PAGE_CONCURRENCY).map(page));
    for (const read of pages) {
      const row = read.rows!.find((candidate) => candidate.instance_id === instanceId);
      if (row !== undefined) return instanceRow(row);
    }
  }
  throw new Error(`${instanceId} is not in ${name}`);
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
