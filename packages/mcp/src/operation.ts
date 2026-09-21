import { createHash } from "node:crypto";

export type OperationOutcome =
  | "completed"
  | "not_started"
  | "cancelled_before_effect"
  | "effect_unknown"
  | "cleanup_partial";

export interface OperationDescriptor {
  operationId: string;
  fingerprint: string;
  deadlineAt: number;
}

export interface OperationFailureDetails {
  outcome: OperationOutcome;
  effectPossible: boolean;
  retrySafe: boolean;
  reason: string;
}

export class OperationFailure extends Error {
  constructor(
    name: string,
    message: string,
    readonly details: OperationFailureDetails
  ) {
    super(message);
    this.name = name;
  }
}

export function commandFingerprint(
  command: string,
  payload: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(JSON.stringify({ command, payload }))
    .digest("hex");
}

export function remainingMs(deadlineAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor(deadlineAt - now));
}

export function notStarted(reason: string): OperationFailure {
  return new OperationFailure(
    "NotStarted",
    `TabWard operation was not started: ${reason}`,
    {
      outcome: "not_started",
      effectPossible: false,
      retrySafe: true,
      reason
    }
  );
}

export function cancelledBeforeEffect(reason: string): OperationFailure {
  return new OperationFailure(
    "CancelledBeforeEffect",
    `TabWard operation was cancelled before browser effects: ${reason}`,
    {
      outcome: "cancelled_before_effect",
      effectPossible: false,
      retrySafe: true,
      reason
    }
  );
}

export function outcomeUnknown(reason: string): OperationFailure {
  return new OperationFailure(
    "OutcomeUnknown",
    `TabWard could not prove the operation outcome: ${reason}`,
    {
      outcome: "effect_unknown",
      effectPossible: true,
      retrySafe: false,
      reason
    }
  );
}

export function webSocketSendFailure(message: string): OperationFailure {
  return outcomeUnknown(
    `WebSocket send reported failure after delivery could not be excluded: ${message}`
  );
}
