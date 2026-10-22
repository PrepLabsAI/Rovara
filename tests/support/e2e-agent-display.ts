import type { E2EDisplayScenario } from "@agentx/contracts";
import { row } from "./e2e-scenario-results.js";

/** The navigation block of a row as the broker derives it from a verified ledger: the model clicked 'Download orders' and the CSV check decided. */
export const agentNavigation = (overrides: Record<string, unknown> = {}) => ({
  steps: [{ goal: "Download the orders export", actedOn: [{ role: "button", name: "Download orders" }], stop: "concluded" as const }],
  modelCalls: 3, routeId: "rovara-e2e-default", decidedBy: ["csv" as const], ...overrides,
});

/** A row of an AI-navigated scenario that passed. */
export const agentRow = (overrides: Partial<E2EDisplayScenario> = {}): E2EDisplayScenario =>
  row({ scenarioId: "owner-export-ai", title: "Owner export ai", agentNavigation: agentNavigation(), ...overrides });
