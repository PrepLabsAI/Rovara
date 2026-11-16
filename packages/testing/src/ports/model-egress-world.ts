// The fake `model-egress` adapter world: two companies that share the raw ids of their sources (each row's id), each with its own key, a source only each owns, and the in-process adapter from `model-egress-fake.ts` over a fake
// provider. Used by the conformance suite in this lane's CI; a real adapter writes its own world with the same shape.
import type { ModelEgressRow, ModelEgressScope } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B, TWO_COMPANIES, type IsolationCompany } from "../isolation/two-company.js";
import { createFakeEgress, createFakeProvider, fakeMintedToken, fakeScope, type FakeSource, type ModelEgressMutation } from "./model-egress-fake.js";
import { FIXTURE_VERTEX_CONNECTION, fixtureEgressRows, fixtureKey } from "./model-egress-fixtures.js";
import { modelEgressIsolation, type ModelEgressWorld } from "./model-egress-conformance.js";

const GENEROUS_CAP = 1_000_000_000;
const PRIVATE: Record<"A" | "B", string> = { A: "private-source-a", B: "private-source-b" };

/** A world on the fake adapter. `mutation` switches on one named defect (see `ModelEgressMutation`) so the suite's power to fail can be shown. */
export function fakeModelEgressWorld(mutation?: ModelEgressMutation): ModelEgressWorld & { readonly rowsList: readonly ModelEgressRow[] } {
  const rows = fixtureEgressRows();
  const rowsList = Object.values(rows);
  const provider = createFakeProvider(rowsList);
  const isToken = (row: ModelEgressRow): boolean => row.scheme === "gcp-oauth:federation" || row.scheme === "gcp-oauth:key-file";
  const keyOf = (company: IsolationCompany, rowId: string): string => fixtureKey(`${company.label}/${rowId}`);
  const sources: FakeSource[] = [];
  for (const company of TWO_COMPANIES) {
    for (const row of rowsList) sources.push({ company: company.orgId, id: row.id, row, connection: FIXTURE_VERTEX_CONNECTION, key: keyOf(company, row.id), capMicros: GENEROUS_CAP });
    sources.push({ company: company.orgId, id: PRIVATE[company.label], row: rows.gemini, connection: {}, key: keyOf(company, PRIVATE[company.label]), capMicros: GENEROUS_CAP });
  }
  const egress = createFakeEgress({ rows: rowsList, sources, provider, ...(mutation === undefined ? {} : { mutation }) });
  const world: ModelEgressWorld & { readonly rowsList: readonly ModelEgressRow[] } = {
    adapter: egress.adapter,
    rows,
    rowsList,
    connection: FIXTURE_VERTEX_CONNECTION,
    scope: (company, sourceId) => fakeScope(company.orgId, sourceId),
    privateSource: (company) => PRIVATE[company.label],
    brokenScope(mode) {
      switch (mode) {
        case "throws":
          return Object.defineProperties({}, { company: { get: () => { throw new Error("the company resolver failed"); } }, source: { get: () => { throw new Error("the company resolver failed"); } } }) as unknown as ModelEgressScope;
        case "undefined":
          return undefined as unknown as ModelEgressScope;
        case "empty":
          return {} as unknown as ModelEgressScope;
        case "no_company":
          return { source: "gemini" } as unknown as ModelEgressScope;
      }
    },
    credentialOf(company, rowId) {
      const row = rows[rowId as keyof typeof rows] ?? rowsList.find((candidate) => candidate.id === rowId)!;
      return isToken(row) ? fakeMintedToken(company.orgId, row.id) : keyOf(company, row.id);
    },
    keysOf: (company) => [...rowsList.map((row) => (isToken(row) ? fakeMintedToken(company.orgId, row.id) : keyOf(company, row.id))), keyOf(company, PRIVATE[company.label])],
    provider: {
      get calls() {
        return provider.calls;
      },
      script: (...behaviours) => provider.script(...behaviours),
      reset: () => provider.reset(),
    },
    meterOf: async (company) => egress.meterOf(company.orgId),
    setCap: async (company, micros) => egress.setCap(company.orgId, micros),
    logs: () => egress.logs,
  };
  world.isolation = modelEgressIsolation(world);
  return world;
}

export { COMPANY_A, COMPANY_B };
