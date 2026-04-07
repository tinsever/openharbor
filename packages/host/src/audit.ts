import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditEventType } from "@openharbor/schemas";

export function makeAuditEvent(
  sessionId: string,
  type: AuditEventType,
  payload: Record<string, unknown>,
): AuditEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId,
    type,
    payload,
  };
}
