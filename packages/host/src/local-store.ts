import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AuditEvent, OverlayPersistedState, SessionRecord } from "@openharbor/schemas";
import {
  auditEventSchema,
  sessionRecordSchema,
  sessionSnapshotSchema,
} from "@openharbor/schemas";
import { ensureDir, sessionDir } from "./paths.js";

export interface LocalHarborStoreOptions {
  dataDir: string;
}

export interface ArtifactRecord {
  id: string;
  mimeType: string;
  createdAt: string;
  sizeBytes: number;
}

export interface TestRunRecord {
  runId: string;
  adapter: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
}

export interface AuditIntegrityReport {
  ok: boolean;
  eventCount: number;
  lastHash: string | null;
  brokenAtLine?: number;
  reason?: string;
}

/**
 * File-backed session, overlay, and append-only audit stream.
 */
export class LocalHarborStore {
  readonly dataDir: string;

  constructor(opts: LocalHarborStoreOptions) {
    this.dataDir = opts.dataDir;
  }

  private sessionPath(id: string): string {
    return sessionDir(this.dataDir, id);
  }

  private artifactDir(sessionId: string): string {
    return path.join(this.sessionPath(sessionId), "artifacts");
  }

  private artifactIndexPath(sessionId: string): string {
    return path.join(this.artifactDir(sessionId), "index.json");
  }

  private testRunsPath(sessionId: string): string {
    return path.join(this.sessionPath(sessionId), "test-runs.json");
  }

  private auditPath(sessionId: string): string {
    return path.join(this.sessionPath(sessionId), "audit.jsonl");
  }

  async saveSession(record: SessionRecord): Promise<void> {
    const dir = this.sessionPath(record.id);
    await ensureDir(dir);
    const snapshot = { ...record, version: 1 as const };
    await fs.writeFile(
      path.join(dir, "session.json"),
      JSON.stringify(snapshot, null, 2),
      "utf8",
    );
  }

