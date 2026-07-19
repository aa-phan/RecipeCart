// @ts-check
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    // src/** is type-aware (tied to tsconfig.json).
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: globals.node,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // spikes/** are throwaway scripts, excluded from tsconfig.json — lint
    // them syntactically (no type-aware project binding required).
    files: ["spikes/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      globals: globals.node,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  prettier,
  {
    // web/ is a separate Vite/React project with its own tsconfig and build
    // output (web/dist) — not part of this root config's TS project binding.
    // It has no ESLint setup of its own yet; excluding it here rather than
    // wrongly linting its built bundle as untyped legacy JS.
    ignores: ["dist/**", "node_modules/**", "data/**", "spikes/tmp/**", "web/**"],
  },
];
