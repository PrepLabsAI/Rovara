// DEC 254zm: the worker image's own answer to "which images does this install's worker pull and run for test services", for the boot's test-services stage (packages/worker/ec2/test-services-stage.sh).
// Root runs it ONCE per boot from the worker image it pulled by digest, with no network, no capability and a read-only root:
//
//   node /opt/agentx/packages/worker/dist/test-services-mirror-cli.js refs <registry> <environment>
//     one pinned reference per line: the install's copy of each starter image (`<registry>/agentx-<env>--test-services/<image>-<major>/<image>@sha256:<the starter's digest>`)
//   node /opt/agentx/packages/worker/dist/test-services-mirror-cli.js list <registry> <environment> <reference>...
//     one line: the owner list (JSON) of exactly those references that are copies of starters (anything else named is left out), for AGENTX_TEST_SERVICES_OWNER_IMAGES
//
// The names and digests come from @agentx/contracts (test-service-mirror.ts over owner-starter-images.ts), so the stage pulls and the worker runs exactly the digests the broker plans with. Bad arguments exit 2 with a
// fixed line and print nothing on stdout (the stage then offers no test services). Nothing here reads a file, the environment or the network.
import { pathToFileURL } from "node:url";
import { mirroredStarterEntries } from "@agentx/contracts";

/** What the stage reads on stdout, or undefined for arguments it does not take. */
export function testServicesMirrorOutput(argv: readonly string[]): string | undefined {
  const [command, registry, env, ...named] = argv;
  if (registry === undefined || env === undefined) return undefined;
  let entries;
  try { entries = mirroredStarterEntries(registry, env); } catch { return undefined; }
  if (command === "refs" && named.length === 0) return `${entries.map((entry) => entry.reference).join("\n")}\n`;
  if (command === "list" && named.length <= entries.length) {
    const wanted = new Set(named);
    return `${JSON.stringify(entries.filter((entry) => wanted.has(entry.reference)))}\n`;
  }
  return undefined;
}

export function mainTestServicesMirrorCli(argv: readonly string[]): number {
  const output = testServicesMirrorOutput(argv);
  if (output === undefined) {
    console.error("test-services-mirror: bad arguments");
    return 2;
  }
  process.stdout.write(output);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = mainTestServicesMirrorCli(process.argv.slice(2));
