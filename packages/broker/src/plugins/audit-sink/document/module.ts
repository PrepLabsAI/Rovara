// Port lane P6 (item L2): the `audit-sink` plug-in "document" for the W0 registry: Code's transactional audit sink (`DocumentAuditSink`), writing its rows to the registry's `storage` adapter. Config entry:
//   { "point": "audit-sink", "name": "document", "module": "@agentx/broker/plugins/audit-sink-document" }
// It takes no settings. The hosted product and `rovara up` register the same sink as their default. Moved out of `@agentx/local-adapters/audit-sink` (issue #1538).
import { PluginRegistryError, type PluginModule } from "@agentx/contracts";
import { DocumentAuditSink } from "./sink.js";

export const plugin: PluginModule<"audit-sink"> = {
  point: "audit-sink",
  name: "document",
  create(context) {
    const unknown = Object.keys(context.settings)[0];
    if (unknown !== undefined) throw new PluginRegistryError("bad_config", `unknown setting ${JSON.stringify(unknown).slice(0, 40)}`);
    // Asked when a record is written, not now: the storage adapter may be loaded after this one.
    return new DocumentAuditSink({ store: () => context.registry.require("storage") });
  },
};

export default plugin;