  async loadSession(sessionId: string): Promise<SessionRecord | null> {
    const file = path.join(this.sessionPath(sessionId), "session.json");
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      const snap = sessionSnapshotSchema.parse(raw);
      const { version: _v, ...rest } = snap;
      return sessionRecordSchema.parse(rest);
    } catch {
      return null;
    }
  }

  async saveOverlay(sessionId: string, state: OverlayPersistedState): Promise<void> {
    const dir = this.sessionPath(sessionId);
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, "overlay.json"), JSON.stringify(state, null, 2), "utf8");
  }

  async loadOverlay(sessionId: string): Promise<OverlayPersistedState | null> {
    const file = path.join(this.sessionPath(sessionId), "overlay.json");
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      return raw as OverlayPersistedState;
    } catch {
      return null;
    }
  }

  async appendAudit(sessionId: string, event: AuditEvent): Promise<void> {
    const dir = this.sessionPath(sessionId);
    await ensureDir(dir);
    const parsed = auditEventSchema.parse(event);
    const prevHash = await this.readLastAuditHash(sessionId);
    const sanitizedPayload = canonicalizeAuditPayload(stripAuditIntegrity(parsed.payload));
    const hash = hashAuditRecord({
      id: parsed.id,
      ts: parsed.ts,
      sessionId: parsed.sessionId,
      type: parsed.type,
      payload: sanitizedPayload,
      prevHash,
    });

    const line = `${JSON.stringify({
      ...parsed,
      payload: {
        ...sanitizedPayload,
        __integrity: {
          algo: "sha256",
          prevHash,
          hash,
        },
      },
    })}\n`;
    await fs.appendFile(this.auditPath(sessionId), line, "utf8");
  }

  async readAudit(sessionId: string): Promise<AuditEvent[]> {
    const file = this.auditPath(sessionId);
    try {
      const text = await fs.readFile(file, "utf8");
      const lines = text.split("\n").filter(Boolean);
      return lines.map((l) => auditEventSchema.parse(JSON.parse(l)));
    } catch {
      return [];
    }
  }

  async verifyAuditIntegrity(sessionId: string): Promise<AuditIntegrityReport> {
    const lines = await this.readAuditLines(sessionId);
    let prevHash: string | null = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) {
        continue;
      }
      let parsed: AuditEvent;
      try {
        parsed = auditEventSchema.parse(JSON.parse(line));
      } catch {
        return {
          ok: false,
          eventCount: i,
          lastHash: prevHash,
          brokenAtLine: i + 1,
          reason: "Invalid audit event JSON or schema",
        };
      }

      const integrity = readAuditIntegrity(parsed.payload);
      if (!integrity) {
        return {
          ok: false,
          eventCount: i,
          lastHash: prevHash,
          brokenAtLine: i + 1,
          reason: "Missing integrity metadata",
        };
      }
      if (integrity.prevHash !== prevHash) {
        return {
          ok: false,
          eventCount: i,
          lastHash: prevHash,
          brokenAtLine: i + 1,
          reason: "Integrity chain link mismatch",
        };
      }

      const expectedHash = hashAuditRecord({
        id: parsed.id,
        ts: parsed.ts,
        sessionId: parsed.sessionId,
        type: parsed.type,
        payload: canonicalizeAuditPayload(stripAuditIntegrity(parsed.payload)),
        prevHash,
      });
      if (integrity.hash !== expectedHash) {
        return {
          ok: false,
          eventCount: i,
          lastHash: prevHash,
          brokenAtLine: i + 1,
          reason: "Integrity hash mismatch",
        };
      }
      prevHash = integrity.hash;
    }

    return {
      ok: true,
      eventCount: lines.length,
      lastHash: prevHash,
    };
  }

  async putArtifact(
    sessionId: string,
    artifact: { id: string; mimeType: string; content: string },
  ): Promise<ArtifactRecord> {
    const dir = this.artifactDir(sessionId);
    await ensureDir(dir);

    const createdAt = new Date().toISOString();
    const sizeBytes = Buffer.byteLength(artifact.content, "utf8");
    const dataPath = path.join(dir, `${artifact.id}.txt`);
    await fs.writeFile(dataPath, artifact.content, "utf8");

    const index = await this.listArtifacts(sessionId);
    const next: ArtifactRecord = {
      id: artifact.id,
      mimeType: artifact.mimeType,
      createdAt,
      sizeBytes,
    };
    const deduped = index.filter((item) => item.id !== artifact.id);
    deduped.push(next);
    deduped.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await fs.writeFile(this.artifactIndexPath(sessionId), JSON.stringify(deduped, null, 2), "utf8");
    return next;
  }

  async getArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<(ArtifactRecord & { content: string }) | null> {
    const meta = (await this.listArtifacts(sessionId)).find((item) => item.id === artifactId);
    if (!meta) {
      return null;
    }
    const file = path.join(this.artifactDir(sessionId), `${artifactId}.txt`);
    try {
      const content = await fs.readFile(file, "utf8");
      return { ...meta, content };
    } catch {
      return null;
    }
  }

  async listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const file = this.artifactIndexPath(sessionId);
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw
        .filter((item): item is ArtifactRecord => {
          return (
            !!item &&
            typeof item === "object" &&
            typeof item.id === "string" &&
            typeof item.mimeType === "string" &&
            typeof item.createdAt === "string" &&
            typeof item.sizeBytes === "number"
          );
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
      return [];
    }
  }

  async saveTestRun(sessionId: string, run: TestRunRecord): Promise<void> {
    const runs = await this.listTestRuns(sessionId);
    const deduped = runs.filter((item) => item.runId !== run.runId);
    deduped.push(run);
    deduped.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const dir = this.sessionPath(sessionId);
    await ensureDir(dir);
    await fs.writeFile(this.testRunsPath(sessionId), JSON.stringify(deduped, null, 2), "utf8");
  }

  async getTestRun(sessionId: string, runId: string): Promise<TestRunRecord | null> {
    const runs = await this.listTestRuns(sessionId);
    return runs.find((item) => item.runId === runId) ?? null;
  }

  async listTestRuns(sessionId: string): Promise<TestRunRecord[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.testRunsPath(sessionId), "utf8"));
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw
        .filter((item): item is TestRunRecord => {
          return (
            !!item &&
            typeof item === "object" &&
            typeof item.runId === "string" &&
            typeof item.adapter === "string" &&
            typeof item.command === "string" &&
            Array.isArray(item.args) &&
            typeof item.cwd === "string" &&
            typeof item.startedAt === "string" &&
            typeof item.finishedAt === "string" &&
            typeof item.ok === "boolean" &&
            typeof item.exitCode === "number" &&
            typeof item.timedOut === "boolean"
          );
        })
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    } catch {
      return [];
    }
  }

  private async readAuditLines(sessionId: string): Promise<string[]> {
    try {
      const text = await fs.readFile(this.auditPath(sessionId), "utf8");
      return text.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private async readLastAuditHash(sessionId: string): Promise<string | null> {
    const lines = await this.readAuditLines(sessionId);
    if (lines.length === 0) {
      return null;
    }
    const last = lines[lines.length - 1];
    if (!last) {
      return null;
    }
    try {
      const event = auditEventSchema.parse(JSON.parse(last));
      return readAuditIntegrity(event.payload)?.hash ?? null;
    } catch {
      return null;
    }
  }
}

function stripAuditIntegrity(payload: Record<string, unknown>): Record<string, unknown> {
  const { __integrity: _ignored, ...rest } = payload;
  return rest;
}

function canonicalizeAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function readAuditIntegrity(payload: Record<string, unknown>): {
  algo: string;
  prevHash: string | null;
  hash: string;
} | null {
  const raw = payload.__integrity;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const integrity = raw as Record<string, unknown>;
  if (integrity.algo !== "sha256") {
    return null;
  }
  if (integrity.prevHash !== null && typeof integrity.prevHash !== "string") {
    return null;
  }
  if (typeof integrity.hash !== "string") {
    return null;
  }
  return {
    algo: "sha256",
    prevHash: integrity.prevHash as string | null,
    hash: integrity.hash,
  };
}

function hashAuditRecord(input: {
  id: string;
  ts: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
}): string {
  const canonical = stableStringify(input);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
