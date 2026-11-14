// TE-F1c test support: the laptop `model-egress` adapter in a conformance world: two companies (two owners of one machine's workspaces) sharing the raw ids of their sources, each with its own key in a real product key store and a real
// file meter under a private temp folder, over F1-a's fake provider as the injected transport (nothing here opens a socket).
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEgressRow, ModelEgressScope } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B, TWO_COMPANIES, type IsolationCompany } from "../../packages/testing/src/isolation/two-company.js";
import { modelEgressIsolation, type ModelEgressWorld } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { createFakeProvider, fakeMintedToken } from "../../packages/testing/src/ports/model-egress-fake.js";
import { FIXTURE_VERTEX_CONNECTION, fixtureEgressRows, fixtureKey } from "../../packages/testing/src/ports/model-egress-fixtures.js";
import { createLaptopModelEgress, laptopScope } from "../../packages/broker/src/local/model-egress/adapter.js";
import { createProductKeyStore } from "../../packages/broker/src/local/model-egress/key-store.js";
import { createLocalMeter } from "../../packages/broker/src/local/model-egress/meter.js";

const GENEROUS_CAP = 1_000_000_000;
const PRIVATE: Record<"A" | "B", string> = { A: "private-source-a", B: "private-source-b" };

export interface LaptopWorld extends ModelEgressWorld {
  readonly rowsList: readonly ModelEgressRow[];
  readonly directory: string;
  cleanup(): void;
}

export async function laptopWorld(options: { transport?: Parameters<typeof createLaptopModelEgress>[0]["transport"]; clock?: { now: number } } = {}): Promise<LaptopWorld> {
  const directory = mkdtempSync(join(tmpdir(), "lw-"));
  const rows = fixtureEgressRows();
  const rowsList = Object.values(rows);
  const provider = createFakeProvider(rowsList);
  const isToken = (row: ModelEgressRow): boolean => row.scheme === "gcp-oauth:federation" || row.scheme === "gcp-oauth:key-file";
  const keyOf = (company: IsolationCompany, rowId: string): string => fixtureKey(`${company.label}/${rowId}`);
  const clock = options.clock ?? { now: Date.UTC(2026, 10, 13, 10) };
  const keys = createProductKeyStore({ directory });
  const meter = createLocalMeter({ directory, now: () => clock.now, defaults: { taskCapMicros: GENEROUS_CAP, monthCapMicros: GENEROUS_CAP } });
  const logs: string[] = [];
  for (const company of TWO_COMPANIES) {
    for (const row of rowsList) await keys.set(company.orgId, row.id, { rowId: row.id, key: keyOf(company, row.id), connection: FIXTURE_VERTEX_CONNECTION });
    await keys.set(company.orgId, PRIVATE[company.label], { rowId: rows.gemini.id, key: keyOf(company, PRIVATE[company.label]) });
  }
  const adapter = createLaptopModelEgress({
    rows: rowsList, keys, meter, transport: options.transport ?? provider.transport,
    mintToken: async (owner, sourceId) => fakeMintedToken(owner, sourceId),
    log: (fields) => logs.push(JSON.stringify(fields)),
  });
  const world: LaptopWorld = {
    adapter, rows, rowsList, directory, connection: FIXTURE_VERTEX_CONNECTION,
    scope: (company, sourceId) => laptopScope(company.orgId, sourceId),
    privateSource: (company) => PRIVATE[company.label],
    brokenScope(mode): ModelEgressScope {
      switch (mode) {
        case "throws": return Object.defineProperties({}, { owner: { get: () => { throw new Error("the resolver failed"); } }, source: { get: () => { throw new Error("the resolver failed"); } } }) as unknown as ModelEgressScope;
        case "undefined": return undefined as unknown as ModelEgressScope;
        case "empty": return {} as unknown as ModelEgressScope;
        case "no_company": return { source: "gemini" } as unknown as ModelEgressScope;
      }
    },
    credentialOf: (company, rowId) => {
      const row = rowsList.find((candidate) => candidate.id === rowId);
      return row !== undefined && isToken(row) ? fakeMintedToken(company.orgId, row.id) : keyOf(company, rowId);
    },
    keysOf: (company) => [...rowsList.map((row) => (isToken(row) ? fakeMintedToken(company.orgId, row.id) : keyOf(company, row.id))), keyOf(company, PRIVATE[company.label])],
    provider: { get calls() { return provider.calls; }, script: (...behaviours) => provider.script(...behaviours), reset: () => provider.reset() },
    meterOf: (company) => meter.spentFor(company.orgId),
    setCap: (company, micros) => meter.setCaps(company.orgId, { taskCapMicros: micros }),
    logs: () => logs,
    cleanup() {
      try { chmodSync(directory, 0o700); } catch { /* gone */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
  world.isolation = modelEgressIsolation(world);
  return world;
}
export { COMPANY_A, COMPANY_B };
