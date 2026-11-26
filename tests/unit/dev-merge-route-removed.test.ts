// D1-2 (owner DEC 254zzz519): the proof-carrying merge route `POST /v1/dev/tasks/{taskId}/merge` is deleted (nothing in production wired it; Cloud merges through /v1/app/tasks/{id}/merge).
// A press on it now answers exactly what any path the developer router does not serve answers, signed in or not, and reads and writes nothing.
import { describe, expect, it } from "vitest";
import { companyRouteHarness, TASK } from "../support/company-route-harness.js";

const REQUEST = "0b9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8e";

describe("POST /v1/dev/tasks/{taskId}/merge is an unknown route", () => {
  for (const signedIn of [false, true]) {
    it(`answers what an unknown task route answers (${signedIn ? "signed in" : "signed out"})`, async () => {
      const h = companyRouteHarness();
      h.task();
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const headers = signedIn ? { authorization: `Bearer ${part({ alg: "none" })}.${part(h.claims)}.sig` } : {};
      const ask = (suffix: string) => h.read(`/v1/dev/tasks/${TASK}${suffix}`, { method: "POST", headers, body: JSON.stringify({ requestId: REQUEST }) });
      const merge = await ask("/merge");
      const unknown = await ask("/no-such-route");
      expect(merge.statusCode).toBe(unknown.statusCode);
      expect(JSON.parse(merge.body)).toEqual(JSON.parse(unknown.body));
      expect(JSON.stringify(merge.body)).not.toContain("merging from Rovara");
    });
  }
});
