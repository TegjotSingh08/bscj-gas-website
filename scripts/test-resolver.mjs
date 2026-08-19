import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Lets `node --test` resolve the same import style the Next build uses:
 * the `@/` alias, and imports written without a file extension.
 *
 * Node runs the TypeScript directly (type stripping), so this is the only
 * glue needed — no test framework and no transpiler in the dependency list.
 */

const srcRoot = path.resolve(process.cwd(), "src");
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

function firstExisting(basePath) {
  if (existsSync(basePath) && path.extname(basePath)) return basePath;
  for (const extension of EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let target = null;

    if (specifier.startsWith("@/")) {
      target = path.join(srcRoot, specifier.slice(2));
    } else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      target = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier,
      );
    }

    if (target) {
      const resolved = firstExisting(target);
      if (resolved) {
        return { url: pathToFileURL(resolved).href, shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});
