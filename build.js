// Concat src/* into a single Tampermonkey-installable userscript at
// dist/mutuals-mapper.user.js.
//
// Strategy: strip ESM `import`/`export` statements and concatenate all source
// files in dependency order, wrapped in an IIFE. Tampermonkey doesn't load
// ES modules — everything must be inlined.
//
// This is intentionally simple (~80 LOC). No bundler, no minifier.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "src");
const OUT = join(__dirname, "dist", "mutuals-mapper.user.js");

// Order matters: foundations first, leaves last.
const ORDER = [
  "userscript_header.js",
  "op_hashes.js",
  "pacing.js",
  "eta.js",
  "db.js",
  "client.js",
  "resolver.js",
  "crawler.js",
  "archive_parser.js",
  "viz.js",
  "ui_template.js",
  "ui_state.js",
  "ui.js",
  "_entry.js",
];

function stripModuleSyntax(src) {
  // Remove `import ... from "...";`  (we inline everything).
  let out = src.replace(/^\s*import[^;]+;[\r\n]+/gm, "");
  // Remove leading `export ` keywords on declarations.
  out = out.replace(/^export\s+(class|function|async function|const|let|var)\s/gm, "$1 ");
  // Drop `export { ... };` re-export blocks if any.
  out = out.replace(/^\s*export\s*\{[^}]*\};?[\r\n]+/gm, "");
  return out;
}

function build() {
  const parts = [];
  for (const name of ORDER) {
    const path = join(SRC, name);
    let src = readFileSync(path, "utf8");
    if (name !== "userscript_header.js") {
      src = stripModuleSyntax(src);
    }
    parts.push(`// ----- ${name} -----\n${src.trim()}\n`);
  }

  // Wrap everything except the header in an IIFE so identifiers don't leak.
  const headerEnd = parts[0]; // userscript header (must stay at top, outside IIFE)
  const body = parts.slice(1).join("\n");
  const out = `${headerEnd}\n(function () {\n  "use strict";\n${body}\n})();\n`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}  (${(out.length / 1024).toFixed(1)} KB)`);
}

build();
