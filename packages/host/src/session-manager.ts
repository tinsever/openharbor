import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ApprovalGrantRecord,
  ApprovalGrantStatus,
  EffectClass,
  GrantScope,
  SessionRecord,
} from "@openharbor/schemas";
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
  private readonly approvalGrants = new Map<string, ApprovalGrantRecord[]>();

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
    this.approvalGrants.set(id, []);
    await this.store.saveSession(session);
    await this.store.saveOverlay(id, await overlay.toPersisted());
    await this.store.saveApprovalGrants(id, []);
    await this.store.appendAudit(
      id,
      makeAuditEvent(id, "session.created", { repoPath: resolved, name: name ?? null }),
    );
    return session;
  }

  async getBundle(sessionId: string): Promise<SessionBundle> {
    const hit = this.cache.get(sessionId);
    if (hit) {
      await this.ensureApprovalGrantsLoaded(sessionId);
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
    await this.ensureApprovalGrantsLoaded(sessionId);
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

  issueApprovalGrant(input: {
    sessionId: string;
    scope: GrantScope;
    effectClass: EffectClass;
    targetId: string;
    taskId?: string;
  }): ApprovalGrantRecord {
    const now = new Date().toISOString();
    const grant: ApprovalGrantRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      scope: input.scope,
      effectClass: input.effectClass,
      targetId: input.targetId,
      taskId: input.taskId,
      status: "active",
      issuedAt: now,
    };
    const grants = this.approvalGrants.get(input.sessionId) ?? [];
    grants.push(grant);
    this.approvalGrants.set(input.sessionId, grants);
    return grant;
  }

  consumeOnceGrantByKey(sessionId: string, key: string): ApprovalGrantRecord | null {
    const grants = this.approvalGrants.get(sessionId) ?? [];
    const now = new Date().toISOString();
    for (const grant of grants) {
      if (grant.scope !== "once" || grant.status !== "active") {
        continue;
      }
      if (grantKey(grant.effectClass, grant.targetId) !== key) {
        continue;
      }
      grant.status = "consumed";
      grant.consumedAt = now;
      this.approvalGrants.set(sessionId, grants);
      return grant;
    }
    return null;
  }

  revokeApprovalGrant(sessionId: string, grantId: string, reason?: string): ApprovalGrantRecord | null {
    const grants = this.approvalGrants.get(sessionId) ?? [];
    const now = new Date().toISOString();
    for (const grant of grants) {
      if (grant.id !== grantId || grant.status !== "active") {
        continue;
      }
      grant.status = "revoked";
      grant.revokedAt = now;
      if (reason) {
        grant.reason = reason;
      }
      this.approvalGrants.set(sessionId, grants);
      return grant;
    }
    return null;
  }

  revokeApprovalGrantsByTask(sessionId: string, taskId: string, reason?: string): ApprovalGrantRecord[] {
    return this.revokeApprovalGrantsWhere(
      sessionId,
      (grant) => grant.taskId === taskId,
      reason,
    );
  }

  revokeAllApprovalGrants(sessionId: string, reason?: string): ApprovalGrantRecord[] {
    return this.revokeApprovalGrantsWhere(sessionId, () => true, reason);
  }

  listApprovalGrants(
    sessionId: string,
    options?: { includeInactive?: boolean },
  ): ApprovalGrantRecord[] {
    const includeInactive = options?.includeInactive ?? true;
    const grants = this.approvalGrants.get(sessionId) ?? [];
    return grants
      .filter((grant) => includeInactive || grant.status === "active")
      .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
      .map((grant) => ({ ...grant }));
  }

  getPolicyGrantKeySets(
    sessionId: string,
    taskId?: string,
  ): {
    approvalGrantsOnce: Set<string>;
    approvalGrantsTask: Set<string>;
    approvalGrantsSession: Set<string>;
  } {
    const grants = this.approvalGrants.get(sessionId) ?? [];
    const active = grants.filter((grant) => grant.status === "active");
    const approvalGrantsOnce = new Set<string>();
    const approvalGrantsTask = new Set<string>();
    const approvalGrantsSession = new Set<string>();

    for (const grant of active) {
      const key = grantKey(grant.effectClass, grant.targetId);
      if (grant.scope === "once") {
        approvalGrantsOnce.add(key);
        continue;
      }
      if (grant.scope === "task") {
        if (taskId && grant.taskId === taskId) {
          approvalGrantsTask.add(key);
        }
        continue;
      }
      approvalGrantsSession.add(key);
    }

    return {
      approvalGrantsOnce,
      approvalGrantsTask,
      approvalGrantsSession,
    };
  }

  async persistApprovalGrants(sessionId: string): Promise<void> {
    await this.store.saveApprovalGrants(sessionId, this.approvalGrants.get(sessionId) ?? []);
  }

  private revokeApprovalGrantsWhere(
    sessionId: string,
    predicate: (grant: ApprovalGrantRecord) => boolean,
    reason?: string,
  ): ApprovalGrantRecord[] {
    const grants = this.approvalGrants.get(sessionId) ?? [];
    const now = new Date().toISOString();
    const revoked: ApprovalGrantRecord[] = [];
    for (const grant of grants) {
      if (grant.status !== "active" || !predicate(grant)) {
        continue;
      }
      grant.status = "revoked";
      grant.revokedAt = now;
      if (reason) {
        grant.reason = reason;
      }
      revoked.push({ ...grant });
    }
    if (revoked.length > 0) {
      this.approvalGrants.set(sessionId, grants);
    }
    return revoked;
  }

  private async ensureApprovalGrantsLoaded(sessionId: string): Promise<void> {
    if (this.approvalGrants.has(sessionId)) {
      return;
    }
    const grants = await this.store.loadApprovalGrants(sessionId);
    this.approvalGrants.set(
      sessionId,
      grants.map((grant) => ({ ...grant, status: normalizeGrantStatus(grant.status) })),
    );
  }
}

function grantKey(effectClass: EffectClass, targetId: string): string {
  return `${effectClass}:${targetId}`;
}

function normalizeGrantStatus(status: ApprovalGrantStatus): ApprovalGrantStatus {
  return status;
}
