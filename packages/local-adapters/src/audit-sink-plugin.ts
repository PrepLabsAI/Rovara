// Port lane P6 (item L2): the `audit-sink` plug-in "sqlite" for the W0 registry. Config entry:
//   { "point": "audit-sink", "name": "sqlite", "module": "@agentx/local-adapters/audit-sink", "settings": { "path": "/Users/me/.rovara/audit.db" } }
// `path` absent: `~/.rovara/audit.db`. A relative path is relative to the folder the process runs in. `rovara up` registers this log as the default.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PluginModule } from "@agentx/contracts";
import { allowOnly, optionalNumber, synchronousSetting, SettingsError } from "./settings.js";
import { SqliteAuditLog } from "./sqlite-audit-log.js";

export const plugin: PluginModule<"audit-sink"> = {
  point: "audit-sink",
  name: "sqlite",
  create(context) {
    const settings = context.settings;
    allowOnly(settings, ["path", "busyTimeoutMs", "synchronous"]);
    const path = settings.path;
    if (path !== undefined && (typeof path !== "string" || path === "" || path.includes("\u0000") || path === ":memory:" || path.startsWith("file:"))) throw new SettingsError("path is the database file, as text");
    const busyTimeoutMs = optionalNumber(settings, "busyTimeoutMs", 0, 600_000);
    const synchronous = synchronousSetting(settings);
    return SqliteAuditLog.open({
      path: path === undefined ? join(homedir(), ".rovara", "audit.db") : isAbsolute(path) ? path : resolve(path),
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
      ...(synchronous === undefined ? {} : { synchronous }),
    });
  },
};

export default plugin;
