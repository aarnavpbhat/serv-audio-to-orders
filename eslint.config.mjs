// Lint for the pipeline and config packages (gone-standards: lint is the first CI gate).
// apps/web has its own config with the Next.js rules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "apps/web/**", ".cache/**", ".data/**", "fixtures/**", "examples/**", "docs/**", "eval/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
