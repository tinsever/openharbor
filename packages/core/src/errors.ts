import type { PolicyEvaluationRecord } from "@openharbor/schemas";

export class PolicyDeniedError extends Error {
  readonly name = "PolicyDeniedError";
  constructor(
    message: string,
    readonly record: PolicyEvaluationRecord,
  ) {
    super(message);
  }
}

export class ApprovalRequiredError extends Error {
  readonly name = "ApprovalRequiredError";
  constructor(
    message: string,
    readonly record: PolicyEvaluationRecord,
  ) {
    super(message);
  }
}

export class CapabilityNotFoundError extends Error {
  readonly name = "CapabilityNotFoundError";
  constructor(readonly capabilityName: string) {
    super(`Unknown capability: ${capabilityName}`);
  }
}

export class ValidationError extends Error {
  readonly name = "ValidationError";
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
  }
}
