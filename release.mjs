import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { stdio: "inherit", shell: false, ...options });
}

function runNpm(args) {
  if (process.platform === "win32") {
    run("cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args]);
    return;
  }

  run("npm", args);
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8", shell: false }).trim();
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const releaseNotes = process.argv.slice(2).join(" ") || `Release ${version}`;

if (!version) {
  throw new Error("package.json version is required");
}

const status = output("git", ["status", "--short"]);
if (status) {
  throw new Error("Working tree is not clean. Commit or stash changes before releasing.");
}

const existingTag = output("git", ["tag", "--list", version]);
if (existingTag) {
  throw new Error(`Tag already exists: ${version}`);
}

runNpm(["run", "build"]);

for (const asset of ["main.js", "manifest.json", "styles.css"]) {
  if (!existsSync(asset)) {
    throw new Error(`Missing release asset: ${asset}`);
  }
}

run("git", ["tag", version]);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", version]);
run("gh", ["release", "create", version, "main.js", "manifest.json", "styles.css", "--title", version, "--notes", releaseNotes]);

console.log(`Released ${version}`);
