import { sourceStopKey, validClear, type RouteClass, type ClearSourceStop, type CustomerSource, type SourceStop } from "./source-stop.js";
interface OperatorClearPorts {
  meter: { sourceStop(iss: string, cid: string, source: CustomerSource, routeClass?: RouteClass): Promise<SourceStop | undefined>; clearSourceStop(input: ClearSourceStop): Promise<boolean> };
  /** Resolved by STS with the SAME credentials as the meter client. Never supplied as a command-line actor string. */
  identity(): Promise<string>;
  interactive: boolean;
  preview(value: unknown): void;
  confirm(exactPhrase: string): Promise<boolean>;
}
/** No server route calls this. Noninteractive callers and workload role identities cannot clear a stop. */
export async function runOperatorClear(input: Pick<ClearSourceStop, "iss" | "cid" | "source" | "routeClass" | "reason">, ports: OperatorClearPorts): Promise<boolean> {
  if (!ports.interactive) throw new Error("operator clear requires a terminal");
  const actor = await ports.identity();
  if (!validClear({ ...input, actor, expectedStopId: "preview" })) throw new Error("operator clear refused");
  const routeClass = input.routeClass === "legacy" ? undefined : input.routeClass;
  const stop = await ports.meter.sourceStop(input.iss, input.cid, input.source, routeClass);
  if (stop?.stopped !== true || stop.stopId === undefined || stop.inFlight !== undefined) return false;
  ports.preview({ ...input, ...stop, routeClass: input.routeClass, recordKey: sourceStopKey(input.source, routeClass), actor, changes: "Clear only this route class stop; preserve spend, caps and in-flight calls." });
  if (!await ports.confirm(`CLEAR ${input.cid} ${input.source} ${input.routeClass} ${stop.stopId}`)) return false;
  // CAS on the previewed stop; a new overage or in-flight call requires a fresh preview and confirmation.
  return ports.meter.clearSourceStop({ ...input, actor, expectedStopId: stop.stopId });
}
