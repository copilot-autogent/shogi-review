import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist", "node_modules"] },
  eslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser, parserOptions: { project: "./tsconfig.json" },
      globals: { window: "readonly", document: "readonly", location: "readonly", crypto: "readonly", indexedDB: "readonly" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: { "no-unused-vars": "off", "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
];
