// Port lane L9a: the `object-storage` plug-in "folder" for the W0 registry (provisional, owner decision 58). Config entry:
//   { "point": "object-storage", "name": "folder", "module": "@agentx/local-adapters/object-storage",
//     "settings": { "path": "/Users/me/.rovara/objects", "maxObjectMiB": 256, "retentionDays": { "evidence-std": 30 } } }
// `path` absent: `~/.rovara/objects`. A relative path is relative to the folder the process runs in.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { JsonObject, PluginModule } from "@agentx/contracts";
import { FolderObjectStorage, FOLDER_OBJECT_DEFAULT_MAX_BYTES } from "./folder-object-storage.js";
import { allowOnly, optionalNumber, SettingsError } from "./settings.js";

function retentionDaysOf(value: JsonObject[string] | undefined): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SettingsError("retentionDays is an object of retention class to days");
  const days: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 3_650) throw new SettingsError(`retentionDays.${name.slice(0, 40)} is a whole number of days from 1 to 3650`);
    days[name] = count;
  }
  return days;
}

export const plugin: PluginModule<"object-storage"> = {
  point: "object-storage",
  name: "folder",
  create(context) {
    const settings = context.settings;
    allowOnly(settings, ["path", "maxObjectMiB", "retentionDays"]);
    const path = settings.path;
    if (path !== undefined && (typeof path !== "string" || path === "" || path.includes("\u0000"))) throw new SettingsError("path is the folder, as text");
    const maxMiB = optionalNumber(settings, "maxObjectMiB", 1, 4_096);
    const retentionDays = retentionDaysOf(settings.retentionDays);
    return new FolderObjectStorage({
      root: path === undefined ? join(homedir(), ".rovara", "objects") : isAbsolute(path) ? path : resolve(path),
      maxObjectBytes: maxMiB === undefined ? FOLDER_OBJECT_DEFAULT_MAX_BYTES : maxMiB * 1_048_576,
      now: () => context.now().getTime(),
      ...(retentionDays === undefined ? {} : { retentionDays }),
    });
  },
};

export default plugin;
