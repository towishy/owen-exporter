import esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = resolve(".test-cache");
const outfile = resolve(outdir, "core.mjs");
const i18nOutfile = resolve(outdir, "i18n.mjs");

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ["core.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
});

await esbuild.build({
  entryPoints: ["i18n.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: i18nOutfile,
});

process.env.OWEN_EXPORTER_CORE_MODULE = pathToFileURL(outfile).href;
process.env.OWEN_EXPORTER_I18N_MODULE = pathToFileURL(i18nOutfile).href;
await import("./core.test.mjs");
await import("./i18n.test.mjs");
