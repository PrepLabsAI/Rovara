import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "cdk.out/**",
      "coverage/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.lint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "off"
    },
  },
  {
    files: [
      "environments/team-tasks/**/*.mjs",
      "environments/fixture-worker/**/*.mjs",
      "scripts/check-candidate-ownership.mjs",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: "readonly", console: "readonly", setTimeout: "readonly", fetch: "readonly", Buffer: "readonly" } },
  },
);
