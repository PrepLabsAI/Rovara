// The spec renderers. Importing this registers the shipped formats; a plug-in registers its own with `registerSpecRenderer`.
import { kiroRenderer } from "./render-kiro.js";
import { rovaraRenderer } from "./render-rovara.js";
import { specKitRenderer } from "./render-speckit.js";
import { teamTemplateRenderer } from "./render-team-template.js";
import { registerSpecRenderer, specRendererFor } from "./renderer.js";

for (const renderer of [kiroRenderer, specKitRenderer, teamTemplateRenderer, rovaraRenderer]) if (specRendererFor(renderer.format) === undefined) registerSpecRenderer(renderer);

export * from "./renderer.js";
export { kiroRenderer, KIRO_BUGFIX_SECTIONS } from "./render-kiro.js";
export { specKitRenderer } from "./render-speckit.js";
export { teamTemplateRenderer, slotOfHeading } from "./render-team-template.js";
export { rovaraRenderer } from "./render-rovara.js";
