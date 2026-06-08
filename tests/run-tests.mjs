import esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = resolve(".test-cache");
const outfile = resolve(outdir, "core.mjs");

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

process.env.OWEN_EXPORTER_CORE_MODULE = pathToFileURL(outfile).href;
await import("./core.test.mjs");
