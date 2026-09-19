import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFixtureDirectory(prefix = "agentx-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
