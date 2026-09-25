import { agentXError } from "@agentx/contracts";
import { adminResponseBody } from "./http.js";

const DURATION = /^(\d{1,4})([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const RETENTION_MS = 30 * UNIT_MS.d;
/** Guards against an endless export if the control plane ever hands back a growing cursor chain. */
const MAX_PAGES = 10_000;

/** "30m", "12h" or "7d" before now, as the ISO time the export route expects. */
export function parseSince(value: string, now = Date.now()): string {
  const match = DURATION.exec(value.trim());
  if (!match) throw agentXError("CONFIG_INVALID", "--since must be a duration such as 30m, 12h or 7d");
  const milliseconds = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (milliseconds <= 0 || milliseconds > RETENTION_MS) {
    throw agentXError("CONFIG_INVALID", "--since must be more than zero and at most 30d; turn records are kept 30 days");
  }
  return new Date(now - milliseconds).toISOString();
}

export async function exportTurns(
  input: { controlPlaneUrl: string; accessToken: string; since: string; write: (line: string) => void | Promise<void> },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ exported: number; since: string }> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let exported = 0;
  let pages = 0;
  do {
    pages += 1;
    if (pages > MAX_PAGES) throw agentXError("RUNTIME_UNAVAILABLE", "turn record export did not finish after 10000 pages; try a narrower --since");
    // toISOString() always ends in Z, never "+", so URLSearchParams (which turns a literal
    // "+" into a space) never mangles it; percent-encoding is handled by URLSearchParams itself.
    const url = new URL(`${input.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/turns`);
    url.searchParams.set("since", input.since);
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const page = await adminResponseBody(await fetchImplementation(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    })) as { turns?: unknown; cursor?: unknown };
    if (!Array.isArray(page.turns) || (page.cursor !== undefined && typeof page.cursor !== "string")) {
      throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid turn page");
    }
    // A page can come back short or empty and still carry a cursor: expired items are filtered
    // out after DynamoDB applies its Limit. Keep following the cursor until it is absent.
    for (const turn of page.turns) {
      await input.write(`${JSON.stringify(turn)}\n`);
      exported += 1;
    }
    cursor = page.cursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw agentXError("RUNTIME_UNAVAILABLE", "control plane repeated a turn page cursor; export stopped");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return { exported, since: input.since };
}
