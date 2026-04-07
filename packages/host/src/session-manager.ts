import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionRecord } from "@openharbor/schemas";
import { OverlayWorkspace } from "@openharbor/overlay";
import { makeAuditEvent } from "./audit.js";
import type { LocalHarborStore } from "./local-store.js";

export interface SessionBundle {
  session: SessionRecord;
  overlay: OverlayWorkspace;
}

/**
 * In-memory session cache with disk persistence via {@link LocalHarborStore}.
 */
export class SessionManager {
  private readonly cache = new Map<string, SessionBundle>();
  private readonly sessionApprovalGrants = new Map<string, Set<string>>();
  private readonly taskApprovalGrants = new Map<string, Map<string, Set<string>>>();

  constructor(readonly store: LocalHarborStore) {}

  async createSession(repoPath: string, name?: string): Promise<SessionRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const resolved = path.resolve(repoPath);
    const session: SessionRecord = {
      id,
      repoPath: resolved,
      name,
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    const overlay = new OverlayWorkspace({
      sessionId: id,
      baseRepoPath: resolved,
    });
    this.cache.set(id, { session, overlay });
    await this.store.saveSession(session);
    await this.store.saveOverlay(id, await overlay.toPersisted());
    await this.store.appendAudit(
      id,
      makeAuditEvent(id, "session.created", { repoPath: resolved, name: name ?? null }),
    );
    return session;
  }

  async getBundle(sessionId: string): Promise<SessionBundle> {
    const hit = this.cache.get(sessionId);
    if (hit) {
      return hit;
    }
    const session = await this.store.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const persisted = await this.store.loadOverlay(sessionId);
    const overlay = persisted
      ? OverlayWorkspace.parsePersisted(persisted)
      : new OverlayWorkspace({
          sessionId,
          baseRepoPath: session.repoPath,
        });
    const bundle = { session, overlay };
    this.cache.set(sessionId, bundle);
    return bundle;
  }

  async persistOverlay(sessionId: string): Promise<void> {
    const bundle = await this.getBundle(sessionId);
    const state = await bundle.overlay.toPersisted();
    await this.store.saveOverlay(sessionId, state);
    const now = new Date().toISOString();
    const updated: SessionRecord = { ...bundle.session, updatedAt: now };
    this.cache.set(sessionId, { session: updated, overlay: bundle.overlay });
    await this.store.saveSession(updated);
  }

  async touchSession(sessionId: string): Promise<void> {
    const bundle = await this.getBundle(sessionId);
    const now = new Date().toISOString();
    const updated: SessionRecord = { ...bundle.session, updatedAt: now };
    this.cache.set(sessionId, { session: updated, overlay: bundle.overlay });
    await this.store.saveSession(updated);
  }

  addSessionApprovalGrant(sessionId: string, key: string): void {
    const set = this.sessionApprovalGrants.get(sessionId) ?? new Set<string>();
    set.add(key);
    this.sessionApprovalGrants.set(sessionId, set);
  }

  addTaskApprovalGrant(sessionId: string, taskId: string, key: string): void {
    const byTask = this.taskApprovalGrants.get(sessionId) ?? new Map<string, Set<string>>();
    const set = byTask.get(taskId) ?? new Set<string>();
    set.add(key);
    byTask.set(taskId, set);
    this.taskApprovalGrants.set(sessionId, byTask);
  }

  getSessionApprovalGrants(sessionId: string): Set<string> {
    return new Set(this.sessionApprovalGrants.get(sessionId) ?? []);
  }

  getTaskApprovalGrants(sessionId: string, taskId?: string): Set<string> {
    if (!taskId) {
      return new Set();
    }
    const byTask = this.taskApprovalGrants.get(sessionId);
    if (!byTask) {
      return new Set();
    }
    return new Set(byTask.get(taskId) ?? []);
  }
}
