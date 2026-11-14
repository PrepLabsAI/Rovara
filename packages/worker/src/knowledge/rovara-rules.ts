// Knowledge resolver (K1, C2): Rovara's own rule folder in a meta repo, `.rovara/rules/*.md` (the default of `knowledge.steering`), and any
// other steering folder a project names in its config. The keys are the same as Kiro's steering files (`inclusion`, `fileMatchPattern`,
// `name`, `description`), so a team that writes Rovara rules and Kiro steering writes one shape. Rovara's company, group and project rules
// from "How we work" are not files: they reach the resolver as ready-made items (`external` in resolve.ts).
import { kiroSteeringReader } from "./kiro.js";
import type { KnowledgeFormatReader } from "./reader.js";

export const rovaraRulesReader: KnowledgeFormatReader = {
  id: "rovara_rule",
  discovery: { directories: [".rovara/rules"] },
  accepts: (path) => path.startsWith(".rovara/rules/") && path.endsWith(".md"),
  parse: (path, text, context) => kiroSteeringReader.parse(path, text, context),
};
