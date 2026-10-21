// Bundles the server into one file, dist/index.js, with every dependency inside it. The bundle is
// committed: installing from GitHub (npx github:blackcheet/xbitto-mcp) then needs no build step and
// nothing from the npm registry. `--verify` builds to memory and fails when dist/ is out of date.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const verify = process.argv.includes("--verify");

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Some bundled packages are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { VERSION: JSON.stringify(pkg.version) },
  legalComments: "eof",
  write: false,
  logLevel: "warning",
});

const [output] = result.outputFiles;
const target = new URL("../dist/index.js", import.meta.url);
if (verify) {
  const committed = await readFile(target, "utf8").catch(() => "");
  if (committed !== output.text) {
    console.error("dist/index.js is out of date: run npm run build and commit it.");
    process.exit(1);
  }
} else {
  await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
  await writeFile(target, output.text);
  console.log(`dist/index.js ${(output.text.length / 1024).toFixed(0)} KB`);
}
