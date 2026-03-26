import { execSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(__dirname, "node_modules"))) {
  process.stderr.write("[setup] node_modules not found, running npm install...\n");
  execSync("npm install", { cwd: __dirname, stdio: ["pipe", "pipe", "inherit"] });
  process.stderr.write("[setup] npm install complete\n");
}

await import("./index.js");
