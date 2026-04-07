import { diffLines } from "diff";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileDiffResult {
  path: string;
  hunks: DiffHunk[];
}

/**
 * Line-oriented diff between two texts. Emits a single hunk for v0 review UIs.
 */
export function diffTexts(oldText: string, newText: string, path: string): FileDiffResult {
  const parts = diffLines(oldText, newText);
  const lines: string[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (const part of parts) {
    const raw = part.value.split(/\n/);
    if (raw.length && raw[raw.length - 1] === "") {
      raw.pop();
    }
    for (const line of raw) {
      if (part.added) {
        lines.push(`+${line}`);
        newCount += 1;
      } else if (part.removed) {
        lines.push(`-${line}`);
        oldCount += 1;
      } else {
        lines.push(` ${line}`);
      }
    }
  }

  if (lines.length === 0) {
    return { path, hunks: [] };
  }

  return {
    path,
    hunks: [
      {
        oldStart: 1,
        oldLines: oldCount,
        newStart: 1,
        newLines: newCount,
        lines,
      },
    ],
  };
}
