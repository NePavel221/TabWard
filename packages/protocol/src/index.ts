export const PROTOCOL_VERSION = 1;
export const DEFAULT_WS_PORT = 18766;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export type ExtensionState =
  | "not_running"
  | "pairing_required"
  | "connected"
  | "version_mismatch";

export interface CommandEnvelope {
  kind: "command";
  id: string;
  protocolVersion: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface ResultEnvelope {
  kind: "result";
  id: string;
  protocolVersion: number;
  ok: boolean;
  payload: unknown;
}

export interface HelloEnvelope {
  kind: "hello";
  protocolVersion: number;
  extensionId: string;
  extensionVersion: string;
  token?: string;
}

export interface PairingEnvelope {
  kind: "pairing_required" | "pairing_approved";
  protocolVersion: number;
  code?: string;
  token?: string;
}

export type WireEnvelope =
  | CommandEnvelope
  | ResultEnvelope
  | HelloEnvelope
  | PairingEnvelope;

export function isLocalExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === "string"
    && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}
