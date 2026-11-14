// A detector thread for the guard's tests: the full pass never finishes (a stand-in for a pattern stuck on a hostile file), the detectors-without-dependencies pass is the real thread.
import { workerData } from "node:worker_threads";

if (!(workerData as { legacyOnly: boolean }).legacyOnly) {
  for (;;) { /* stuck */ }
}
await import("../../packages/worker/src/env-detect/detect-thread.js");
