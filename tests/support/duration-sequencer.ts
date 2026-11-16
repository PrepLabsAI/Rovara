// Vitest's sequencer with one change: --shard=N/M takes the Nth share of a split balanced by the recorded run time of each file
// (tests/support/duration-shards.ts), not an even number of files. Ordering inside a shard is vitest's own. Only a run with --shard
// reaches this code, so every other run (one file, tests/linux, the native configs) behaves as before.
import { relative } from "node:path";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";
import { TIMINGS_PATH, loadTimings, planShards } from "./duration-shards.js";

const slash = (path: string): string => path.replaceAll("\\", "/");

export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const root = slash(this.ctx.config.root);
    const relativePath = (spec: TestSpecification): string => slash(relative(root, slash(spec.moduleId)));
    const timings = loadTimings(`${root}/${TIMINGS_PATH}`);
    const mine = new Set(planShards(files.map(relativePath), timings, count)[index - 1]);
    return files.filter((spec) => mine.has(relativePath(spec)));
  }
}
