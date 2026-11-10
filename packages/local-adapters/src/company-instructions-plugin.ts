// Port lane P6 (item L1): the `company-instructions` plug-in "file" for the W0 registry. Config entry:
//   { "point": "company-instructions", "name": "file", "module": "@agentx/local-adapters/company-instructions", "settings": { "path": "/Users/me/.rovara/company-instructions.md" } }
// `path` absent: `company-instructions.md` in the state folder the install runs from (`~/.rovara` by default). A relative path is relative to the folder the process runs in. `rovara up` registers this adapter as the default.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { COMPANY_INSTRUCTIONS_FILE_NAME, type PluginModule } from "@agentx/contracts";
import { FileCompanyInstructions } from "./company-instructions-file.js";
import { allowOnly, SettingsError } from "./settings.js";

export const plugin: PluginModule<"company-instructions"> = {
  point: "company-instructions",
  name: "file",
  create(context) {
    const settings = context.settings;
    allowOnly(settings, ["path"]);
    const path = settings.path;
    if (path !== undefined && (typeof path !== "string" || path === "" || path.includes("\u0000"))) throw new SettingsError("path is the file, as text");
    return new FileCompanyInstructions({ path: path === undefined ? join(context.stateDirectory ?? join(homedir(), ".rovara"), COMPANY_INSTRUCTIONS_FILE_NAME) : isAbsolute(path) ? path : resolve(path) });
  },
};

export default plugin;
