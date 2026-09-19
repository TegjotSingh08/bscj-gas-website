import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored third-party code, kept byte-identical on purpose: two
    // minified library bundles and a single-file application copied from
    // outside the repo. Linting it would report on somebody else's style
    // and, worse, invite reformatting a file whose value is that it still
    // matches its original.
    "vendor/**",
  ]),
]);

export default eslintConfig;
