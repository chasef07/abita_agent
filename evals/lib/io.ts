/**
 * Shared I/O utilities for the eval pipeline scripts.
 * Single source of truth for "find the latest output file", "read a JSON file
 * with type safety", etc. — keeps each script small and consistent.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const OUTPUT_DIR = resolve(REPO_ROOT, "evals", "output");
export const WORKSPACE_DIR = resolve(REPO_ROOT, "workspace");

/** Resolve a path relative to the repo root. */
export function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

/** Ensure a directory exists and return its path. */
export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Find the most recently created file in OUTPUT_DIR matching `prefix` and `.json`. */
export function findLatestOutput(prefix: string): string | undefined {
  if (!existsSync(OUTPUT_DIR)) return undefined;
  const matches = readdirSync(OUTPUT_DIR)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
    .sort();
  return matches.length === 0 ? undefined : join(OUTPUT_DIR, matches[matches.length - 1]);
}

/** Find today's `<prefix>YYYY-MM-DD.json` if present. */
export function findTodayOutput(prefix: string): string | undefined {
  const today = todayISO();
  const candidate = join(OUTPUT_DIR, `${prefix}${today}.json`);
  return existsSync(candidate) ? candidate : undefined;
}

export function readJSON<T>(path: string | undefined): T | undefined {
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function writeJSON(path: string, value: unknown): void {
  ensureDir(resolve(path, ".."));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function writeText(path: string, value: string): void {
  ensureDir(resolve(path, ".."));
  writeFileSync(path, value, "utf-8");
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** List immediate subdirectories of REPO_ROOT matching prefix (e.g., "workspace-v"). */
export function listSiblingDirs(prefix: string): string[] {
  return readdirSync(REPO_ROOT)
    .filter((entry) => entry.startsWith(prefix))
    .filter((entry) => statSync(join(REPO_ROOT, entry)).isDirectory())
    .sort();
}
