// Rollback floors for Code's model gateway release steps (#1578).
// Read from the pipeline tree, never from a rollback candidate.
import { fileURLToPath } from "node:url";
import type { Ports } from "./types.js";

export const FLOORS_PATH = fileURLToPath(new URL("./rollback-floors.json", import.meta.url));
const SHA40 = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface Floor {
  group: string;
  sha: string | null;
  reason: string;
}

export interface DigestFloor {
  digest: string;
  reason: string;
}

export interface Floors {
  floors: Floor[];
  belowFloorDigests: DigestFloor[];
}

export interface FloorVerdict {
  failures: string[];
  notes: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

function parseFloorEntries(group: string, list: unknown[]): Floor[] {
  return list.map((entry) => {
    const sha = typeof entry === "string" ? text(entry) : isObject(entry) ? text(entry.sha) : null;
    const reason = isObject(entry) ? text(entry.reason) : null;
    return { group, sha: sha !== null && SHA40.test(sha) ? sha : null, reason: reason ?? `the ${group} floor` };
  });
}

function parseBelowFloorDigests(raw: unknown): DigestFloor[] {
  if (!isObject(raw) || !Array.isArray(raw.belowFloor)) return [];
  const out: DigestFloor[] = [];
  for (const entry of raw.belowFloor) {
    const digest = isObject(entry) ? text(entry.digest) : typeof entry === "string" ? text(entry) : null;
    if (digest !== null && DIGEST.test(digest)) {
      const reason = isObject(entry) ? text(entry.reason) : null;
      out.push({ digest, reason: reason ?? "below the model gateway floor" });
    }
  }
  return out;
}

export function parseFloors(raw: string): Floors {
  let file: unknown;
  try { file = JSON.parse(raw); } catch { throw new Error("rollback-floors.json is not JSON"); }
  if (!isObject(file) || file.schema !== 1) throw new Error("rollback-floors.json has no schema 1");
  if (!isObject(file.floors)) throw new Error("rollback-floors.json has no floors object");
  const floors: Floor[] = [];
  for (const [group, list] of Object.entries(file.floors)) {
    if (!Array.isArray(list)) throw new Error(`rollback-floors.json: floors.${group} is not a list`);
    floors.push(...parseFloorEntries(group, list));
  }
  return { floors, belowFloorDigests: parseBelowFloorDigests(file.gatewayDigests) };
}

export function loadFloors(ports: Ports, path = FLOORS_PATH): Floors {
  if (!ports.fs.exists(path)) throw new Error("rollback-floors.json is missing from the pipeline tree: never read as no floors");
  return parseFloors(ports.fs.readText(path));
}

export const gatewayCodeFloors = (floors: Floors): Floor[] => floors.floors.filter((floor) => floor.group === "gatewayCode");
export const codeFloors = (floors: Floors): Floor[] => floors.floors.filter((floor) => floor.group === "code");

export function judgeDigest(floors: Floors, digest: string): string[] {
  const hit = floors.belowFloorDigests.find((entry) => entry.digest === digest);
  return hit === undefined ? [] : [`model gateway digest ${digest.slice(0, 19)}... is below the floor: ${hit.reason}`];
}

async function judgeCommitList(
  ports: Ports,
  list: readonly Floor[],
  repo: string,
  target: string,
  subject: string,
  groupName: string,
): Promise<string[]> {
  const failures: string[] = [];
  const known = async (sha: string): Promise<boolean> => (await ports.exec("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`])).code === 0;
  if (!(await known(target))) return [`${subject} is not in this clone, so it cannot be judged against the ${groupName} floors`];
  for (const floor of list) {
    if (floor.sha === null) {
      failures.push(`a ${groupName} floor is not a full 40-hex sha, so ${subject} cannot be judged (${floor.reason})`);
      continue;
    }
    if (!(await known(floor.sha))) {
      failures.push(`the ${groupName} floor ${floor.sha.slice(0, 12)} is not in this clone, so ${subject} cannot be judged (${floor.reason})`);
      continue;
    }
    const run = await ports.exec("git", ["-C", repo, "merge-base", "--is-ancestor", floor.sha, target]);
    if (run.code === 1) failures.push(`${subject} is below the ${groupName} floor ${floor.sha.slice(0, 12)}: ${floor.reason}`);
    else if (run.code !== 0) failures.push(`git could not compare ${subject} with the ${groupName} floor ${floor.sha.slice(0, 12)} (exit ${run.code})`);
  }
  return failures;
}

export async function judgeGatewayCodeSha(ports: Ports, floors: Floors, repo: string, codeSha: string): Promise<FloorVerdict> {
  const list = gatewayCodeFloors(floors);
  if (list.length === 0) return { failures: [], notes: [`no gatewayCode floors configured for ${codeSha.slice(0, 12)}`] };
  const failures = await judgeCommitList(ports, list, repo, codeSha, `the model gateway Code commit ${codeSha.slice(0, 12)}`, "gatewayCode");
  return { failures, notes: [] };
}

export async function judgeCodeTarget(ports: Ports, floors: Floors, repo: string, target: string): Promise<FloorVerdict> {
  const list = codeFloors(floors);
  if (list.length === 0) return { failures: [], notes: [`no code floors configured for ${target.slice(0, 12)}`] };
  const failures = await judgeCommitList(ports, list, repo, target, `the Code rollback target ${target.slice(0, 12)}`, "code");
  return { failures, notes: [] };
}
