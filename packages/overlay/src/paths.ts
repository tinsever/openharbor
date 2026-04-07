import path from "node:path";

/** Normalize repo-relative paths to POSIX-style for stable keys. */
export function normalizeRepoRelative(p: string): string {
  const trimmed = p.replace(/^[/\\]+/, "");
  return trimmed.split(path.sep).join("/");
}
