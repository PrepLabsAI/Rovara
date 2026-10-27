/** A session source with no session values: the client still syncs before each call, with an empty delta. */
export const noSessionValues = { read: async (): Promise<readonly string[]> => [] };

/** What a fake worker socket answers to `POST /v1/sync`: the sync accepted, naming its own sequence. Returns null for a body that is not a sync. */
export function acceptedSyncAnswer(body: string): { schemaVersion: "rovara-e2e-model-channel/v1"; status: "ok"; syncSeq: number } | null {
  try {
    const parsed = JSON.parse(body) as { syncSeq?: unknown };
    return typeof parsed.syncSeq === "number" ? { schemaVersion: "rovara-e2e-model-channel/v1", status: "ok", syncSeq: parsed.syncSeq } : null;
  } catch { return null; }
}
