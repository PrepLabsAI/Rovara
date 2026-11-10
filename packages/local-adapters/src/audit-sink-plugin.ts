// Port lane P6 (item L2): the `audit-sink` plug-in "document" for the W0 registry: Code's transactional audit sink (`DocumentAuditSink`), writing its rows to the registry's `storage` adapter. Config entry:
//   { "point": "audit-sink", "name": "document", "module": "@agentx/local-adapters/audit-sink" }
// It takes no settings. `rovara up` registers the same sink as the default.
import type { PluginModule } from "@agentx/contracts";
import { DocumentAuditSink } from "./document-audit-sink.js";
import { allowOnly } from "./settings.js";

export const plugin: PluginModule<"audit-sink"> = {
  point: "audit-sink",
  name: "document",
  create(context) {
    allowOnly(context.settings, []);
    // Asked when a record is written, not now: the storage adapter may be loaded after this one.
    return new DocumentAuditSink({ store: () => context.registry.require("storage") });
  },
};

export default plugin;
