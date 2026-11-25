// RD-2.0: a served answer, read with the response schema of its row in the Code API route table. The answer must parse AND come out whole (a tolerant schema passes unknown members through and never drops one), so a typo in a member's type
// or a member that stopped being served shows here. `body` is the parsed JSON a route answered.
import { expect } from "vitest";
import { ROUTES, routeIdOf } from "@preplabsai/rovara-code-api";

export function readsAsRow(id: string, body: unknown): void {
  const row = ROUTES.find((route) => routeIdOf(route) === id);
  if (row?.response === undefined) throw new Error(`no row ${id} with a response schema`);
  const parsed = row.response.safeParse(body);
  expect(parsed.success, `${id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
  expect(parsed.data, `${id}: nothing dropped`).toEqual(body);
}
