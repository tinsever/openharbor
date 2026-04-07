import fs from "node:fs/promises";
import path from "node:path";
import type { OverlayFileChange, OverlayPersistedState } from "@openharbor/schemas";
import { overlayPersistedStateSchema } from "@openharbor/schemas";
import { diffTexts, type FileDiffResult } from "./diff.js";
import { normalizeRepoRelative } from "./paths.js";

export interface OverlayWorkspaceOptions {
  sessionId: string;
  baseRepoPath: string;
}

/**
 * Draft layer over a read-only repo: edits live in memory until published.
 */
export class OverlayWorkspace {
  readonly sessionId: string;
  readonly baseRepoPath: string;

  private readonly files = new Map<string, string>();
  private readonly deletions = new Set<string>();

  constructor(opts: OverlayWorkspaceOptions) {
    this.sessionId = opts.sessionId;
    this.baseRepoPath = path.resolve(opts.baseRepoPath);
  }

  private key(rel: string): string {
    return normalizeRepoRelative(rel);
  }

  async readFile(rel: string): Promise<string> {
    const k = this.key(rel);
    if (this.deletions.has(k)) {
      throw new Error(`ENOENT: deleted in overlay: ${k}`);
    }
    const draft = this.files.get(k);
    if (draft !== undefined) {
      return draft;
    }
    const abs = path.join(this.baseRepoPath, ...k.split("/"));
    return await fs.readFile(abs, "utf8");
  }

  async fileExists(rel: string): Promise<boolean> {
    const k = this.key(rel);
    if (this.deletions.has(k)) {
      return false;
    }
    if (this.files.has(k)) {
      return true;
    }
    const abs = path.join(this.baseRepoPath, ...k.split("/"));
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  writeFile(rel: string, content: string): void {
    const k = this.key(rel);
    this.deletions.delete(k);
    this.files.set(k, content);
  }

  async deleteFile(rel: string): Promise<void> {
    const k = this.key(rel);
    if (this.files.has(k)) {
      this.files.delete(k);
    }
    if (await this.baseFileExists(k)) {
      this.deletions.add(k);
    } else {
      this.deletions.delete(k);
    }
  }

  async deletePath(rel: string, recursive = true): Promise<number> {
    const prefix = this.key(rel);
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    let deleted = 0;

    for (const key of [...this.files.keys()]) {
      if (key === prefix || key.startsWith(normalizedPrefix)) {
        this.files.delete(key);
        deleted += 1;
      }
    }

    const baseFiles = await this.listBaseFilesUnder(prefix, recursive);
    for (const baseFile of baseFiles) {
      if (!this.deletions.has(baseFile)) {
        this.deletions.add(baseFile);
        deleted += 1;
      }
    }

    if (deleted === 0) {
      this.deletions.delete(prefix);
    }
    return deleted;
  }

  private async baseFileExists(relKey: string): Promise<boolean> {
    const abs = path.join(this.baseRepoPath, ...relKey.split("/"));
    try {
      const st = await fs.stat(abs);
      return st.isFile();
    } catch {
      return false;
    }
  }

  private async listBaseFilesUnder(relKey: string, recursive: boolean): Promise<string[]> {
    const abs = path.join(this.baseRepoPath, ...relKey.split("/"));
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch {
      return [];
    }

    if (stat.isFile()) {
      return [relKey];
    }
    if (!stat.isDirectory()) {
      return [];
    }
    if (!recursive) {
      throw new Error(`Path is a directory and recursive delete is disabled: ${relKey}`);
    }

    const out: string[] = [];
    const stack = [relKey];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      const currentAbs = path.join(this.baseRepoPath, ...current.split("/"));
      const entries = await fs.readdir(currentAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        const child = current === "." ? entry.name : `${current}/${entry.name}`;
        if (entry.isDirectory()) {
          stack.push(child);
          continue;
        }
        if (entry.isFile()) {
          out.push(child);
        }
      }
    }
    return out;
  }

  reset(paths?: string[]): void {
    if (!paths || paths.length === 0) {
      this.files.clear();
      this.deletions.clear();
      return;
    }
    for (const p of paths) {
      const k = this.key(p);
      this.files.delete(k);
      this.deletions.delete(k);
    }
  }

  async listChangesResolved(): Promise<OverlayFileChange[]> {
    const out: OverlayFileChange[] = [];
    for (const k of this.deletions) {
      out.push({ path: k, kind: "delete" });
    }
    for (const [k, content] of this.files) {
      if (this.deletions.has(k)) {
        continue;
      }
      const existed = await this.baseFileExists(k);
      out.push({
        path: k,
        kind: existed ? "modify" : "create",
        content,
      });
    }
    return out;
  }

  async diffAll(): Promise<FileDiffResult[]> {
    const changes = await this.listChangesResolved();
    const results: FileDiffResult[] = [];
    for (const ch of changes) {
      if (ch.kind === "delete") {
        const oldText = await this.readBaseOrEmpty(ch.path);
        results.push(diffTexts(oldText, "", ch.path));
      } else if (ch.content !== undefined) {
        const oldText = ch.kind === "create" ? "" : await this.readBaseOrEmpty(ch.path);
        results.push(diffTexts(oldText, ch.content, ch.path));
      }
    }
    return results;
  }

  private async readBaseOrEmpty(rel: string): Promise<string> {
    const k = this.key(rel);
    const abs = path.join(this.baseRepoPath, ...k.split("/"));
    try {
      return await fs.readFile(abs, "utf8");
    } catch {
      return "";
    }
  }

  async toPersisted(): Promise<OverlayPersistedState> {
    const changes = await this.listChangesResolved();
    return {
      version: 1,
      sessionId: this.sessionId,
      baseRepoPath: this.baseRepoPath,
      changes,
    };
  }

  static fromPersisted(state: OverlayPersistedState): OverlayWorkspace {
    const ws = new OverlayWorkspace({
      sessionId: state.sessionId,
      baseRepoPath: state.baseRepoPath,
    });
    for (const ch of state.changes) {
      const k = ws.key(ch.path);
      if (ch.kind === "delete") {
        ws.deletions.add(k);
        ws.files.delete(k);
      } else if (ch.content !== undefined) {
        ws.deletions.delete(k);
        ws.files.set(k, ch.content);
      }
    }
    return ws;
  }

  static parsePersisted(raw: unknown): OverlayWorkspace {
    const state = overlayPersistedStateSchema.parse(raw);
    return OverlayWorkspace.fromPersisted(state);
  }
}
