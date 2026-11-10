// Shared ESLint flat config for every TypeScript package (constitution: Code quality).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.cli-dist/**", "**/node_modules/**", "**/coverage/**", "**/.turbo/**", "**/.next/**", "**/next-env.d.ts", "apps/engine/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
  {
    // Nest modules are empty classes decorated with @Module.
    files: ["apps/api/src/**/*.module.ts"],
    rules: { "@typescript-eslint/no-extraneous-class": "off" },
  },
);
