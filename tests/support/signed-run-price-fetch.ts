import { runPriceFor } from "./hosted-run-price.js";

/** Only the fixture's exact gateway/company/model price reads are answered. */
export function signedRunPriceResponse(input: string | URL | Request, companies: readonly string[], models: readonly string[], now = Date.now(), origin = "https://gateway.example"): Response | undefined {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const companyId = companies.find(id => url.pathname === `/v1/service/companies/${id}/rate-quote`);
  const model = url.searchParams.get("model");
  if (url.origin !== origin || companyId === undefined || model === null || !models.includes(model) || url.searchParams.get("runPrice") !== "1") return undefined;
  return Response.json({ runPrice: { ...runPriceFor(model, now), companyId, catalogModel: model } });
}
