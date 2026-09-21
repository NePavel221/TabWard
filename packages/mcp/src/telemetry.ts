import { randomUUID } from "node:crypto";

// Closed vocabulary: never copy arbitrary command names or payload fields.
const OPERATIONS = new Set(`
  ping openTab navigate navigateAdvanced goBack goForward tabs getText getHtml
  getPageState extractTables observe snapshot query queryRich extractImages
  resolveTarget click fill smartClick smartFill locatorAction form locatorWait
  locatorAssert workflow downloadClick downloadImage downloads deleteDownload
  closeTab activateTab cursor working finish cleanup reloadExtension reload
  waitForText waitForSelector attach detach executeCdp cdp eventsStart eventsPoll
  eventsClear eventsStop dialogHandle networkBody networkHar interceptionStart
  interceptionContinue interceptionFail interceptionFulfill interceptionStop
  emulation storage traceStart traceStop screencastStart screencastFrame
  screencastStop screenshot evaluate probe qa inputMouse inputKey inputScroll
  nameSession turnEnded handoff deliverable adoptTab releaseTab releaseWorkspace
  getUserSettings getInfo
`.trim().split(/\s+/));

const NUMERIC_FIELDS = [
  "brokerActiveRequests", "brokerQueueDepth", "bridgeQueueWaitMs",
  "bridgeRoundTripMs", "extensionExecutionMs", "outboxCommitMs",
  "transferResidualMs", "brokerTotalMs", "clientTotalMs", "resultBytes",
  "brokerRssBytes"
] as const;

export type OperationTelemetry = {
  operationId: string;
  operationType: string;
} & Partial<Record<typeof NUMERIC_FIELDS[number], number>>;

export function telemetryEnabled(): boolean {
  return process.env.TABWARD_TELEMETRY === "1";
}

export function validOperationId(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

export function newTelemetry(command: string, operationId?: string): OperationTelemetry {
  const id: string = validOperationId(operationId) ? operationId : randomUUID();
  return {
    operationId: id,
    operationType: OPERATIONS.has(command) ? command : "unknown"
  };
}

// Apply this at every metadata boundary, including synthetic/untrusted extensions.
export function sanitizeTelemetry(value: unknown): OperationTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (!validOperationId(source.operationId)) return undefined;
  const clean = newTelemetry(
    typeof source.operationType === "string" ? source.operationType : "",
    source.operationId
  );
  for (const key of NUMERIC_FIELDS) {
    const metric = source[key];
    if (typeof metric === "number" && Number.isFinite(metric) && metric >= 0) {
      clean[key] = metric;
    }
  }
  return clean;
}
