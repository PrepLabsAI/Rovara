import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { nativeP0Files, sharedVitestSettings } from "./tests/support/vitest-shared-config.js";

const lessonsSource = (file: string): string => fileURLToPath(new URL(`./packages/lessons/src/${file}`, import.meta.url));

export default defineConfig({
  // Tests import the lessons engine's source files by path (packages/lessons/src/...) and the laptop app in core imports it by package name. Without this the package name
  // would resolve to the built `dist`, a second copy of every module: a class or a module-level switch (`setLearnedLessonsGate`) set through one copy is not seen through the other.
  resolve: {
    alias: [
      { find: /^@rovara-code\/lessons$/u, replacement: lessonsSource("index.ts") },
      { find: /^@rovara-code\/lessons\/(audit-sink|types)$/u, replacement: lessonsSource("$1.ts") },
    ],
  },
  test: {
    ...sharedVitestSettings,
    exclude: [...configDefaults.exclude, ...nativeP0Files],
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
