/**
 * Removes any leftover workspace-v* directories from past optimize runs.
 * Useful between iterative manual experiments.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, listSiblingDirs } from "../lib/io.js";

const variantDirs = [...listSiblingDirs("workspace-v"), ...listSiblingDirs("workspace-candidate")];
if (variantDirs.length === 0) {
  console.log("No variant workspaces to clean.");
  process.exit(0);
}
for (const dir of variantDirs) {
  rmSync(join(REPO_ROOT, dir), { recursive: true });
  console.log(`Removed ${dir}`);
}
