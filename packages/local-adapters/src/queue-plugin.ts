// Port lane L3: the `queue` plug-in "sqlite" for the W0 registry. Config entry:
//   { "point": "queue", "name": "sqlite", "module": "@agentx/local-adapters/queue", "settings": { "path": ".rovara/state.db" } }
// The queue may share the store's file (two connections to one WAL file work) or have its own. Not wired into the broker here: lane L4 loads it.
import type { PluginModule } from "@agentx/contracts";
import { allowOnly, databasePath, optionalNumber, synchronousSetting } from "./settings.js";
import { SqliteQueueService } from "./sqlite-queue.js";

export const plugin: PluginModule<"queue"> = {
  point: "queue",
  name: "sqlite",
  create(context) {
    const settings = context.settings;
    allowOnly(settings, ["path", "busyTimeoutMs", "synchronous", "pollMs"]);
    const busyTimeoutMs = optionalNumber(settings, "busyTimeoutMs", 0, 600_000);
    const pollMs = optionalNumber(settings, "pollMs", 1, 60_000);
    const synchronous = synchronousSetting(settings);
    return SqliteQueueService.open({
      path: databasePath(settings),
      now: () => context.now().getTime(),
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
      ...(pollMs === undefined ? {} : { pollMs }),
      ...(synchronous === undefined ? {} : { synchronous }),
    });
  },
};

export default plugin;
