import { readFileSync } from "node:fs";
import { WebApiProbeLiveTargetsSchema, isWebApiPrivateIpv4, type WebApiProbeLiveTargets } from "@agentx/contracts";

const RESOLV_FILES = ["/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"] as const;

/** The name servers of the host's resolver files, the same two files the host firewall reads (`packages/worker/ec2/boot.sh`), in order, once each. */
export function hostNameServers(read: (path: string) => string = (path) => readFileSync(path, "utf8")): string[] {
  const found: string[] = [];
  for (const file of RESOLV_FILES) {
    let text: string;
    try { text = read(file); } catch { continue; }
    for (const line of text.split("\n")) {
      const address = /^nameserver\s+(\S+)\s*$/u.exec(line)?.[1];
      if (address !== undefined && !found.includes(address)) found.push(address);
    }
  }
  return found;
}

/**
 * The live private targets of the private-network probe, read on the runner: its real VPC resolver (the first private IPv4 name server of the worker's resolver files, which the launcher gave
 * from the host) and its own private address (the host of the challenge endpoint, which the qualifier has already shown is an address of this host). Undefined when either is missing or not a
 * private IPv4 address: the probe then does not run, so a qualification never rests on addresses nothing answers on.
 */
export function webApiLiveTargets(input: { endpoint: string; nameServers?: () => readonly string[] }): WebApiProbeLiveTargets | undefined {
  let host: string;
  let resolver: string | undefined;
  try { host = new URL(input.endpoint).hostname; resolver = (input.nameServers ?? hostNameServers)().find(isWebApiPrivateIpv4); } catch { return undefined; }
  const parsed = WebApiProbeLiveTargetsSchema.safeParse({ resolver, host });
  return parsed.success ? parsed.data : undefined;
}
