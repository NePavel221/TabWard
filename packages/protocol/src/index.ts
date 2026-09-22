export const PROTOCOL_VERSION = 3;
export const DEFAULT_WS_PORT = 18766;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_PREAUTH_MESSAGE_BYTES = 64 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export type ExtensionState =
  | "not_running"
  | "pairing_required"
  | "connected"
  | "version_mismatch";

export interface HelloEnvelope {
  kind: "hello";
  protocolVersion: number;
  extensionId: string;
  extensionVersion: string;
  clientNonce: string;
  hasPairingToken: boolean;
}

export interface PairingRequiredEnvelope {
  kind: "pairing_required";
  protocolVersion: number;
  connectionId: string;
  clientNonce: string;
  serverNonce: string;
}

export interface PairingApproveEnvelope {
  kind: "pairing_approve";
  protocolVersion: number;
  code: string;
  connectionId: string;
  clientNonce: string;
  serverNonce: string;
  extensionNonce: string;
}

export interface PairingApprovedEnvelope {
  kind: "pairing_approved";
  protocolVersion: number;
  connectionId: string;
  clientNonce: string;
  serverNonce: string;
  extensionNonce: string;
  brokerProof: string;
}

export interface PairingConfirmEnvelope {
  kind: "pairing_confirm";
  protocolVersion: number;
  connectionId: string;
  extensionProof: string;
}

export interface PairingCompleteEnvelope {
  kind: "pairing_complete";
  protocolVersion: number;
  connectionId: string;
  token: string;
}

export interface AuthChallengeEnvelope {
  kind: "auth_challenge";
  protocolVersion: number;
  connectionId: string;
  clientNonce: string;
  serverNonce: string;
}

export interface AuthResponseEnvelope {
  kind: "auth_response";
  protocolVersion: number;
  connectionId: string;
  clientNonce: string;
  serverNonce: string;
  extensionNonce: string;
  extensionProof: string;
}

export interface BrokerProofEnvelope {
  kind: "broker_proof";
  protocolVersion: number;
  connectionId: string;
  proof: string;
}

export interface AuthConfirmEnvelope {
  kind: "auth_confirm";
  protocolVersion: number;
  connectionId: string;
  proof: string;
}

export interface ReadyEnvelope {
  kind: "ready";
  protocolVersion: number;
}

export interface CommandEnvelope {
  kind: "command";
  id: string;
  protocolVersion: number;
  type: string;
  payload: Record<string, unknown>;
  operationId: string;
  fingerprint: string;
  deadlineAt: number;
  telemetry?: boolean;
}

export interface ResultEnvelope {
  kind: "result";
  id: string;
  protocolVersion: number;
  ok: boolean;
  payload: unknown;
  operationId: string;
  fingerprint: string;
  telemetry?: unknown;
}

export interface ResultAckEnvelope {
  kind: "result_ack";
  id: string;
  protocolVersion: number;
  fingerprint: string;
}

export interface ResultBackpressureEnvelope {
  kind: "result_backpressure";
  id: string;
  protocolVersion: number;
  fingerprint: string;
  retryAfterMs: number;
}

export interface CancelEnvelope {
  kind: "cancel";
  protocolVersion: number;
  operationId: string;
}

export interface CancelAckEnvelope {
  kind: "cancel_ack";
  protocolVersion: number;
  operationId: string;
  state: "not_found" | "queued" | "active" | "completed";
}

export interface PingEnvelope {
  kind: "ping" | "pong";
  protocolVersion: number;
}

export interface VersionMismatchEnvelope {
  kind: "version_mismatch";
  protocolVersion: number;
}

export type WireEnvelope =
  | HelloEnvelope
  | PairingRequiredEnvelope
  | PairingApproveEnvelope
  | PairingApprovedEnvelope
  | PairingConfirmEnvelope
  | PairingCompleteEnvelope
  | AuthChallengeEnvelope
  | AuthResponseEnvelope
  | BrokerProofEnvelope
  | AuthConfirmEnvelope
  | ReadyEnvelope
  | CommandEnvelope
  | ResultEnvelope
  | ResultAckEnvelope
  | ResultBackpressureEnvelope
  | CancelEnvelope
  | CancelAckEnvelope
  | PingEnvelope
  | VersionMismatchEnvelope;

export function isLocalExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === "string"
    && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}
