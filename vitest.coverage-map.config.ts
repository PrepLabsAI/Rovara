// #1211: the ordinary test config plus the per-test coverage recorder. Used only by `scripts/test-coverage-map.ts collect`.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(base, defineConfig({ test: { setupFiles: ["tests/support/coverage-map-setup.ts"] } }));
