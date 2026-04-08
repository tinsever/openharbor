import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ApprovalGrantRecord,
  AuditEvent,
  OverlayPersistedState,
  SessionRecord,
} from "@openharbor/schemas";
import {
  approvalGrantRecordSchema,
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
  failureCode?: "parse_error" | "missing_integrity" | "chain_mismatch" | "hash_mismatch";
  brokenAtLine?: number;
  reason?: string;
}

type NormalizedAuditEvent = AuditEvent & { schemaVersion: number };

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

  private approvalsPath(sessionId: string): string {
    return path.join(this.sessionPath(sessionId), "approvals.json");
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

  async listSessions(): Promise<SessionRecord[]> {
    try {
      const entries = await fs.readdir(path.join(this.dataDir, "sessions"), { withFileTypes: true });
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.loadSession(entry.name)),
      );
      return sessions
        .filter((session): session is SessionRecord => session !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
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
    const parsed = normalizeAuditEventRaw(event);
    const prevHash = await this.readLastAuditHash(sessionId);
    const sanitizedPayload = canonicalizeAuditPayload(stripAuditIntegrity(parsed.payload));
    const hash = hashAuditRecord({
      schemaVersion: parsed.schemaVersion,
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
      return lines.map((l) => normalizeAuditEventLine(l).event);
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
      let parsed: NormalizedAuditEvent;
      let hashMode: "legacy" | "v1";
      try {
        const normalized = normalizeAuditEventLine(line);
        parsed = normalized.event;
        hashMode = normalized.hashMode;
      } catch {
        return {
          ok: false,
          eventCount: i,
          lastHash: prevHash,
          failureCode: "parse_error",
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
          failureCode: "missing_integrity",
          brokenAtLine: i + 1,
          reason: "Missing integrity metadata",
        };
      }
      if (integrity.prevHash !== prevHash) {
        return {
          ok: false,
          eventCount: i,
          lastHash: prevHash,
          failureCode: "chain_mismatch",
          brokenAtLine: i + 1,
          reason: "Integrity chain link mismatch",
        };
      }

      const expectedHash = hashAuditRecord({
        schemaVersion: parsed.schemaVersion,
        hashMode,
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
          failureCode: "hash_mismatch",
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

  async loadApprovalGrants(sessionId: string): Promise<ApprovalGrantRecord[]> {
    const file = this.approvalsPath(sessionId);
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw
        .map((item) => approvalGrantRecordSchema.parse(item))
        .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
    } catch {
      return [];
    }
  }

  async saveApprovalGrants(
    sessionId: string,
    grants: ApprovalGrantRecord[],
  ): Promise<void> {
    const dir = this.sessionPath(sessionId);
    await ensureDir(dir);
    const parsed = grants.map((grant) => approvalGrantRecordSchema.parse(grant));
    await fs.writeFile(this.approvalsPath(sessionId), JSON.stringify(parsed, null, 2), "utf8");
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
      const event = normalizeAuditEventLine(last).event;
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
  schemaVersion: number;
  hashMode?: "legacy" | "v1";
  id: string;
  ts: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
}): string {
  const canonical = stableStringify(
    input.hashMode === "legacy"
      ? {
          id: input.id,
          ts: input.ts,
          sessionId: input.sessionId,
          type: input.type,
          payload: input.payload,
          prevHash: input.prevHash,
        }
      : {
          schemaVersion: input.schemaVersion,
          id: input.id,
          ts: input.ts,
          sessionId: input.sessionId,
          type: input.type,
          payload: input.payload,
          prevHash: input.prevHash,
        },
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeAuditEventLine(line: string): {
  event: NormalizedAuditEvent;
  hashMode: "legacy" | "v1";
} {
  const raw = JSON.parse(line);
  const hashMode =
    !!raw
    && typeof raw === "object"
    && typeof (raw as Record<string, unknown>).schemaVersion === "number"
      ? "v1"
      : "legacy";
  return {
    event: normalizeAuditEventRaw(raw),
    hashMode,
  };
}

function normalizeAuditEventRaw(raw: unknown): NormalizedAuditEvent {
  try {
    const parsed = auditEventSchema.parse(raw) as AuditEvent & { schemaVersion?: unknown };
    const schemaVersion =
      typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion)
        ? parsed.schemaVersion
        : 1;
    return {
      ...parsed,
      schemaVersion,
    };
  } catch {
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid audit event");
    }
    const legacy = raw as Record<string, unknown>;
    if (
      typeof legacy.id !== "string"
      || typeof legacy.ts !== "string"
      || typeof legacy.sessionId !== "string"
      || typeof legacy.type !== "string"
      || !legacy.payload
      || typeof legacy.payload !== "object"
      || Array.isArray(legacy.payload)
    ) {
      throw new Error("Invalid audit event");
    }
    return {
      id: legacy.id,
      ts: legacy.ts,
      sessionId: legacy.sessionId,
      type: legacy.type as AuditEvent["type"],
      payload: legacy.payload as Record<string, unknown>,
      schemaVersion: 1,
    };
  }
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
