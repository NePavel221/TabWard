importScripts("security.js", "stage-one.js", "stage-two.js", "stage-three.js");

const PROTOCOL_VERSION = 3;
const WS_URL = "ws://127.0.0.1:18766";
const PAIRING_TOKEN_KEY = "pairingToken";
const USER_SETTINGS_KEY = "userSettings";
const PENDING_APPROVALS_KEY = "pendingApprovals";
const DEFAULT_USER_SETTINGS = Object.freeze({
  allowExistingTabs: false,
  existingTabAccess: false,
  openInSeparateWindow: false,
  trustedUploadSites: []
});
const DEFAULT_GROUP_TITLE = "TabWard";
const DEFAULT_GROUP_COLOR = "grey";
const DEFAULT_GROUP_COLLAPSED = false;
const GROUP_OPERATION_TIMEOUT_MS = 5000;
const MAX_TEXT_CHARS = 120000;
const WORK_TABS_KEY = "workTabs";
const WORKING_GROUP_TITLE = "TabWard: working";
const WORKING_GROUP_COLOR = "blue";
const HANDOFF_GROUP_TITLE = "TabWard: handoff";
const HANDOFF_GROUP_COLOR = "yellow";
const DELIVERABLE_GROUP_TITLE = "TabWard: done";
const DELIVERABLE_GROUP_COLOR = "green";
const IDLE_CURSOR_HIDE_MS = 2500;
const OWNERSHIP_KEY = "tabOwnership";
const WORKSPACE_GROUPS_KEY = "workspaceGroups";
const WORKSPACE_WINDOWS_KEY = "workspaceWindows";
const SESSION_POLICIES_KEY = "sessionPolicies";
const CLEAN_QA_STATES_KEY = "cleanQaStates";
const EMULATION_STATES_KEY = "emulationStates";
const DOWNLOAD_IDS_KEY = "downloadIds";
const CDP_OWNERSHIP_KEY = "cdpOwnership";
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const OUTBOX_DB = "tabward-protocol";
const OUTBOX_STORE = "resultOutbox";
const OUTBOX_LIMIT = 128;
const OUTBOX_MAX_BYTES = 32 * 1024 * 1024;
const OUTBOX_RESERVATION_TTL_MS = 10 * 60_000;
const EVENT_MAX_BYTES = 8 * 1024 * 1024;
const TRACE_MAX_BYTES = 16 * 1024 * 1024;
const SCREENCAST_MAX_BYTES = 16 * 1024 * 1024;
const NETWORK_BODY_RESULT_MAX_BYTES = 7 * 1024 * 1024;
const APPROVAL_TTL_MS = 5 * 60_000;
const APPROVAL_HISTORY_LIMIT = 20;
const TRANSPORT_KEEPALIVE_MS = 20_000;
const OPERATION_CONTEXT = Symbol("TabWardOperationContext");
const WORKER_INSTANCE_ID = crypto.randomUUID();
const MANAGED_SESSION_CAPABILITIES = new Set([
  "read", "action", "artifacts", "downloads", "emulation",
  "evaluate_local", "events", "probes", "tracing", "uploads"
]);
const FULL_PROFILE_SESSION_CAPABILITIES = new Set([
  ...MANAGED_SESSION_CAPABILITIES,
  "adopt_tabs", "cdp", "evaluate", "network_interception", "storage"
]);
const COMMAND_CAPABILITY_POLICY = Object.freeze({
  ping: null,
  getUserSettings: null,
  reloadExtension: null,
  nameSession: [],
  cleanup: [],
  releaseWorkspace: [],
  turnEnded: [],
  openTab: ["action"],
  tabs: ["read"],
  navigate: ["action"],
  navigateAdvanced: ["action"],
  goBack: ["action"],
  goForward: ["action"],
  getText: ["read"],
  getHtml: ["read"],
  getPageState: ["read"],
  extractTables: ["read"],
  observe: ["read"],
  snapshot: ["read"],
  query: ["read"],
  queryRich: ["read"],
  extractImages: ["read"],
  resolveTarget: ["read"],
  click: ["action"],
  fill: ["action"],
  smartClick: ["action"],
  smartFill: ["action"],
  locatorAction: ["action"],
  form: ["action"],
  locatorWait: ["read"],
  locatorAssert: ["read"],
  workflow: ["action"],
  downloadClick: ["downloads"],
  downloadImage: ["downloads"],
  downloads: ["downloads"],
  deleteDownload: ["downloads"],
  closeTab: ["action"],
  activateTab: ["action"],
  cursor: ["action"],
  finish: ["action"],
  reload: ["action"],
  waitForText: ["read"],
  waitForSelector: ["read"],
  attach: ["cdp"],
  detach: ["cdp"],
  cdp: ["cdp"],
  eventsStart: ["events"],
  eventsPoll: ["events"],
  eventsClear: ["events"],
  eventsStop: ["events"],
  dialogHandle: ["events"],
  networkBody: ["events"],
  networkHar: ["events"],
  interceptionStart: ["network_interception"],
  interceptionContinue: ["network_interception"],
  interceptionFail: ["network_interception"],
  interceptionFulfill: ["network_interception"],
  interceptionStop: ["network_interception"],
  emulation: ["emulation"],
  storage: ["storage"],
  traceStart: ["tracing"],
  traceStop: ["tracing"],
  screencastStart: ["tracing"],
  screencastFrame: ["tracing"],
  screencastStop: ["tracing"],
  screenshot: ["artifacts"],
  evaluate: [],
  probe: ["probes"],
  qa: ["probes"],
  inputMouse: ["action"],
  inputKey: ["action"],
  inputScroll: ["action"],
  handoff: ["action"],
  deliverable: ["action"],
  adoptTab: ["adopt_tabs"],
  releaseTab: ["action"]
});
const WORKFLOW_STEP_CAPABILITY_POLICY = Object.freeze({
  observe: ["read"],
  smartClick: ["action"],
  smartFill: ["action"],
  navigate: ["action"],
  pageState: ["read"],
  queryRich: ["read"],
  extractImages: ["read"],
  waitForText: ["read"],
  waitForSelector: ["read"],
  reload: ["action"],
  inputKey: ["action"],
  inputScroll: ["action"]
});
const FORM_FIELD_CAPABILITY_POLICY = Object.freeze({
  click: ["action"],
  doubleClick: ["action"],
  hover: ["action"],
  fill: ["action"],
  type: ["action"],
  press: ["action"],
  check: ["action"],
  uncheck: ["action"],
  select: ["action"],
  focus: ["action"],
  blur: ["action"],
  drag: ["action"],
  upload: ["uploads"]
});

let reloadScheduled = false;
let transportSocket = null;
let transportState = "not_running";
let transportReconnectTimer = null;
let transportReconnectAttempt = 0;
let transportKeepaliveTimer = null;
let pairingCode = null;
let transportLastError = null;
let connectedAt = null;
let transportHandshake = null;
let outboxFlushPromise = null;
let outboxMutationTail = Promise.resolve();
let pendingApprovalMutationTail = Promise.resolve();
const activeOperations = new Map();
const extensionResourceGate = TabWardStageThree.createResourceGate();

function openOutbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        database.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open TabWard outbox"));
  });
}

async function outboxTransaction(mode, run) {
  const database = await openOutbox();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, mode);
      const store = transaction.objectStore(OUTBOX_STORE);
      let value;
      try {
        value = run(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || new Error("TabWard outbox transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("TabWard outbox transaction aborted"));
    });
  } finally {
    database.close();
  }
}

async function outboxPut(envelope) {
  const database = await openOutbox();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(OUTBOX_STORE);
      const existingRequest = store.get(envelope.id);
      existingRequest.onerror = () => reject(existingRequest.error);
      existingRequest.onsuccess = () => {
        const existing = existingRequest.result;
        const listRequest = store.getAll();
        listRequest.onerror = () => reject(listRequest.error);
        listRequest.onsuccess = () => {
          const bytes = TabWardStageTwo.byteLength(envelope);
          const used = (listRequest.result || []).reduce(
            (total, entry) => total + Number(
              entry.bytes
              || entry.reservedBytes
              || (entry.envelope ? TabWardStageTwo.byteLength(entry.envelope) : 0)
            ),
            0
          ) - Number(existing?.bytes || existing?.reservedBytes || 0);
          if (bytes > Number(existing?.reservedBytes || bytes)
            || used + bytes > OUTBOX_MAX_BYTES) {
            transaction.abort();
            reject(new Error("TabWard result outbox byte capacity exceeded"));
            return;
          }
          store.put({
            id: envelope.id,
            operationId: envelope.operationId,
            fingerprint: envelope.fingerprint,
            status: "completed",
            envelope,
            bytes,
            reservedBytes: Number(existing?.reservedBytes || bytes),
            createdAt: existing?.createdAt || Date.now(),
            completedAt: Date.now()
          });
        };
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("TabWard outbox write failed"));
      transaction.onabort = () => {
        if (transaction.error) reject(transaction.error);
      };
    });
  } finally {
    database.close();
  }
}

function outboxReservationBytes(type) {
  return TabWardStageTwo.outboxReservationBytes(type);
}

async function reconcileOutboxReservations(now = Date.now()) {
  const activeIds = new Set(activeOperations.keys());
  await outboxTransaction("readwrite", (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const expiredIds = new Set(TabWardStageTwo.expiredReservationIds(
        request.result,
        activeIds,
        now,
        OUTBOX_RESERVATION_TTL_MS
      ));
      for (const entry of request.result || []) {
        if (expiredIds.has(entry.id)) {
          const envelope = {
            kind: "result",
            id: entry.operationId,
            protocolVersion: PROTOCOL_VERSION,
            ok: false,
            operationId: entry.operationId,
            fingerprint: entry.fingerprint,
            payload: {
              name: "OutcomeUnknown",
              message: "The extension restarted before durable completion was recorded",
              details: {
                outcome: "effect_unknown",
                effectPossible: true,
                retrySafe: false,
                reason: "expired orphaned outbox reservation"
              }
            }
          };
          const bytes = TabWardStageTwo.byteLength(envelope);
          store.put({
            ...entry,
            status: "completed",
            envelope,
            bytes,
            reservedBytes: bytes,
            completedAt: now,
            reconciled: true
          });
        }
      }
    };
  });
}

async function outboxReserve(message) {
  const run = async () => {
    await reconcileOutboxReservations();
    const database = await openOutbox();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, "readwrite");
        const store = transaction.objectStore(OUTBOX_STORE);
        const request = store.getAll();
        let result;
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const entries = request.result || [];
          const existing = entries.find((entry) => entry.id === message.operationId);
          if (existing) {
            if (existing.fingerprint !== message.fingerprint) {
              result = { state: "conflict" };
              return;
            }
            result = existing.status === "completed" || existing.envelope
              ? { state: "completed", envelope: existing.envelope }
              : { state: activeOperations.has(message.operationId) ? "active" : "unknown" };
            return;
          }
          const reservedBytes = outboxReservationBytes(message.type);
          const usedBytes = entries.reduce(
            (total, entry) => total + Number(
              entry.bytes
              || entry.reservedBytes
              || (entry.envelope ? TabWardStageTwo.byteLength(entry.envelope) : 0)
            ),
            0
          );
          if (entries.length >= OUTBOX_LIMIT || usedBytes + reservedBytes > OUTBOX_MAX_BYTES) {
            result = { state: "full", usedBytes, reservedBytes };
            return;
          }
          store.add({
            id: message.operationId,
            operationId: message.operationId,
            fingerprint: message.fingerprint,
            status: "reserved",
            reservedBytes,
            createdAt: Date.now()
          });
          result = { state: "reserved", reservedBytes };
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error("TabWard outbox reservation failed"));
        transaction.onabort = () => reject(transaction.error || new Error("TabWard outbox reservation aborted"));
      });
    } finally {
      database.close();
    }
  };
  const current = outboxMutationTail.then(run, run);
  outboxMutationTail = current.then(() => undefined, () => undefined);
  return current;
}

async function outboxDelete(id, fingerprint = null) {
  await outboxTransaction("readwrite", (store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result;
      if (!record) return;
      if (fingerprint && record.fingerprint && record.fingerprint !== fingerprint) {
        return;
      }
      store.delete(id);
    };
  });
}

async function outboxList() {
  const database = await openOutbox();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OUTBOX_STORE, "readonly");
      const request = transaction.objectStore(OUTBOX_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("Could not read TabWard outbox"));
    });
  } finally {
    database.close();
  }
}

async function flushOutbox(socket = transportSocket) {
  if (outboxFlushPromise) return outboxFlushPromise;
  outboxFlushPromise = (async () => {
    if (!socket || socket.readyState !== WebSocket.OPEN || transportState !== "connected") return;
    await reconcileOutboxReservations();
    const entries = (await outboxList())
      .filter((entry) => entry.envelope)
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const entry of entries) {
      if (socket.readyState !== WebSocket.OPEN || transportState !== "connected") return;
      socket.send(JSON.stringify(entry.envelope));
    }
  })();
  try {
    await outboxFlushPromise;
  } finally {
    outboxFlushPromise = null;
  }
}

function scheduleTransportReconnect() {
  if (transportReconnectTimer || reloadScheduled) {
    return;
  }
  const delay = Math.min(30000, 500 * (2 ** Math.min(transportReconnectAttempt, 6)));
  transportReconnectAttempt += 1;
  transportReconnectTimer = setTimeout(() => {
    transportReconnectTimer = null;
    connectTransport();
  }, delay);
}

function stopTransportKeepalive() {
  if (transportKeepaliveTimer) {
    clearInterval(transportKeepaliveTimer);
    transportKeepaliveTimer = null;
  }
}

function sendTransportPing(socket = transportSocket) {
  if (
    transportState !== "connected"
    || socket !== transportSocket
    || socket?.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  socket.send(JSON.stringify({
    kind: "ping",
    protocolVersion: PROTOCOL_VERSION
  }));
  return true;
}

function startTransportKeepalive(socket) {
  stopTransportKeepalive();
  transportKeepaliveTimer = setInterval(() => {
    if (!sendTransportPing(socket)) {
      stopTransportKeepalive();
    }
  }, TRANSPORT_KEEPALIVE_MS);
}

async function pairingToken() {
  const state = await chrome.storage.local.get({ [PAIRING_TOKEN_KEY]: null });
  return typeof state[PAIRING_TOKEN_KEY] === "string" ? state[PAIRING_TOKEN_KEY] : null;
}

function normalizeUserSettings(value) {
  const trustedUploadSites = Array.from(new Set(
    (Array.isArray(value?.trustedUploadSites) ? value.trustedUploadSites : [])
      .map((pattern) => {
        try {
          return TabWardSecurity.normalizeTrustedPattern(pattern);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  )).slice(0, 100);
  return {
    allowExistingTabs:
      value?.existingTabAccess === true || value?.allowExistingTabs === true,
    existingTabAccess:
      value?.existingTabAccess === true || value?.allowExistingTabs === true,
    openInSeparateWindow: value?.openInSeparateWindow === true,
    trustedUploadSites
  };
}

async function getUserSettings() {
  const state = await chrome.storage.local.get({
    [USER_SETTINGS_KEY]: DEFAULT_USER_SETTINGS
  });
  return normalizeUserSettings(state[USER_SETTINGS_KEY]);
}

async function releaseAdoptedTabs() {
  const ownership = await getOwnership();
  const adoptedTabIds = Object.values(ownership)
    .filter((record) => record?.kind === "adopted")
    .map((record) => record.tabId)
    .filter(Number.isInteger);
  for (const tabId of adoptedTabIds) {
    await releaseOwnership(tabId);
  }
  return adoptedTabIds;
}

async function updateUserSettings(patch) {
  const current = await getUserSettings();
  const normalizedPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "existingTabAccess")) {
    normalizedPatch.existingTabAccess = patch.existingTabAccess === true;
    normalizedPatch.allowExistingTabs = patch.existingTabAccess === true;
  } else if (Object.prototype.hasOwnProperty.call(patch, "allowExistingTabs")) {
    normalizedPatch.allowExistingTabs = patch.allowExistingTabs === true;
    normalizedPatch.existingTabAccess = patch.allowExistingTabs === true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "trustedUploadSites")) {
    const requested = Array.isArray(patch.trustedUploadSites)
      ? patch.trustedUploadSites
      : [];
    for (const pattern of requested) {
      TabWardSecurity.normalizeTrustedPattern(pattern);
    }
  }
  const next = normalizeUserSettings({ ...current, ...normalizedPatch });
  await chrome.storage.local.set({ [USER_SETTINGS_KEY]: next });
  const releasedAdoptedTabIds =
    current.allowExistingTabs && !next.allowExistingTabs
      ? await releaseAdoptedTabs()
      : [];
  return { settings: next, releasedAdoptedTabIds };
}

async function readPendingApprovals() {
  const state = await chrome.storage.session.get({ [PENDING_APPROVALS_KEY]: {} });
  return state[PENDING_APPROVALS_KEY] || {};
}

async function mutatePendingApprovals(mutator) {
  const run = async () => {
    const records = await readPendingApprovals();
    const next = mutator(structuredClone(records)) || records;
    await chrome.storage.session.set({ [PENDING_APPROVALS_KEY]: next });
    await syncApprovalBadge(next);
    return next;
  };
  const current = pendingApprovalMutationTail.then(run, run);
  pendingApprovalMutationTail = current.then(() => undefined, () => undefined);
  return current;
}

async function syncApprovalBadge(records = null) {
  const source = records || await readPendingApprovals();
  const count = Object.values(source)
    .map(publicApproval)
    .filter((approval) => approval?.actionable === true)
    .length;
  await chrome.action.setBadgeBackgroundColor({ color: "#D97706" });
  await chrome.action.setBadgeText({
    text: count > 0 ? String(Math.min(count, 99)) : ""
  });
}

function publicApproval(record) {
  if (!record) return null;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  const expired = Number(record.expiresAt || 0) <= Date.now();
  const currentWorker = record.workerInstanceId === WORKER_INSTANCE_ID;
  const actionable = record.status === "pending" && !expired && currentWorker;
  return {
    approvalId: record.approvalId,
    kind: record.kind,
    method: record.method || null,
    riskCategory: record.riskCategory,
    riskText: record.riskText,
    sessionLabel: sessionId
      ? `TabWard session …${sessionId.slice(-8)}`
      : "TabWard session",
    origin: record.origin,
    host: record.host || null,
    basenames: record.basenames || [],
    expiresAt: record.expiresAt,
    status: record.status === "pending" && expired
      ? "expired"
      : record.status === "pending" && !currentWorker
        ? "cancelled"
        : record.status,
    actionable
  };
}

async function listPendingApprovals() {
  const records = await readPendingApprovals();
  return Object.values(records)
    .sort((left, right) => {
      const leftPublic = publicApproval(left);
      const rightPublic = publicApproval(right);
      if (leftPublic.actionable !== rightPublic.actionable) {
        return leftPublic.actionable ? -1 : 1;
      }
      return Number(right.createdAt || 0) - Number(left.createdAt || 0);
    })
    .map(publicApproval);
}

async function createPendingApproval(binding, display) {
  const record = {
    ...binding,
    ...display,
    status: "pending",
    decision: null,
    createdAt: Date.now(),
    expiresAt: Math.min(
      Date.now() + APPROVAL_TTL_MS,
      Number(binding.deadlineAt || Date.now() + APPROVAL_TTL_MS)
    )
  };
  if (record.expiresAt <= Date.now()) {
    const error = new Error("Approval deadline expired before user review");
    error.name = "NotStarted";
    throw error;
  }
  await mutatePendingApprovals((records) => {
    records[record.approvalId] = record;
    const retained = Object.values(records)
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .slice(0, APPROVAL_HISTORY_LIMIT);
    for (const approvalId of Object.keys(records)) delete records[approvalId];
    for (const retainedRecord of retained) {
      records[retainedRecord.approvalId] = retainedRecord;
    }
    return records;
  });
  return record;
}

async function decidePendingApproval(approvalId, decision) {
  const allowed = new Set(["approve_once", "trust_host", "deny"]);
  if (!allowed.has(decision)) throw new Error("Invalid approval decision");
  let decided = null;
  await mutatePendingApprovals((records) => {
    const record = records[approvalId];
    if (
      !record
      || record.status !== "pending"
      || record.expiresAt <= Date.now()
      || record.workerInstanceId !== WORKER_INSTANCE_ID
    ) {
      throw new Error("Approval request is missing or expired");
    }
    if (decision === "trust_host" && record.kind !== "upload") {
      throw new Error("Only upload hosts can be trusted persistently");
    }
    records[approvalId] = {
      ...record,
      status: decision === "deny" ? "denied" : "approved",
      decision,
      decidedAt: Date.now()
    };
    decided = records[approvalId];
    return records;
  });
  if (decision === "trust_host") {
    const settings = await getUserSettings();
    await updateUserSettings({
      trustedUploadSites: [...settings.trustedUploadSites, decided.host]
    });
  }
  return publicApproval(decided);
}

async function consumeApproval(binding, context) {
  try {
    while (Date.now() < Math.min(binding.deadlineAt, binding.expiresAt)) {
      throwIfCommandAborted(context);
      const records = await readPendingApprovals();
      const record = records[binding.approvalId];
      if (record?.status === "denied") {
        const error = new Error("The user denied this browser operation");
        error.name = "ApprovalDenied";
        throw error;
      }
      if (TabWardSecurity.approvalMatches(record, binding)) {
        return record;
      }
      await sleep(150, commandSignal(context));
    }
    const error = new Error("User approval expired before browser dispatch");
    error.name = "ApprovalTimeout";
    throw error;
  } finally {
    await mutatePendingApprovals((records) => {
      const record = records[binding.approvalId];
      if (record?.status === "pending") {
        records[binding.approvalId] = {
          ...record,
          status: Number(record.expiresAt || 0) <= Date.now()
            ? "expired"
            : "cancelled",
          decidedAt: Date.now()
        };
      }
      return records;
    });
  }
}

async function tabDocumentIdentity(tabId) {
  const [tab, execution] = await Promise.all([
    chrome.tabs.get(tabId),
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ href: location.href, origin: location.origin })
    })
  ]);
  const result = execution?.[0];
  return {
    tabId,
    documentId: result?.documentId || null,
    url: String(result?.result?.href || tab.url || ""),
    origin: String(result?.result?.origin || "")
  };
}

async function connectTransport() {
  if (transportSocket || reloadScheduled) {
    return;
  }
  transportState = "not_running";
  const socket = new WebSocket(WS_URL);
  transportSocket = socket;
  socket.addEventListener("open", async () => {
    transportReconnectAttempt = 0;
    transportLastError = null;
    transportHandshake = {
      phase: "hello_sent",
      clientNonce: TabWardSecurity.randomNonce(),
      connectionId: null,
      serverNonce: null,
      extensionNonce: null,
      token: await pairingToken()
    };
    socket.send(JSON.stringify({
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION,
      extensionId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
      clientNonce: transportHandshake.clientNonce,
      hasPairingToken: Boolean(transportHandshake.token)
    }));
  });
  socket.addEventListener("message", (event) => {
    handleTransportMessage(socket, event.data).catch((error) => {
      transportLastError = toSafeError(error);
      socket.close(1008, "protocol error");
    });
  });
  socket.addEventListener("close", () => {
    if (transportSocket === socket) {
      stopTransportKeepalive();
      transportSocket = null;
      connectedAt = null;
      transportHandshake = null;
      if (transportState === "connected") {
        transportState = "not_running";
      }
      scheduleTransportReconnect();
    }
  });
  socket.addEventListener("error", () => {
    transportLastError = {
      name: "WebSocketError",
      message: "TabWard MCP is not reachable on 127.0.0.1"
    };
  });
}

async function handleTransportMessage(socket, raw) {
  if (socket !== transportSocket) {
    return;
  }
  const message = JSON.parse(String(raw));
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    transportState = "version_mismatch";
    throw new Error("TabWard protocol version mismatch");
  }
  if (message.kind === "pairing_required") {
    if (
      typeof message.connectionId !== "string"
      || typeof message.serverNonce !== "string"
      || message.clientNonce !== transportHandshake?.clientNonce
    ) {
      throw new Error("Invalid TabWard pairing challenge");
    }
    transportHandshake.connectionId = message.connectionId;
    transportHandshake.serverNonce = message.serverNonce;
    transportHandshake.phase = "pairing_required";
    transportState = "pairing_required";
    return;
  }
  if (message.kind === "pairing_approved") {
    if (
      !transportHandshake
      || transportHandshake.phase !== "pairing_request_sent"
      || message.connectionId !== transportHandshake.connectionId
      || message.clientNonce !== transportHandshake.clientNonce
      || message.serverNonce !== transportHandshake.serverNonce
      || typeof message.brokerProof !== "string"
    ) {
      throw new Error("Invalid TabWard pairing proof");
    }
    transportHandshake.extensionNonce = message.extensionNonce;
    const transcript = TabWardSecurity.handshakeTranscript({
      ...transportHandshake,
      extensionId: chrome.runtime.id,
      protocolVersion: PROTOCOL_VERSION
    });
    const pairingKey = await TabWardSecurity.derivePairingKey(
      transportHandshake.pairingCode,
      transcript
    );
    const expected = await TabWardSecurity.hmacSha256(
      pairingKey,
      `broker-pairing:${transcript}`
    );
    if (message.brokerProof !== expected) {
      throw new Error("TabWard pairing broker proof failed");
    }
    socket.send(JSON.stringify({
      kind: "pairing_confirm",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: transportHandshake.connectionId,
      extensionProof: await TabWardSecurity.hmacSha256(
        pairingKey,
        `extension-pairing:${transcript}`
      )
    }));
    transportHandshake.phase = "pairing_confirm_sent";
    return;
  }
  if (message.kind === "pairing_complete") {
    if (
      !transportHandshake
      || transportHandshake.phase !== "pairing_confirm_sent"
      || message.connectionId !== transportHandshake.connectionId
      || typeof message.token !== "string"
      || message.token.length < 43
    ) {
      throw new Error("Invalid TabWard pairing completion");
    }
    await chrome.storage.local.set({ [PAIRING_TOKEN_KEY]: message.token });
    pairingCode = null;
    transportHandshake.pairingCode = null;
    socket.close(1000, "pairing saved");
    return;
  }
  if (message.kind === "auth_challenge") {
    if (
      !transportHandshake?.token
      || transportHandshake.phase !== "hello_sent"
      || typeof message.connectionId !== "string"
      || typeof message.serverNonce !== "string"
      || message.clientNonce !== transportHandshake.clientNonce
    ) {
      throw new Error("Invalid TabWard authentication challenge");
    }
    transportHandshake.connectionId = message.connectionId;
    transportHandshake.serverNonce = message.serverNonce;
    transportHandshake.extensionNonce = TabWardSecurity.randomNonce();
    const transcript = TabWardSecurity.handshakeTranscript({
      ...transportHandshake,
      extensionId: chrome.runtime.id,
      protocolVersion: PROTOCOL_VERSION
    });
    socket.send(JSON.stringify({
      kind: "auth_response",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: transportHandshake.connectionId,
      clientNonce: transportHandshake.clientNonce,
      serverNonce: transportHandshake.serverNonce,
      extensionNonce: transportHandshake.extensionNonce,
      extensionProof: await TabWardSecurity.hmacSha256(
        transportHandshake.token,
        `extension:${transcript}`
      )
    }));
    transportHandshake.phase = "auth_response_sent";
    return;
  }
  if (message.kind === "broker_proof") {
    if (
      !transportHandshake?.token
      || transportHandshake.phase !== "auth_response_sent"
      || message.connectionId !== transportHandshake.connectionId
    ) {
      throw new Error("Unexpected TabWard broker proof");
    }
    const transcript = TabWardSecurity.handshakeTranscript({
      ...transportHandshake,
      extensionId: chrome.runtime.id,
      protocolVersion: PROTOCOL_VERSION
    });
    const expected = await TabWardSecurity.hmacSha256(
      transportHandshake.token,
      `broker:${transcript}`
    );
    if (message.proof !== expected) {
      throw new Error("TabWard broker authentication failed");
    }
    socket.send(JSON.stringify({
      kind: "auth_confirm",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: transportHandshake.connectionId,
      proof: await TabWardSecurity.hmacSha256(
        transportHandshake.token,
        `confirm:${transcript}`
      )
    }));
    transportHandshake.phase = "auth_confirm_sent";
    return;
  }
  if (message.kind === "ready") {
    if (transportHandshake?.phase !== "auth_confirm_sent") {
      throw new Error("TabWard ready arrived before mutual authentication");
    }
    transportHandshake.phase = "authenticated";
    pairingCode = null;
    transportState = "connected";
    connectedAt = new Date().toISOString();
    startTransportKeepalive(socket);
    await reconcileStaleMetadata();
    await flushOutbox(socket);
    return;
  }
  if (transportState !== "connected" || transportHandshake?.phase !== "authenticated") {
    throw new Error("Mutual authentication is required before protocol messages");
  }
  if (message.kind === "result_ack") {
    if (typeof message.id === "string") {
      await outboxDelete(message.id, message.fingerprint);
    }
    return;
  }
  if (message.kind === "result_backpressure") {
    setTimeout(() => flushOutbox(), Math.max(100, Number(message.retryAfterMs || 1_000)));
    return;
  }
  if (message.kind === "pong") {
    return;
  }
  if (message.kind === "cancel") {
    const operation = activeOperations.get(message.operationId);
    if (operation) {
      operation.controller.abort();
    }
    socket.send(JSON.stringify({
      kind: "cancel_ack",
      protocolVersion: PROTOCOL_VERSION,
      operationId: String(message.operationId || ""),
      state: operation ? "active" : "not_found"
    }));
    return;
  }
  if (message.kind !== "command") {
    throw new Error("Unknown TabWard protocol message");
  }
  const operation = TabWardStageTwo.operationContext(message);
  const reservation = await outboxReserve(message);
  if (reservation.state === "conflict") {
    socket.send(JSON.stringify({
      kind: "result",
      id: operation.operationId,
      protocolVersion: PROTOCOL_VERSION,
      ok: false,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      payload: {
        name: "OperationConflict",
        message: "operationId was reused with a different fingerprint",
        details: {
          outcome: "not_started",
          effectPossible: false,
          retrySafe: false
        }
      }
    }));
    return;
  }
  if (reservation.state === "completed") {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(reservation.envelope));
    }
    return;
  }
  if (reservation.state === "active") {
    return;
  }
  if (reservation.state === "full") {
    socket.send(JSON.stringify({
      kind: "result",
      id: operation.operationId,
      protocolVersion: PROTOCOL_VERSION,
      ok: false,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      payload: {
        name: "CapacityExceeded",
        message: "TabWard result outbox is full before browser dispatch",
        details: {
          outcome: "not_started",
          effectPossible: false,
          retrySafe: true,
          byteBudget: OUTBOX_MAX_BYTES
        }
      }
    }));
    return;
  }
  let ok = false;
  let payload;
  const measured = message.telemetry === true
    && typeof message.operationId === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.operationId);
  const executionStarted = measured ? performance.now() : 0;
  const controller = new AbortController();
  const context = Object.freeze({
    ...operation,
    signal: controller.signal
  });
  activeOperations.set(operation.operationId, { controller, context });
  try {
    if (reservation.state === "unknown") {
      const error = new Error("A prior extension worker may have executed this operation");
      error.name = "OutcomeUnknown";
      error.details = {
        outcome: "effect_unknown",
        effectPossible: true,
        retrySafe: false,
        reason: "stale reserved operation after extension restart"
      };
      throw error;
    }
    if (Date.now() >= context.deadlineAt) {
      const error = new Error("Operation deadline expired before extension dispatch");
      error.name = "NotStarted";
      error.details = {
        outcome: "not_started",
        effectPossible: false,
        retrySafe: true
      };
      throw error;
    }
    const scope = TabWardStageThree.classifyCommand(message);
    payload = await extensionResourceGate.run(scope, async () => {
      throwIfCommandAborted(context);
      if (Date.now() >= context.deadlineAt) {
        const error = new Error("Operation deadline expired before extension resource dispatch");
        error.name = "NotStarted";
        error.details = {
          outcome: "not_started",
          effectPossible: false,
          retrySafe: true
        };
        throw error;
      }
      return await dispatch(message, context);
    });
    ok = payload?.ok !== false;
  } catch (error) {
    if (TabWardStageTwo.abortIsEffectUnknown(controller.signal.aborted, error?.name)) {
      error = Object.assign(new Error("Active operation was cancelled; browser effects cannot be excluded"), {
        name: "OutcomeUnknown",
        details: {
          outcome: "effect_unknown",
          effectPossible: true,
          retrySafe: false,
          reason: "active cancellation"
        }
      });
    }
    payload = toSafeError(error);
  }
  try {
    let envelope = {
    kind: "result",
    id: operation.operationId,
    protocolVersion: PROTOCOL_VERSION,
    ok,
    payload,
    operationId: operation.operationId,
    fingerprint: operation.fingerprint,
    ...(measured ? {
      telemetry: { extensionExecutionMs: performance.now() - executionStarted }
    } : {})
  };
    const serialized = JSON.stringify(envelope);
    if (new TextEncoder().encode(serialized).length > MAX_RESULT_BYTES) {
      envelope = {
      kind: "result",
      id: operation.operationId,
      protocolVersion: PROTOCOL_VERSION,
      ok: false,
      payload: {
        name: "ResultTooLarge",
        message: "Command result exceeded 64 MiB",
        details: {
          outcome: "effect_unknown",
          effectPossible: true,
          retrySafe: false,
          truncated: true
        }
      },
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      ...(measured ? { telemetry: envelope.telemetry } : {})
    };
    }
    const commitStarted = measured ? performance.now() : 0;
    try {
      await outboxPut(envelope);
    } catch (error) {
      envelope = {
      kind: "result",
      id: operation.operationId,
      protocolVersion: PROTOCOL_VERSION,
      ok: false,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      payload: {
        name: "OutcomeUnknown",
        message: "Command completed but its full result could not be committed durably",
        details: {
          outcome: "effect_unknown",
          effectPossible: true,
          retrySafe: false,
          reason: "durable result byte reservation exceeded",
          truncated: true
        }
      },
      ...(measured ? { telemetry: envelope.telemetry } : {})
      };
      await outboxPut(envelope);
    }
    // A replay contains execution timing only: the commit duration is known after
    // the durable write. Do not introduce a second write just to persist metrics.
    if (measured) envelope.telemetry.outboxCommitMs = performance.now() - commitStarted;
    const resultSocket = TabWardStageTwo.resultTransportSocket(
      transportSocket,
      transportState,
      WebSocket.OPEN
    );
    if (resultSocket) {
      resultSocket.send(JSON.stringify(envelope));
    } else {
      await flushOutbox();
    }
  } finally {
    activeOperations.delete(operation.operationId);
  }
}

function approvePairing(code) {
  if (
    transportState !== "pairing_required" ||
    !transportSocket ||
    transportSocket.readyState !== WebSocket.OPEN ||
    !/^\d{6}$/.test(String(code))
  ) {
    throw new Error("Enter the six-digit pairing code shown by the TabWard MCP");
  }
  if (!transportHandshake?.connectionId || !transportHandshake.serverNonce) {
    throw new Error("Pairing challenge is not ready");
  }
  transportHandshake.extensionNonce = TabWardSecurity.randomNonce();
  transportHandshake.pairingCode = String(code);
  transportHandshake.phase = "pairing_request_sent";
  transportSocket.send(JSON.stringify({
    kind: "pairing_approve",
    protocolVersion: PROTOCOL_VERSION,
    code: String(code),
    connectionId: transportHandshake.connectionId,
    clientNonce: transportHandshake.clientNonce,
    serverNonce: transportHandshake.serverNonce,
    extensionNonce: transportHandshake.extensionNonce
  }));
}

async function revokePairing() {
  await chrome.storage.local.remove(PAIRING_TOKEN_KEY);
  pairingCode = null;
  transportSocket?.close(1000, "pairing revoked");
}

function transportStatus() {
  return {
    ok: transportState === "connected",
    ready: transportState === "connected",
    state: transportState,
    url: WS_URL,
    connectedAt,
    error: transportLastError,
    extension: {
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      connected: transportState === "connected"
    }
  };
}

function commandContext(value) {
  return value?.[OPERATION_CONTEXT] || value || null;
}

function commandSignal(value) {
  return commandContext(value)?.signal || null;
}

function scopedPayload(source, value) {
  const context = commandContext(source);
  if (context) {
    Object.defineProperty(value, OPERATION_CONTEXT, {
      value: context,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return value;
}

function throwIfCommandAborted(value) {
  if (commandSignal(value)?.aborted) {
    throw new DOMException("Command was cancelled", "AbortError");
  }
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Operation cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Operation cancelled", "AbortError"));
    }, { once: true });
  });
}

function withTimeout(promise, timeoutMs, label, onTimeout = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) {
        onTimeout();
      }
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function bestEffort(promise, timeoutMs = 2500, label = "best effort operation") {
  try {
    return await withTimeout(promise, timeoutMs, label);
  } catch (error) {
    return { ok: false, error: toSafeError(error) };
  }
}

function classifyMissingTab(result) {
  if (result?.ok !== false) return result;
  const message = String(result.error?.message || "");
  if (
    result.error?.name === "NotFoundError"
    || result.error?.name === "NoSuchTabError"
    || /^No tab with id:\s*\d+/i.test(message)
  ) {
    return {
      ...result,
      error: {
        ...result.error,
        name: "NoSuchTabError"
      }
    };
  }
  return result;
}

function slimTab(tab) {
  if (!tab) {
    return null;
  }
  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    active: tab.active,
    audible: tab.audible,
    discarded: tab.discarded,
    favIconUrl: sanitizeUrl(tab.favIconUrl),
    status: tab.status,
    title: tab.title,
    url: sanitizeUrl(tab.url)
  };
}

function slimDownload(item, includeSensitive = false) {
  if (!item) {
    return null;
  }
  const filename = String(item.filename || "");
  return {
    id: item.id,
    url: includeSensitive ? item.url : sanitizeUrl(item.url),
    referrer: includeSensitive ? item.referrer : sanitizeUrl(item.referrer),
    filename: includeSensitive ? filename : filename.split(/[\\/]/).pop(),
    state: item.state,
    danger: item.danger,
    mime: item.mime,
    fileSize: item.fileSize,
    totalBytes: item.totalBytes,
    exists: item.exists,
    startTime: item.startTime,
    endTime: item.endTime,
    error: item.error
  };
}

function sanitizeUrl(value) {
  if (!value || typeof value !== "string") {
    return value || "";
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "file:", "chrome:", "chrome-extension:", "about:", "data:", "blob:"].includes(parsed.protocol)) {
      return `${parsed.protocol}`;
    }
    if (parsed.protocol === "data:") {
      const comma = value.indexOf(",");
      return `${comma >= 0 ? value.slice(0, comma) : "data:"},<redacted>`;
    }
    if (parsed.protocol === "blob:") {
      return "blob:<redacted>";
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return TabWardSecurity.redactSensitiveText(value);
  }
}

function toSafeError(error) {
  const safe = {
    name: error && error.name ? error.name : "Error",
    message: TabWardSecurity.redactSensitiveText(
      sanitizeUrl(error && error.message ? error.message : String(error))
    )
  };
  const count = Number.isInteger(error?.candidateCount)
    ? error.candidateCount
    : Number.isInteger(error?.latest?.count)
      ? error.latest.count
      : null;
  if (count !== null) {
    safe.count = count;
  }
  if (Array.isArray(error?.candidates)) {
    safe.candidates = error.candidates.slice(0, 5).map((candidate) => ({
      tag: candidate?.tag || "",
      role: candidate?.role || "",
      name: String(candidate?.name || "").slice(0, 120),
      text: String(candidate?.text || "").slice(0, 120),
      visible: candidate?.visible === true,
      enabled: candidate?.enabled === true
    }));
  }
  if (
    error?.name === "OutcomeUnknown"
    && error?.details?.kind === "download"
    && ["post_click_error", "post_click_timeout", "post_download_commit"].includes(error.details.phase)
  ) {
    safe.details = {
      kind: "download",
      phase: error.details.phase,
      actionAccepted: error.details.actionAccepted === true,
      reservationHeld: error.details.reservationHeld === true,
      retrySafe: false
    };
  } else if (error?.details && typeof error.details === "object") {
    safe.details = Object.fromEntries(
      [
        "outcome", "effectPossible", "retrySafe", "reason",
        "truncated", "partial", "byteBudget"
      ]
        .filter((key) => Object.prototype.hasOwnProperty.call(error.details, key))
        .map((key) => [key, error.details[key]])
    );
  }
  return safe;
}

function downloadOutcomeUnknown(phase, message, cause = null) {
  const error = new Error(message);
  error.name = "OutcomeUnknown";
  error.details = {
    kind: "download",
    phase,
    actionAccepted: true,
    reservationHeld: true,
    retrySafe: false
  };
  if (cause) error.cause = cause;
  return error;
}

function looksSensitiveField(record) {
  const marker = [
    record?.type,
    record?.name,
    record?.id,
    record?.ariaLabel,
    record?.placeholder
  ].join(" ").toLowerCase();
  return ["password", "hidden"].includes(record?.type) || /(?:password|passwd|secret|token|api[-_ ]?key|authorization|session|otp|pin)/i.test(marker);
}

function redactSensitiveText(value) {
  return TabWardSecurity.redactSensitiveText(value);
}

function sanitizeBrowserPayload(value, key = "") {
  if (value && typeof value === "object" && !Array.isArray(value) && looksSensitiveField(value)) {
    const copy = { ...value };
    if (Object.prototype.hasOwnProperty.call(copy, "value")) {
      copy.valueLength = String(copy.value || "").length;
      copy.value = "[REDACTED]";
    }
    return TabWardSecurity.redactBrowserPayload(copy, key);
  }
  const redacted = TabWardSecurity.redactBrowserPayload(value, key);
  if (typeof redacted === "string"
    && /^(?:url|href|parentHref|src|srcset|backgroundImage|favIconUrl|referrer)$/i.test(key)) {
    return sanitizeUrl(redacted);
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// CDP (Chrome DevTools Protocol) debugger management
// ---------------------------------------------------------------------------

const CDP_VERSION = "1.3";
const cdpTabs = new Set();
const cdpEventBrokers = new Map();
const storageSnapshots = new Map();
const MAX_CDP_EVENTS = 5000;
const VIEWPORT_TOLERANCE_PX = 2;

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    cdpTabs.delete(source.tabId);
    cdpEventBrokers.delete(source.tabId);
    stateStore.mutate({ [CDP_OWNERSHIP_KEY]: {} }, (state) => {
      delete state[CDP_OWNERSHIP_KEY][source.tabId];
      return state;
    }).catch(() => {});
  }
});

function cdpBroker(tabId) {
  if (!cdpEventBrokers.has(tabId)) {
    cdpEventBrokers.set(tabId, {
      sequence: 0,
      events: [],
      eventBytes: 0,
      eventsTruncated: false,
      eventsDropped: 0,
      categories: new Set(),
      started: false,
      inFlight: new Set(),
      traceEvents: [],
      traceBytes: 0,
      traceTruncated: false,
      traceDropped: 0,
      traceComplete: false,
      screencastFrames: [],
      screencastBytes: 0,
      screencastTruncated: false,
      screencastDropped: 0,
      interception: false,
      resourceOwners: new Map()
    });
  }
  return cdpEventBrokers.get(tabId);
}

function cdpResourceOwner(payload) {
  const context = commandContext(payload);
  return {
    operationId: String(context?.operationId || ""),
    sessionId: String(context?.session?.id || "")
  };
}

function claimCdpResource(payload, resource) {
  const broker = cdpBroker(payload.tabId);
  const owner = cdpResourceOwner(payload);
  return TabWardStageThree.claimResource(
    broker.resourceOwners,
    resource,
    owner
  );
}

function releaseCdpResource(payload, resource) {
  const broker = cdpBroker(payload.tabId);
  const owner = cdpResourceOwner(payload);
  return TabWardStageThree.releaseResource(
    broker.resourceOwners,
    resource,
    owner
  );
}

function transitionCdpResource(payload, resource, state) {
  const broker = cdpBroker(payload.tabId);
  return TabWardStageThree.transitionResource(
    broker.resourceOwners,
    resource,
    cdpResourceOwner(payload),
    state
  );
}

function assertExpertCdpResourceSafe(payload) {
  const method = String(payload.method || "");
  const resources = [];
  if (/^(?:Network|Runtime|Log)\./.test(method)
    || /^Page\.(?:enable|disable|handleJavaScriptDialog)/.test(method)) {
    resources.push("events");
  }
  if (/^Fetch\./.test(method)) resources.push("interception");
  if (/^(?:Emulation\.)/.test(method) || method === "Network.emulateNetworkConditions") {
    resources.push("emulation");
  }
  if (/^Tracing\./.test(method)) resources.push("tracing");
  if (/^Page\.(?:startScreencast|stopScreencast)/.test(method)) {
    resources.push("screencast");
  }
  const owner = cdpResourceOwner(payload);
  const broker = cdpEventBrokers.get(payload.tabId);
  for (const resource of resources) {
    const existing = broker?.resourceOwners?.get(resource);
    if (existing && existing.operationId !== owner.operationId) {
      const error = new Error(
        `Expert CDP method ${method} would mutate owned ${resource} state`
      );
      error.name = "CdpResourceInUse";
      throw error;
    }
  }
}

async function cdpDetachIfIdle(tabId) {
  const broker = cdpEventBrokers.get(tabId);
  if (broker?.resourceOwners?.size > 0) {
    return {
      ok: true,
      detached: false,
      preservedResourceOwners: broker.resourceOwners.size
    };
  }
  await cdpDetach(tabId);
  return { ok: true, detached: true };
}

function cdpEventCategory(method) {
  if (method.startsWith("Network.") || method.startsWith("Fetch.")) {
    return "network";
  }
  if (method.startsWith("Runtime.") || method.startsWith("Log.")) {
    return "console";
  }
  if (method === "Page.javascriptDialogOpening" || method === "Page.javascriptDialogClosed") {
    return "dialog";
  }
  if (method.startsWith("Page.")) {
    return "navigation";
  }
  if (method.startsWith("Tracing.")) {
    return "trace";
  }
  return "cdp";
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) {
    return;
  }
  const broker = cdpEventBrokers.get(source.tabId);
  if (!broker) {
    return;
  }
  if (method === "Network.requestWillBeSent") {
    broker.inFlight.add(params.requestId);
  } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    broker.inFlight.delete(params.requestId);
  } else if (method === "Tracing.dataCollected") {
    for (const event of params.value || []) {
      const bounded = TabWardStageTwo.boundedAppend(
        broker.traceEvents,
        sanitizeBrowserPayload(event),
        { maxCount: MAX_CDP_EVENTS, maxBytes: TRACE_MAX_BYTES }
      );
      broker.traceEvents = bounded.entries;
      broker.traceBytes = bounded.bytes;
      broker.traceTruncated ||= bounded.truncated;
      broker.traceDropped += bounded.droppedCount;
    }
  } else if (method === "Tracing.tracingComplete") {
    broker.traceComplete = true;
    TabWardStageThree.completeStoppingResource(
      broker.resourceOwners,
      "tracing"
    );
  } else if (method === "Page.screencastFrame") {
    const bounded = TabWardStageTwo.boundedAppend(broker.screencastFrames, {
      data: params.data,
      metadata: params.metadata,
      sessionId: params.sessionId,
      receivedAt: Date.now()
    }, { maxCount: 5, maxBytes: SCREENCAST_MAX_BYTES });
    broker.screencastFrames = bounded.entries;
    broker.screencastBytes = bounded.bytes;
    broker.screencastTruncated ||= bounded.truncated;
    broker.screencastDropped += bounded.droppedCount;
    chrome.debugger.sendCommand(
      { tabId: source.tabId },
      "Page.screencastFrameAck",
      { sessionId: params.sessionId }
    ).catch(() => {});
  }
  const category = cdpEventCategory(method);
  if (!broker.categories.has(category) && category !== "trace" && method !== "Fetch.requestPaused") {
    return;
  }
  broker.sequence += 1;
  const bounded = TabWardStageTwo.boundedAppend(broker.events, sanitizeBrowserPayload({
    sequence: broker.sequence,
    timestamp: Date.now(),
    category,
    method,
    params
  }), { maxCount: MAX_CDP_EVENTS, maxBytes: EVENT_MAX_BYTES });
  broker.events = bounded.entries;
  broker.eventBytes = bounded.bytes;
  broker.eventsTruncated ||= bounded.truncated;
  broker.eventsDropped += bounded.droppedCount;
});

async function cdpAttach(tabId) {
  if (cdpTabs.has(tabId)) {
    return;
  }
  try {
    await withTimeout(
      chrome.debugger.attach({ tabId }, CDP_VERSION),
      10000,
      "CDP attach"
    );
  } catch (firstError) {
    if (String(firstError?.message || "").toLowerCase().includes("already attached")) {
      const error = new Error(
        "Chrome reports an existing debugger attachment that this worker cannot prove it owns"
      );
      error.name = "DebuggerOwnershipUnknown";
      throw error;
    }
    throw firstError;
  }
  cdpTabs.add(tabId);
  const ownership = await getOwnership();
  await stateStore.mutate({ [CDP_OWNERSHIP_KEY]: {} }, (state) => {
    state[CDP_OWNERSHIP_KEY][tabId] = {
      tabId,
      sessionId: ownership[tabId]?.sessionId || null,
      workerInstanceId: WORKER_INSTANCE_ID,
      leaseExpiresAt: Number(commandContext(ownership[tabId])?.expiresAt || 0) || null,
      attachedAt: Date.now()
    };
    return state;
  });
}

async function cdpDetach(tabId, options = {}) {
  const broker = cdpEventBrokers.get(tabId);
  const owners = Array.from(broker?.resourceOwners?.values() || []);
  if (owners.length > 0) {
    const forceSessionId = String(options.forceSessionId || "");
    const foreign = owners.filter((owner) => owner.sessionId !== forceSessionId);
    if (!forceSessionId || foreign.length > 0) {
      if (options.preserveForeign === true && forceSessionId && foreign.length > 0) {
        return {
          detached: false,
          reason: "foreign_resource_owner",
          preservedResourceOwners: foreign.length
        };
      }
      const error = new Error("CDP resources are still owned by another operation");
      error.name = "CdpResourceInUse";
      throw error;
    }
  }
  if (!cdpTabs.has(tabId)) {
    return { detached: false, reason: "not_attached" };
  }
  try {
    await withTimeout(
      chrome.debugger.detach({ tabId }),
      5000,
      "CDP detach"
    );
  } finally {
    cdpTabs.delete(tabId);
    cdpEventBrokers.delete(tabId);
    await stateStore.mutate({ [CDP_OWNERSHIP_KEY]: {} }, (state) => {
      delete state[CDP_OWNERSHIP_KEY][tabId];
      return state;
    });
  }
  return { detached: true };
}

async function cdpSend(tabId, method, params = {}, timeoutMs = 30000) {
  if (!cdpTabs.has(tabId)) {
    await cdpAttach(tabId);
  }
  try {
    return await withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params),
      timeoutMs,
      `CDP ${method}`
    );
  } catch (error) {
    if (String(error?.message || "").includes("timed out")) {
      await bestEffort(cdpDetachIfIdle(tabId), 2000, `detach after ${method} timeout`);
    }
    throw error;
  }
}

function cdpTimestamp() {
  return Date.now() / 1000;
}

async function cdpDetachSession(sessionId) {
  const state = await stateStore.read({
    [CDP_OWNERSHIP_KEY]: {},
    [OWNERSHIP_KEY]: {}
  });
  const detached = [];
  const preserved = [];
  for (const tabId of Array.from(cdpTabs)) {
    const broker = cdpEventBrokers.get(tabId);
    const owners = Array.from(broker?.resourceOwners?.values() || []);
    const decision = TabWardStageThree.sessionDetachDecision({
      attachmentSessionId: state[CDP_OWNERSHIP_KEY][tabId]?.sessionId,
      tabSessionId: state[OWNERSHIP_KEY][tabId]?.sessionId,
      owners
    }, sessionId);
    if (!decision.belongs) continue;
    if (!decision.detach) {
      preserved.push({
        tabId,
        reason: "foreign_resource_owner",
        preservedResourceOwners: decision.foreignOwners
      });
      continue;
    }
    const result = await cdpDetach(tabId, {
      forceSessionId: sessionId,
      preserveForeign: true
    });
    if (result.detached) {
      await setEmulationState(tabId, null);
      detached.push(tabId);
    }
    else preserved.push({
      tabId,
      reason: result.reason,
      preservedResourceOwners: result.preservedResourceOwners || 0
    });
  }
  return { detached, preserved };
}

async function enableCdpEvents(tabId, categories) {
  const broker = cdpBroker(tabId);
  broker.categories = new Set(categories || []);
  await cdpAttach(tabId);
  const methods = [];
  if (broker.categories.has("network")) {
    methods.push(["Network.enable", {}]);
  }
  if (broker.categories.has("console")) {
    methods.push(["Runtime.enable", {}], ["Log.enable", {}]);
  }
  if (broker.categories.has("dialog") || broker.categories.has("navigation")) {
    methods.push(["Page.enable", {}]);
  }
  for (const [method, params] of methods) {
    await cdpSend(tabId, method, params);
  }
  broker.started = true;
  return broker;
}

async function waitForNetworkIdle(tabId, timeoutMs, idleMs = 500, context = null) {
  const broker = await enableCdpEvents(tabId, ["network", "navigation"]);
  const deadline = Date.now() + timeoutMs;
  let idleSince = broker.inFlight.size === 0 ? Date.now() : null;
  while (Date.now() < deadline) {
    throwIfCommandAborted(context);
    if (broker.inFlight.size === 0) {
      idleSince = idleSince || Date.now();
      if (Date.now() - idleSince >= idleMs) {
        return { ok: true, inFlight: 0, idleMs };
      }
    } else {
      idleSince = null;
    }
    await sleep(50, commandSignal(context));
  }
  const error = new Error(`Network did not become idle within ${timeoutMs}ms`);
  error.name = "TimeoutError";
  throw error;
}

// ---------------------------------------------------------------------------
// Session / turn management
// ---------------------------------------------------------------------------

const SESSION_KEY = "browserSession";

async function getSession() {
  const state = await sessionGet({ [SESSION_KEY]: null });
  return state[SESSION_KEY];
}

async function setSession(session) {
  await sessionSet({ [SESSION_KEY]: session });
}

async function ensureSession() {
  const current = await getSession();
  if (current && current.id) {
    return current;
  }
  const session = {
    id: crypto.randomUUID(),
    name: "TabWard session",
    createdAt: new Date().toISOString(),
    turnCount: 0
  };
  await setSession(session);
  return session;
}

async function resolveSessionContext(payload = {}) {
  const scoped = commandContext(payload)?.session;
  if (scoped?.id) {
    return scoped;
  }
  if (payload.sessionId) {
    return {
      id: String(payload.sessionId),
      name: String(payload.sessionName || "TabWard MCP"),
      mode: String(payload.sessionMode || "managed"),
      cleanQa: payload.cleanQa === true,
      expiresAt: Number(payload.sessionExpiresAt || 0) || null
    };
  }
  return ensureSession();
}

async function getActiveWindowId() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length > 0 && tabs[0].windowId !== undefined) {
    return tabs[0].windowId;
  }
  const windows = await chrome.windows.getAll({ populate: false, windowTypes: ["normal"] });
  const normal = windows.find((item) => item.type === "normal");
  return normal ? normal.id : undefined;
}

async function getWorkspaceWindows() {
  const state = await sessionGet({ [WORKSPACE_WINDOWS_KEY]: {} });
  return state[WORKSPACE_WINDOWS_KEY] || {};
}

async function setWorkspaceWindows(windows) {
  await stateStore.mutate({ [WORKSPACE_WINDOWS_KEY]: {} }, (state) => {
    state[WORKSPACE_WINDOWS_KEY] = windows;
    return state;
  });
}

async function getLiveSessionWindow(session) {
  const windows = await getWorkspaceWindows();
  const record = windows[session.id];
  if (!record?.windowId) {
    return null;
  }
  try {
    const window = await chrome.windows.get(record.windowId, { populate: false });
    if (window.type === "normal") {
      return window;
    }
  } catch (_error) {
  }
  delete windows[session.id];
  await setWorkspaceWindows(windows);
  return null;
}

async function rememberSessionWindow(session, windowId) {
  await stateStore.mutate({ [WORKSPACE_WINDOWS_KEY]: {} }, (state) => {
    const windows = state[WORKSPACE_WINDOWS_KEY];
    windows[session.id] = {
      windowId,
      sessionName: session.name,
      cleanQa: session.cleanQa === true,
      createdAt: windows[session.id]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    return state;
  });
}

async function forgetSessionWindow(sessionId) {
  await stateStore.mutate({ [WORKSPACE_WINDOWS_KEY]: {} }, (state) => {
    delete state[WORKSPACE_WINDOWS_KEY][sessionId];
    return state;
  });
}

async function getSessionPolicies() {
  const state = await sessionGet({ [SESSION_POLICIES_KEY]: {} });
  return state[SESSION_POLICIES_KEY] || {};
}

async function getSessionWorkspace(session) {
  const policies = await getSessionPolicies();
  if (["isolated", "current"].includes(policies[session.id]?.workspace)) {
    return policies[session.id].workspace;
  }
  const settings = await getUserSettings();
  const workspace = session.cleanQa === true || settings.openInSeparateWindow
    ? "isolated"
    : "current";
  await stateStore.mutate({ [SESSION_POLICIES_KEY]: {} }, (state) => {
    if (!["isolated", "current"].includes(state[SESSION_POLICIES_KEY][session.id]?.workspace)) {
      state[SESSION_POLICIES_KEY][session.id] = {
        workspace,
        mode: session.mode,
        capabilities: Array.isArray(session.capabilities)
          ? [...session.capabilities].sort()
          : [],
        cleanQa: session.cleanQa === true,
        createdAt: new Date().toISOString()
      };
    } else {
      state[SESSION_POLICIES_KEY][session.id] = {
        ...state[SESSION_POLICIES_KEY][session.id],
        mode: session.mode,
        capabilities: Array.isArray(session.capabilities)
          ? [...session.capabilities].sort()
          : [],
        cleanQa: session.cleanQa === true
      };
    }
    return state;
  });
  return workspace;
}

async function forgetSessionPolicy(sessionId) {
  await stateStore.mutate({ [SESSION_POLICIES_KEY]: {} }, (state) => {
    delete state[SESSION_POLICIES_KEY][sessionId];
    return state;
  });
}

async function getCleanQaStates() {
  const state = await sessionGet({ [CLEAN_QA_STATES_KEY]: {} });
  return state[CLEAN_QA_STATES_KEY] || {};
}

async function setCleanQaStates(states) {
  await stateStore.mutate({ [CLEAN_QA_STATES_KEY]: {} }, (state) => {
    state[CLEAN_QA_STATES_KEY] = states;
    return state;
  });
}

async function incognitoAccessAllowed() {
  return Boolean(await chrome.extension.isAllowedIncognitoAccess());
}

async function incognitoWindows() {
  return (await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  })).filter((window) => window.incognito === true);
}

function publicCleanQaState(state) {
  if (!state) return null;
  return {
    requested: true,
    status: state.status,
    clean: state.status === "ready" || state.status === "active",
    tainted: state.status === "tainted",
    windowId: state.windowId ?? null,
    reason: state.reason || null
  };
}

async function prepareCleanQa(session) {
  if (session.mode !== "managed") {
    throw new Error("Clean QA requires managed mode");
  }
  if (!(await incognitoAccessAllowed())) {
    const error = new Error(
      "Clean QA requires Chrome extension access in incognito. Enable 'Allow in incognito' for TabWard."
    );
    error.name = "IncognitoAccessRequired";
    throw error;
  }
  const states = await getCleanQaStates();
  const existing = await incognitoWindows();
  const now = Date.now() / 1000;
  let statesChanged = false;
  for (const [sessionId, state] of Object.entries(states)) {
    if (sessionId === session.id) continue;
    const windowExists = Number.isInteger(state?.windowId)
      && existing.some((window) => window.id === state.windowId);
    const leaseExpired = Number.isFinite(Number(state?.leaseExpiresAt))
      && Number(state.leaseExpiresAt) <= now;
    if (state?.status === "closed" || (leaseExpired && !windowExists)) {
      delete states[sessionId];
      statesChanged = true;
    }
  }
  if (statesChanged) {
    await setCleanQaStates(states);
  }
  const competing = Object.values(states).find((state) =>
    state?.sessionId !== session.id
    && ["ready", "active", "tainted"].includes(state?.status)
  );
  if (competing) {
    const error = new Error("Another TabWard Clean QA session is already active");
    error.name = "CleanQaUnavailable";
    throw error;
  }
  if (existing.length > 0) {
    const error = new Error(
      "Clean QA cannot start while another incognito window exists. Close it or use a regular managed session."
    );
    error.name = "CleanQaNotClean";
    throw error;
  }
  states[session.id] = {
    sessionId: session.id,
    sessionName: session.name,
    status: "ready",
    windowId: null,
    createdTabIds: [],
    leaseExpiresAt: Number(session.expiresAt || 0) || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await setCleanQaStates(states);
  return states[session.id];
}

async function markCleanQaTainted(sessionId, reason) {
  const states = await getCleanQaStates();
  const state = states[sessionId];
  if (!state || state.status === "closed") return null;
  states[sessionId] = {
    ...state,
    status: "tainted",
    reason: String(reason || "Unexpected incognito state"),
    updatedAt: new Date().toISOString()
  };
  await setCleanQaStates(states);
  return states[sessionId];
}

async function validateCleanQa(session) {
  if (session.cleanQa !== true) return null;
  const states = await getCleanQaStates();
  let state = states[session.id];
  if (!state) {
    state = {
      sessionId: session.id,
      sessionName: session.name,
      status: "tainted",
      windowId: null,
      createdTabIds: [],
      leaseExpiresAt: Number(session.expiresAt || 0) || null,
      reason: "Clean QA state was lost",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    states[session.id] = state;
    await setCleanQaStates(states);
    return state;
  }
  const leaseExpiresAt = Number(session.expiresAt || 0);
  if (Number.isFinite(leaseExpiresAt)
    && leaseExpiresAt > Number(state.leaseExpiresAt || 0) + 30) {
    state = {
      ...state,
      leaseExpiresAt,
      updatedAt: new Date().toISOString()
    };
    states[session.id] = state;
    await setCleanQaStates(states);
  }
  const windows = await incognitoWindows();
  if (state.status === "ready") {
    if (windows.length > 0) {
      state = await markCleanQaTainted(
        session.id,
        "An incognito window appeared before the Clean QA workspace was created"
      );
    }
    return state;
  }
  const ownedWindow = windows.find((window) => window.id === state.windowId);
  if (!ownedWindow) {
    return markCleanQaTainted(session.id, "The Clean QA incognito window is no longer available");
  }
  if (windows.some((window) => window.id !== state.windowId)) {
    return markCleanQaTainted(session.id, "Another incognito window exists");
  }
  const ownership = await getOwnership();
  const foreignTab = (ownedWindow.tabs || []).find((tab) => {
    const record = ownership[tab.id];
    return !record || record.sessionId !== session.id
      || !["created", "created-child"].includes(record.kind);
  });
  if (foreignTab) {
    return markCleanQaTainted(
      session.id,
      `Incognito tab ${foreignTab.id} is not owned by this Clean QA session`
    );
  }
  return state;
}

async function forgetCleanQaState(sessionId) {
  const states = await getCleanQaStates();
  delete states[sessionId];
  await setCleanQaStates(states);
}

async function sessionGet(keys) {
  return chrome.storage.session.get(keys);
}

async function sessionSet(values) {
  return chrome.storage.session.set(values);
}

const stateStore = TabWardStageTwo.createStateStore({
  get: (defaults) => chrome.storage.session.get(defaults),
  set: (values) => chrome.storage.session.set(values)
});

async function reconcileStaleMetadata(now = Date.now()) {
  const windows = await bestEffort(
    incognitoWindows(),
    3000,
    "inventory incognito windows during reconciliation"
  );
  const liveWindowIds = new Set(
    Array.isArray(windows) ? windows.map((window) => window.id) : []
  );
  const state = await stateStore.read({
    [CDP_OWNERSHIP_KEY]: {},
    [CLEAN_QA_STATES_KEY]: {},
    [OWNERSHIP_KEY]: {}
  });
  const resources = [
    ...Object.values(state[CDP_OWNERSHIP_KEY] || {}).map((record) => ({
      ...record,
      id: record.tabId,
      type: "debugger"
    })),
    ...Object.values(state[CLEAN_QA_STATES_KEY] || {}).map((record) => ({
      ...record,
      id: record.sessionId,
      type: "clean_qa_lease",
      leaseExpiresAt: Number(record.leaseExpiresAt || 0) * 1000
    })),
    ...Object.values(state[OWNERSHIP_KEY] || {}).map((record) => ({
      ...record,
      id: record.tabId,
      type: "tab"
    }))
  ];
  const plan = TabWardStageTwo.orphanReconciliationPlan(resources, now);
  await stateStore.mutate({
    [CDP_OWNERSHIP_KEY]: {},
    [CLEAN_QA_STATES_KEY]: {}
  }, (current) => {
    for (const [tabId, record] of Object.entries(current[CDP_OWNERSHIP_KEY])) {
      if (record?.workerInstanceId !== WORKER_INSTANCE_ID) {
        delete current[CDP_OWNERSHIP_KEY][tabId];
      }
    }
    for (const [sessionId, record] of Object.entries(current[CLEAN_QA_STATES_KEY])) {
      const expired = Number.isFinite(Number(record?.leaseExpiresAt))
        && Number(record.leaseExpiresAt) * 1000 <= now;
      if (expired && !liveWindowIds.has(record?.windowId)) {
        delete current[CLEAN_QA_STATES_KEY][sessionId];
      }
    }
    return current;
  });
  return plan;
}

async function getWorkTabs() {
  const state = await sessionGet({ [WORK_TABS_KEY]: {} });
  return state[WORK_TABS_KEY] || {};
}

async function setWorkTabs(workTabs) {
  await stateStore.mutate({ [WORK_TABS_KEY]: {} }, (state) => {
    state[WORK_TABS_KEY] = workTabs;
    return state;
  });
}

async function getEmulationStates() {
  const state = await sessionGet({ [EMULATION_STATES_KEY]: {} });
  return state[EMULATION_STATES_KEY] || {};
}

async function setEmulationState(tabId, value) {
  await stateStore.mutate({ [EMULATION_STATES_KEY]: {} }, (state) => {
    if (value) {
      state[EMULATION_STATES_KEY][tabId] = value;
    } else {
      delete state[EMULATION_STATES_KEY][tabId];
    }
    return state;
  });
}

async function getOwnership() {
  const state = await sessionGet({ [OWNERSHIP_KEY]: {} });
  return state[OWNERSHIP_KEY] || {};
}

async function mutateOwnership(mutator) {
  return stateStore.mutate({ [OWNERSHIP_KEY]: {} }, (state) => {
    const result = mutator(state[OWNERSHIP_KEY]);
    if (result && result !== state[OWNERSHIP_KEY]) {
      state[OWNERSHIP_KEY] = result;
    }
    return state;
  });
}

async function reserveDownloadOwnership(sessionId) {
  const reservationId = crypto.randomUUID();
  await stateStore.mutate({ [DOWNLOAD_IDS_KEY]: [] }, (state) => {
    state[DOWNLOAD_IDS_KEY] = TabWardStageOne.reserveDownload(
      state[DOWNLOAD_IDS_KEY], reservationId, sessionId);
    return state;
  });
  return reservationId;
}

async function fulfillDownloadOwnership(reservationId, downloadId, sessionId) {
  await stateStore.mutate({ [DOWNLOAD_IDS_KEY]: [] }, (state) => {
    state[DOWNLOAD_IDS_KEY] = TabWardStageOne.fulfillDownloadReservation(
      state[DOWNLOAD_IDS_KEY], reservationId, downloadId, sessionId);
    return state;
  });
}

async function rollbackDownloadOwnership(reservationId, sessionId) {
  await stateStore.mutate({ [DOWNLOAD_IDS_KEY]: [] }, (state) => {
    state[DOWNLOAD_IDS_KEY] = TabWardStageOne.rollbackDownloadReservation(
      state[DOWNLOAD_IDS_KEY], reservationId, sessionId);
    return state;
  });
}

async function releaseSessionDownloads(sessionId) {
  await stateStore.mutate({ [DOWNLOAD_IDS_KEY]: [] }, (state) => {
    state[DOWNLOAD_IDS_KEY] = TabWardStageOne.releaseSessionDownloads(
      state[DOWNLOAD_IDS_KEY], sessionId);
    return state;
  });
}

async function getKnownDownloadIds(sessionId) {
  const state = await sessionGet({ [DOWNLOAD_IDS_KEY]: [] });
  return new Set(TabWardStageOne.downloadIdsForSession(
    state[DOWNLOAD_IDS_KEY],
    sessionId
  ));
}

async function forgetDownload(downloadId, sessionId) {
  await stateStore.mutate({ [DOWNLOAD_IDS_KEY]: [] }, (state) => {
    state[DOWNLOAD_IDS_KEY] = TabWardStageOne.forgetDownloadForSession(
      state[DOWNLOAD_IDS_KEY], downloadId, sessionId);
    return state;
  });
}

async function rememberTab(tab, kind, context) {
  if (!tab || tab.id === undefined) {
    throw new Error("Cannot own a tab without an id");
  }
  const session = TabWardStageTwo.operationSession(context);
  const record = {
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    kind,
    sessionId: session.id,
    sessionName: session.name,
    cleanQa: session.cleanQa === true,
    ownedAt: new Date().toISOString()
  };
  await stateStore.mutate({ [OWNERSHIP_KEY]: {} }, (state) => {
    state[OWNERSHIP_KEY][tab.id] = record;
    return state;
  });
  return record;
}

async function assertTabOwnership(tabId, options = {}) {
  if (!Number.isInteger(tabId)) {
    const error = new Error("tabId must be an integer");
    error.name = "OwnershipError";
    throw error;
  }
  const ownership = await getOwnership();
  const record = ownership[tabId];
  TabWardStageTwo.assertOwnedRecord(
    record,
    commandContext(options.context),
    options
  );
  if (record.kind === "adopted" && !(await getUserSettings()).allowExistingTabs) {
    await releaseOwnership(tabId);
    const error = new Error(
      "Access to existing user tabs is disabled in the TabWard extension"
    );
    error.name = "OwnershipError";
    throw error;
  }
  try {
    await chrome.tabs.get(tabId);
  } catch (error) {
    await forgetTab(tabId);
    throw error;
  }
  return record;
}

async function detachOwnedTabResources(tabId, sessionId, label) {
  const result = await bestEffort(
    cdpDetach(tabId, {
      forceSessionId: sessionId,
      preserveForeign: true
    }),
    2000,
    label
  );
  if (result?.ok === false || result?.detached === false
    && result?.reason === "foreign_resource_owner") {
    return result;
  }
  cdpEventBrokers.delete(tabId);
  await setEmulationState(tabId, null);
  return result;
}

async function forgetTab(tabId) {
  const ownership = await getOwnership();
  await detachOwnedTabResources(
    tabId,
    ownership[tabId]?.sessionId || "",
    "cdp detach on forget"
  );
  await stateStore.mutate({
    [OWNERSHIP_KEY]: {},
    [WORK_TABS_KEY]: {}
  }, (state) => {
    delete state[OWNERSHIP_KEY][tabId];
    delete state[WORK_TABS_KEY][tabId];
    return state;
  });
}

async function releaseOwnership(tabId, keepWorkState = false) {
  const ownershipBefore = await getOwnership();
  await detachOwnedTabResources(
    tabId,
    ownershipBefore[tabId]?.sessionId || "",
    "cdp detach on release"
  );
  await stateStore.mutate({
    [OWNERSHIP_KEY]: {},
    [WORK_TABS_KEY]: {}
  }, (state) => {
    const ownership = state[OWNERSHIP_KEY];
    const workTabs = state[WORK_TABS_KEY];
    if (keepWorkState && ownership[tabId]) {
      ownership[tabId] = {
      ...ownership[tabId],
      previousKind: ownership[tabId].kind,
      kind: "released",
      releasedAt: new Date().toISOString()
      };
    } else {
      delete ownership[tabId];
    }
    if (!keepWorkState) {
      delete workTabs[tabId];
    }
    return state;
  });
  await bestEffort(updateWorkspaceVisual(), 2500, "update workspace on release");
}

async function getKnownTabs() {
  const ownership = await getOwnership();
  const live = [];
  const stale = [];
  for (const rawId of Object.keys(ownership)) {
    const id = Number(rawId);
    if (ownership[id]?.kind === "released") {
      continue;
    }
    try {
      live.push({
        ...slimTab(await chrome.tabs.get(id)),
        ownership: ownership[id]?.kind || "unknown",
        sessionId: ownership[id]?.sessionId || null,
        sessionName: ownership[id]?.sessionName || null
      });
    } catch (_error) {
      stale.push({
        id,
        sessionId: ownership[id]?.sessionId,
        ownedAt: ownership[id]?.ownedAt,
        kind: ownership[id]?.kind,
        windowId: ownership[id]?.windowId
      });
    }
  }
  if (stale.length > 0) {
    await mutateOwnership((current) => {
      for (const staleRecord of stale) {
        const currentRecord = current[staleRecord.id];
        if (
          currentRecord?.sessionId === staleRecord.sessionId
          && currentRecord?.ownedAt === staleRecord.ownedAt
          && currentRecord?.kind === staleRecord.kind
          && currentRecord?.windowId === staleRecord.windowId
        ) {
          delete current[staleRecord.id];
        }
      }
      return current;
    });
  }
  return live;
}

async function putInWorkspace(
  tabId,
  windowId,
  title = DEFAULT_GROUP_TITLE,
  collapsed = DEFAULT_GROUP_COLLAPSED,
  context
) {
  const session = TabWardStageTwo.operationSession(context);
  const state = await sessionGet({ [WORKSPACE_GROUPS_KEY]: {} });
  const groups = state[WORKSPACE_GROUPS_KEY] || {};
  const groupKey = `${session.id}:${windowId}`;
  const savedGroupId = groups[groupKey];
  if (savedGroupId !== null && savedGroupId !== undefined) {
    try {
      const group = await chrome.tabGroups.get(savedGroupId);
      if (group.windowId === windowId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: savedGroupId });
        await chrome.tabGroups.update(savedGroupId, {
          title,
          color: DEFAULT_GROUP_COLOR,
          collapsed
        });
        return savedGroupId;
      }
    } catch (_error) {
      delete groups[groupKey];
      await sessionSet({ [WORKSPACE_GROUPS_KEY]: groups });
    }
  }
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId }
  });
  await chrome.tabGroups.update(groupId, {
    title,
    color: DEFAULT_GROUP_COLOR,
    collapsed
  });
  groups[groupKey] = groupId;
  await sessionSet({ [WORKSPACE_GROUPS_KEY]: groups });
  return groupId;
}

async function waitForTabComplete(tabId, timeoutMs = 30000, context = null) {
  const deadline = Date.now() + timeoutMs;
  let tab = await chrome.tabs.get(tabId);
  while (Date.now() < deadline) {
    throwIfCommandAborted(context);
    tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return tab;
    }
    await sleep(250, commandSignal(context));
  }
  const error = new Error(`Tab ${tabId} did not finish loading within ${timeoutMs}ms`);
  error.name = "TimeoutError";
  throw error;
}

async function executeInTab(tabId, func, args = [], options = {}) {
  const target = { tabId };
  if (options.frameId !== undefined && options.frameId !== null) {
    target.frameIds = [Number(options.frameId)];
  }
  const results = await chrome.scripting.executeScript({
    target,
    func,
    args
  });
  if (!results || !results[0]) return null;
  const execution = options.frameId !== undefined && options.frameId !== null
    ? TabWardStageTwo.frameTarget(
      results[0],
      Number(options.frameId),
      options.documentId
    )
    : results[0];
  if (execution.result && typeof execution.result === "object") {
    const value = {
      ...execution.result,
      frameId: execution.frameId,
      executionDocumentId: execution.documentId
    };
    if (value.target && typeof value.target === "object") {
      value.target = {
        ...value.target,
        frameId: execution.frameId,
        executionDocumentId: execution.documentId
      };
    }
    return value;
  }
  return execution.result;
}

async function executeInAllFrames(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func,
    args
  });
  return (results || []).map((item) => ({
    frameId: item.frameId,
    documentId: item.documentId,
    result: item.result
  }));
}

function boundedFrameAggregate(frames, maxFrames = 100, maxBytes = 8 * 1024 * 1024) {
  let state = {
    entries: [],
    bytes: 0,
    truncated: false,
    droppedCount: 0,
    droppedBytes: 0
  };
  for (const frame of frames || []) {
    const next = TabWardStageTwo.boundedAppend(state.entries, frame, {
      maxCount: maxFrames,
      maxBytes
    });
    state = {
      entries: next.entries,
      bytes: next.bytes,
      truncated: state.truncated || next.truncated,
      droppedCount: state.droppedCount + next.droppedCount,
      droppedBytes: state.droppedBytes + next.droppedBytes
    };
  }
  const completeness = TabWardStageTwo.aggregateCompleteness(
    state.entries,
    state.truncated
  );
  return {
    frames: state.entries,
    frameCount: (frames || []).length,
    retainedBytes: state.bytes,
    truncated: completeness.truncated,
    partial: completeness.partial,
    droppedCount: state.droppedCount,
    droppedBytes: state.droppedBytes,
    complete: completeness.complete
  };
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function setAgentCursor(tabId, cursor) {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "TABWARD_CURSOR_SET",
      cursor: {
        visible: true,
        label: "TabWard",
        ...cursor
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toSafeError(error) };
  }
}

async function hideAgentCursor(tabId) {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "TABWARD_CURSOR_HIDE" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toSafeError(error) };
  }
}

async function sendContentState(tabId, type, state = {}) {
  try {
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, { type, state });
  } catch (error) {
    return { ok: false, error: toSafeError(error) };
  }
}

async function updateWorkspaceVisual() {
  const state = await sessionGet({ [WORKSPACE_GROUPS_KEY]: {}, [WORK_TABS_KEY]: {} });
  const groups = state[WORKSPACE_GROUPS_KEY] || {};
  if (Object.keys(groups).length === 0) {
    return { ok: true, skipped: true };
  }
  const workTabs = Object.values(state[WORK_TABS_KEY] || {});
  const results = [];
  for (const [groupKey, groupId] of Object.entries(groups)) {
    const separator = groupKey.lastIndexOf(":");
    const sessionId = separator >= 0 ? groupKey.slice(0, separator) : null;
    const windowId = separator >= 0 ? groupKey.slice(separator + 1) : groupKey;
    const windowTabs = workTabs.filter((item) =>
      String(item.windowId) === String(windowId)
      && (!sessionId || item.sessionId === sessionId)
    );
    const sessionName = windowTabs.find((item) => item.sessionName)?.sessionName || "TabWard";
    const baseTitle = `TabWard: ${sessionName}`.slice(0, 80);
    const hasWorkingTab = windowTabs.some((item) => item.status === "working");
    const hasHandoffTab = windowTabs.some((item) => item.status === "handoff");
    const hasDeliverableTab = windowTabs.some((item) => item.status === "deliverable");
    let title = baseTitle;
    let color = DEFAULT_GROUP_COLOR;
    let status = "idle";
    if (hasDeliverableTab) {
      title = `${baseTitle}: done`.slice(0, 80);
      color = DELIVERABLE_GROUP_COLOR;
      status = "deliverable";
    } else if (hasHandoffTab) {
      title = `${baseTitle}: handoff`.slice(0, 80);
      color = HANDOFF_GROUP_COLOR;
      status = "handoff";
    } else if (hasWorkingTab) {
      title = `${baseTitle}: working`.slice(0, 80);
      color = WORKING_GROUP_COLOR;
      status = "working";
    }
    try {
      await chrome.tabGroups.update(Number(groupId), { title, color, collapsed: DEFAULT_GROUP_COLLAPSED });
      results.push({ ok: true, groupId, status, sessionId, windowId: Number(windowId) });
    } catch (error) {
      delete groups[groupKey];
      results.push({ ok: false, groupId, error: toSafeError(error) });
    }
  }
  await sessionSet({ [WORKSPACE_GROUPS_KEY]: groups });
  return { ok: results.every((item) => item.ok), groups: results };
}

async function markTabWorking(tabId, context, label = "TabWard", cursor = null) {
  const ownership = await assertTabOwnership(tabId, { context });
  const workTabs = await getWorkTabs();
  const now = new Date().toISOString();
  workTabs[tabId] = {
    ...(workTabs[tabId] || {}),
    tabId,
    windowId: ownership.windowId,
    sessionId: ownership.sessionId,
    sessionName: ownership.sessionName,
    label,
    status: "working",
    startedAt: workTabs[tabId]?.startedAt || now,
    updatedAt: now
  };
  await setWorkTabs(workTabs);
  await updateWorkspaceVisual();
  try {
    await chrome.action.setBadgeText({ tabId, text: "D" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  } catch (_error) {
  }
  return sendContentState(tabId, "TABWARD_PAGE_MARK_WORKING", {
    label,
    cursor
  });
}

async function markTabIdle(tabId, context, hideCursorAfterMs = IDLE_CURSOR_HIDE_MS) {
  const ownership = await assertTabOwnership(tabId, { context });
  const workTabs = await getWorkTabs();
  const now = new Date().toISOString();
  workTabs[tabId] = {
    ...(workTabs[tabId] || {}),
    tabId,
    windowId: ownership.windowId,
    sessionId: ownership.sessionId,
    sessionName: ownership.sessionName,
    status: "idle",
    updatedAt: now
  };
  await setWorkTabs(workTabs);
  await updateWorkspaceVisual();
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch (_error) {
  }
  return sendContentState(tabId, "TABWARD_PAGE_MARK_IDLE", { hideCursorAfterMs });
}

async function finishTabWork(tabId, context) {
  const ownership = await assertTabOwnership(tabId, { context });
  const workTabs = await getWorkTabs();
  const now = new Date().toISOString();
  workTabs[tabId] = {
    ...(workTabs[tabId] || {}),
    tabId,
    windowId: ownership.windowId,
    sessionId: ownership.sessionId,
    sessionName: ownership.sessionName,
    status: "done",
    updatedAt: now
  };
  await setWorkTabs(workTabs);
  await updateWorkspaceVisual();
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch (_error) {
  }
  await detachOwnedTabResources(
    tabId,
    ownership.sessionId,
    "cdp detach on finish"
  );
  return sendContentState(tabId, "TABWARD_PAGE_CLEANUP", {});
}

async function handoffTab(tabId, context, label = "TabWard") {
  const ownership = await assertTabOwnership(tabId, { context });
  const workTabs = await getWorkTabs();
  const now = new Date().toISOString();
  workTabs[tabId] = {
    ...(workTabs[tabId] || {}),
    tabId,
    windowId: ownership.windowId,
    sessionId: ownership.sessionId,
    sessionName: ownership.sessionName,
    label,
    status: "handoff",
    updatedAt: now
  };
  await setWorkTabs(workTabs);
  await updateWorkspaceVisual();
  try {
    await chrome.action.setBadgeText({ tabId, text: "H" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#eab308" });
  } catch (_error) {
  }
  await sendContentState(tabId, "TABWARD_PAGE_MARK_HANDOFF", { label });
  await detachOwnedTabResources(
    tabId,
    ownership.sessionId,
    "cdp detach on handoff"
  );
  return { ok: true, tabId, status: "handoff" };
}

async function deliverableTab(tabId, context, summary = "") {
  const ownership = await assertTabOwnership(tabId, { context });
  const workTabs = await getWorkTabs();
  const now = new Date().toISOString();
  workTabs[tabId] = {
    ...(workTabs[tabId] || {}),
    tabId,
    windowId: ownership.windowId,
    sessionId: ownership.sessionId,
    sessionName: ownership.sessionName,
    status: "deliverable",
    summary,
    updatedAt: now
  };
  await setWorkTabs(workTabs);
  await updateWorkspaceVisual();
  try {
    await chrome.action.setBadgeText({ tabId, text: "\u2713" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#22c55e" });
  } catch (_error) {
  }
  await sendContentState(tabId, "TABWARD_PAGE_MARK_DELIVERABLE", { summary });
  await detachOwnedTabResources(
    tabId,
    ownership.sessionId,
    "cdp detach on deliverable"
  );
  return { ok: true, tabId, status: "deliverable", summary };
}

async function withWorkingTab(tabId, context, label, operation) {
  await assertTabOwnership(tabId, { context });
  await bestEffort(markTabWorking(tabId, context, label), 2500, "mark tab working");
  try {
    return await operation();
  } finally {
    await bestEffort(markTabIdle(tabId, context), 2500, "mark tab idle");
  }
}

async function runOwnedTabOperation(tabId, context, label, operation, visual = true) {
  if (visual === false) {
    await assertTabOwnership(tabId, { context });
    return operation();
  }
  return withWorkingTab(tabId, context, label, operation);
}

function pageText(maxChars) {
  const text = document.body ? document.body.innerText || "" : "";
  return {
    title: document.title,
    url: location.href,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    length: text.length
  };
}

function pageHtml(maxChars) {
  const clone = document.documentElement ? document.documentElement.cloneNode(true) : null;
  if (clone) {
    for (const element of clone.querySelectorAll("input,textarea,select,option")) {
      const marker = [
        element.getAttribute("type"),
        element.getAttribute("name"),
        element.getAttribute("id"),
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder")
      ].join(" ");
      if (element.matches("input[type='password'],input[type='hidden']") || /(?:password|secret|token|api[-_ ]?key|authorization|session|otp|pin)/i.test(marker)) {
        if (element.hasAttribute("value")) {
          element.setAttribute("value", "[REDACTED]");
        }
        element.textContent = "";
      }
    }
    for (const element of clone.querySelectorAll("[data-token],[data-secret],[data-key],[data-auth],[data-session]")) {
      for (const attribute of Array.from(element.attributes)) {
        if (/^data-(?:token|secret|key|auth|session)/i.test(attribute.name)) {
          element.setAttribute(attribute.name, "[REDACTED]");
        }
      }
    }
  }
  const html = clone ? clone.outerHTML || "" : "";
  return {
    title: document.title,
    url: location.href,
    html: html.slice(0, maxChars),
    truncated: html.length > maxChars,
    length: html.length
  };
}

function pageState() {
  return {
    readyState: document.readyState,
    title: document.title,
    url: location.href
  };
}

function pageExtractTables(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 10), 50));
  const maxCellChars = Math.max(1, Math.min(Number(options.maxCellChars || 300), 2000));
  return {
    title: document.title,
    url: location.href,
    tables: Array.from(document.querySelectorAll("table")).slice(0, limit).map((table, index) => {
      const rows = Array.from(table.rows || []).slice(0, 100).map((row) =>
        Array.from(row.cells || []).slice(0, 30).map((cell) =>
          (cell.innerText || cell.textContent || "").trim().slice(0, maxCellChars)
        )
      );
      return {
        index: index + 1,
        caption: table.caption ? (table.caption.innerText || "").trim().slice(0, 200) : "",
        rowCount: table.rows ? table.rows.length : rows.length,
        rows
      };
    })
  };
}

function pageObserve(options = {}) {
  const include = new Set(Array.isArray(options.include) ? options.include : ["state", "interactive", "links", "forms"]);
  const limits = options.limits || {};
  const visibleOnly = options.visibleOnly === true;
  const maxChars = boundedObserveLimit(options.maxChars, 50_000, 200_000);
  const documentIdKey = "__TABWARD_OBSERVE_DOCUMENT_ID__";
  if (!globalThis[documentIdKey]) {
    globalThis[documentIdKey] = crypto.randomUUID();
  }

  function bounded(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.round(parsed), maximum)) : fallback;
  }

  function boundedObserveLimit(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1000, Math.min(Math.round(parsed), maximum)) : fallback;
  }

  function escapeCss(value) {
    if (globalThis.CSS?.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const root = current.getRootNode();
      const parts = [];
      let node = current;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        if (node.id) {
          parts.unshift(`#${escapeCss(node.id)}`);
          break;
        }
        const parent = node.parentElement;
        const tag = node.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
        node = parent;
      }
      const prefix = root === document && !String(parts[0] || "").startsWith("#") ? "body > " : "";
      segments.unshift(`${prefix}${parts.join(" > ")}`);
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return segments.join(" >>> ");
  }

  function actionableHref(element) {
    const anchor = element.matches("a[href]") ? element : element.closest("a[href]");
    const raw = anchor?.getAttribute("href") || "";
    if (!raw || raw === "#" || raw.startsWith("#") || /^\s*javascript:/i.test(raw)) {
      return "";
    }
    return anchor?.href || "";
  }

  function deepRoots(root = document) {
    const roots = [root];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        roots.push(...deepRoots(element.shadowRoot));
      }
    }
    return roots;
  }

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  }

  function enabled(element) {
    return !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
  }

  function resolveScope(selector) {
    const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    let root = document;
    let element = null;
    for (let index = 0; index < segments.length; index += 1) {
      element = root.querySelector(segments[index]);
      if (!element) return null;
      if (index < segments.length - 1) {
        root = element.shadowRoot;
        if (!root) return null;
      }
    }
    return element;
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      bottom: Math.round(rect.bottom),
      right: Math.round(rect.right)
    };
  }

  function normalizedText(value, maximum = 500) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function describe(element) {
    const tag = element.tagName.toLowerCase();
    const text = normalizedText(element.innerText || element.textContent, 500);
    const ariaLabel = normalizedText(element.getAttribute("aria-label"), 300);
    const placeholder = normalizedText(element.getAttribute("placeholder"), 300);
    const role = element.getAttribute("role") || "";
    const name = element.getAttribute("name") || "";
    const type = element.getAttribute("type") || "";
    const ref = cssPath(element);
    const href = actionableHref(element);
    return {
      ref,
      locator: {
        ref,
        documentId: globalThis[documentIdKey],
        tag,
        id: element.id || "",
        name,
        type,
        role,
        ariaLabel,
        placeholder,
        text: text.slice(0, 220),
        href,
        fingerprint: [tag, element.id || "", name, type, role, ariaLabel, placeholder, text.slice(0, 100)].join("|")
      },
      tag,
      type,
      role,
      name,
      ariaLabel,
      placeholder,
      text,
      value: "value" in element ? element.value || "" : "",
      href,
      src: element.currentSrc || element.src || "",
      alt: element.alt || "",
      titleAttr: element.title || "",
      visible: visible(element),
      enabled: element.disabled !== true && element.getAttribute("aria-disabled") !== "true",
      checked: element.checked === true,
      selected: element.selected === true,
      rect: rectOf(element),
      naturalWidth: element.naturalWidth || 0,
      naturalHeight: element.naturalHeight || 0
    };
  }

  const scope = options.selector ? resolveScope(options.selector) : null;
  if (options.selector && !scope) {
    return {
      ok: false,
      error: "Observe selector did not match an element",
      selector: String(options.selector)
    };
  }
  const roots = scope ? deepRoots(scope) : deepRoots();
  function scopedQuery(selector) {
    const own = scope && scope.matches(selector) ? [scope] : [];
    return own.concat(roots.flatMap((root) => Array.from(root.querySelectorAll(selector))));
  }
  const interactiveSelector = "a[href],button,input,textarea,select,summary,[role='button'],[role='link'],[role='textbox'],[onclick],[tabindex],video,audio";
  const interactiveElements = scopedQuery(interactiveSelector)
    .filter((element) => visible(element) && enabled(element));
  const linkElements = scopedQuery("a[href]").filter((element) => !visibleOnly || visible(element));
  const formElements = scopedQuery("form,input,textarea,select,button,label").filter((element) => !visibleOnly || visible(element));
  const imageElements = scopedQuery("img,canvas,[style*='background-image']").filter((element) => {
    if (!element.matches("img,canvas,[style*='background-image']")) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const width = element.naturalWidth || rect.width || 0;
    const height = element.naturalHeight || rect.height || 0;
    return width >= Number(options.imageMinWidth ?? 20) && height >= Number(options.imageMinHeight ?? 20);
  });
  const tableElements = scopedQuery("table").filter((element) => !visibleOnly || visible(element));
  const result = {
    ok: true,
    document: {
      documentId: globalThis[documentIdKey],
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      observedAt: Date.now(),
      viewport: {
        width: globalThis.visualViewport?.width || globalThis.innerWidth || 0,
        height: globalThis.visualViewport?.height || globalThis.innerHeight || 0,
        scrollX: globalThis.scrollX || 0,
        scrollY: globalThis.scrollY || 0,
        devicePixelRatio: globalThis.devicePixelRatio || 1
      }
    },
    counts: {
      interactive: interactiveElements.length,
      links: linkElements.length,
      forms: formElements.length,
      images: imageElements.length,
      tables: tableElements.length
    },
    truncated: {}
  };

  if (include.has("interactive")) {
    const limit = bounded(limits.interactive, 120, 500);
    result.interactive = interactiveElements.slice(0, limit).map(describe);
    result.truncated.interactive = interactiveElements.length > limit;
  }
  if (include.has("links")) {
    const limit = bounded(limits.links, 50, 300);
    result.links = linkElements.slice(0, limit).map(describe);
    result.truncated.links = linkElements.length > limit;
  }
  if (include.has("forms")) {
    const limit = bounded(limits.forms, 50, 300);
    result.forms = formElements.slice(0, limit).map(describe);
    result.truncated.forms = formElements.length > limit;
  }
  if (include.has("images")) {
    const limit = bounded(limits.images, 50, 300);
    result.images = imageElements.slice(0, limit).map((element) => {
      const row = describe(element);
      row.backgroundImage = getComputedStyle(element).backgroundImage || "";
      return row;
    });
    result.truncated.images = imageElements.length > limit;
  }
  if (include.has("tables")) {
    const limit = bounded(limits.tables, 10, 50);
    const cellChars = bounded(limits.cellChars, 300, 2000);
    result.tables = tableElements.slice(0, limit).map((table, index) => ({
      index: index + 1,
      caption: normalizedText(table.caption?.innerText, 200),
      rowCount: table.rows?.length || 0,
      rows: Array.from(table.rows || []).slice(0, 100).map((row) =>
        Array.from(row.cells || []).slice(0, 30).map((cell) => normalizedText(cell.innerText || cell.textContent, cellChars))
      )
    }));
    result.truncated.tables = tableElements.length > limit;
  }
  if (include.has("text")) {
    const text = scope ? scope.innerText || scope.textContent || "" : (document.body ? document.body.innerText || "" : "");
    const limit = bounded(limits.textChars, 8000, 120000);
    result.text = {
      value: text.slice(0, limit),
      length: text.length,
      truncated: text.length > limit
    };
  }
  for (const key of ["interactive", "links", "forms", "images", "tables"]) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].filter((item) => item && item.visible !== false || key === "tables");
    }
  }
  let outputCapApplied = false;
  while (JSON.stringify(result).length > Math.max(100, maxChars - 200)) {
    const candidates = ["interactive", "links", "forms", "images", "tables", "text"]
      .filter((key) => Array.isArray(result[key]) ? result[key].length > 1 : Boolean(result[key]?.value?.length > 200));
    if (!candidates.length) break;
    outputCapApplied = true;
    const key = candidates[0];
    if (key === "text") {
      result.text.value = result.text.value.slice(0, Math.max(100, Math.floor(result.text.value.length * 0.7)));
      result.text.truncated = true;
    } else {
      result[key].splice(Math.max(1, Math.floor(result[key].length * 0.7)));
      result.truncated[key] = true;
    }
  }
  result.outputTruncated = outputCapApplied;
  result.outputChars = JSON.stringify(result).length;
  return result;
}

function pageSnapshot(limit) {
  function escapeCss(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const root = current.getRootNode();
      const parts = [];
      let node = current;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        if (node.id) {
          parts.unshift(`#${escapeCss(node.id)}`);
          break;
        }
        const parent = node.parentElement;
        const tag = node.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
        node = parent;
      }
      const prefix = root === document && !String(parts[0] || "").startsWith("#") ? "body > " : "";
      segments.unshift(`${prefix}${parts.join(" > ")}`);
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return segments.join(" >>> ");
  }

  function deepRoots(root = document) {
    const roots = [root];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        roots.push(...deepRoots(element.shadowRoot));
      }
    }
    return roots;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  const selector = [
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[role='button']",
    "[role='link']",
    "[onclick]",
    "[tabindex]"
  ].join(",");
  const candidates = deepRoots().flatMap((root) => Array.from(root.querySelectorAll(selector))).filter(isVisible).slice(0, limit);
  return {
    title: document.title,
    url: location.href,
    elements: candidates.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const text = (element.innerText || element.value || element.getAttribute("aria-label") || "").trim();
      return {
        ref: cssPath(element),
        fingerprint: `${element.tagName}|${element.id || ""}|${element.getAttribute("name") || ""}|${text.slice(0, 80)}`,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || "",
        role: element.getAttribute("role") || "",
        name: element.getAttribute("name") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        placeholder: element.getAttribute("placeholder") || "",
        text: text.slice(0, 220),
        href: element.href || "",
        selector: cssPath(element),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    })
  };
}

function pageQuery(selector, limit) {
  return {
    title: document.title,
    url: location.href,
    elements: Array.from(document.querySelectorAll(selector)).slice(0, limit).map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || "",
      name: element.getAttribute("name") || "",
      text: (element.innerText || element.textContent || "").trim().slice(0, 1000),
      value: element.value || "",
      href: element.href || "",
      src: element.currentSrc || element.src || "",
      alt: element.alt || "",
      titleAttr: element.title || "",
      naturalWidth: element.naturalWidth || 0,
      naturalHeight: element.naturalHeight || 0,
      id: element.id || "",
      className: element.className || ""
    }))
  };
}

function pageQueryRich(selector, options = {}) {
  const limit = options.limit || 50;
  const maxText = options.maxText || 1000;
  const visibleOnly = options.visibleOnly === true;
  const includeData = options.includeData === true;

  function escapeCss(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const root = current.getRootNode();
      const parts = [];
      let node = current;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        if (node.id) {
          parts.unshift(`#${escapeCss(node.id)}`);
          break;
        }
        const parent = node.parentElement;
        const tag = node.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
        node = parent;
      }
      const prefix = root === document && !String(parts[0] || "").startsWith("#") ? "body > " : "";
      segments.unshift(`${prefix}${parts.join(" > ")}`);
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return segments.join(" >>> ");
  }

  function deepRoots(root = document) {
    const roots = [root];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        roots.push(...deepRoots(element.shadowRoot));
      }
    }
    return roots;
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      bottom: Math.round(rect.bottom),
      right: Math.round(rect.right)
    };
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0 && style.opacity !== "0";
  }

  function dataAttributes(element) {
    return Object.fromEntries(
      Array.from(element.attributes || [])
        .filter((attribute) => attribute.name.startsWith("data-"))
        .slice(0, 30)
        .map((attribute) => [attribute.name, attribute.value.slice(0, 500)])
    );
  }

  function compactSource(value) {
    if (!value) {
      return "";
    }
    if (!includeData && value.startsWith("data:")) {
      const comma = value.indexOf(",");
      const header = comma >= 0 ? value.slice(0, comma) : "data:";
      return `${header},<${Math.max(value.length - comma - 1, 0)} chars>`;
    }
    return value;
  }

  const elements = deepRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)))
    .filter((element) => !visibleOnly || isVisible(element))
    .slice(0, limit);

  return {
    title: document.title,
    url: location.href,
    elements: elements.map((element, index) => {
      const style = window.getComputedStyle(element);
      const link = element.closest("a[href]");
      return {
        ref: cssPath(element),
        fingerprint: `${element.tagName}|${element.id || ""}|${element.getAttribute("name") || ""}|${(element.innerText || element.textContent || "").trim().slice(0, 80)}`,
        tag: element.tagName.toLowerCase(),
        selector: cssPath(element),
        visible: isVisible(element),
        rect: rectOf(element),
        text: (element.innerText || element.textContent || "").trim().slice(0, maxText),
        value: element.value || "",
        href: element.href || "",
        parentHref: link ? link.href : "",
        src: compactSource(element.currentSrc || element.src || ""),
        srcset: compactSource(element.srcset || element.getAttribute("srcset") || ""),
        alt: element.alt || "",
        titleAttr: element.title || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        role: element.getAttribute("role") || "",
        name: element.getAttribute("name") || "",
        type: element.getAttribute("type") || "",
        placeholder: element.getAttribute("placeholder") || "",
        id: element.id || "",
        className: element.className || "",
        dataset: dataAttributes(element),
        disabled: element.disabled === true,
        checked: element.checked === true,
        selected: element.selected === true,
        naturalWidth: element.naturalWidth || 0,
        naturalHeight: element.naturalHeight || 0,
        clientWidth: element.clientWidth || 0,
        clientHeight: element.clientHeight || 0,
        backgroundImage: compactSource(style.backgroundImage || "")
      };
    })
  };
}

function pageExtractImages(options = {}) {
  const selector = options.selector || "img,canvas,[style*='background-image']";
  const limit = options.limit || 50;
  const includeData = options.includeData === true;
  const visibleOnly = options.visibleOnly !== false;
  const minWidth = options.minWidth === undefined ? 20 : Number(options.minWidth);
  const minHeight = options.minHeight === undefined ? 20 : Number(options.minHeight);

  function escapeCss(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    if (element.id) {
      return `#${escapeCss(element.id)}`;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
      current = parent;
    }
    return `body > ${parts.join(" > ")}`;
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left)
    };
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0 && style.opacity !== "0";
  }

  function firstSrcsetUrl(value) {
    if (!value) {
      return "";
    }
    return value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).pop() || "";
  }

  function backgroundUrl(element) {
    const background = window.getComputedStyle(element).backgroundImage || "";
    const match = background.match(/url\((['"]?)(.*?)\1\)/);
    return match ? match[2] : "";
  }

  function absoluteUrl(value) {
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
      return value || "";
    }
    try {
      return new URL(value, location.href).href;
    } catch (_error) {
      return value;
    }
  }

  function compactSource(value) {
    if (!value) {
      return "";
    }
    if (!includeData && value.startsWith("data:")) {
      const comma = value.indexOf(",");
      const header = comma >= 0 ? value.slice(0, comma) : "data:";
      return `${header},<${Math.max(value.length - comma - 1, 0)} chars>`;
    }
    return value;
  }

  const seen = new Set();
  const images = [];
  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (visibleOnly && !isVisible(element)) {
      continue;
    }
    const rect = rectOf(element);
    const naturalWidth = element.naturalWidth || rect.width || element.width || 0;
    const naturalHeight = element.naturalHeight || rect.height || element.height || 0;
    if (naturalWidth < minWidth || naturalHeight < minHeight) {
      continue;
    }
    const source = absoluteUrl(
      element.currentSrc ||
      element.src ||
      element.getAttribute("data-src") ||
      element.getAttribute("data-original") ||
      firstSrcsetUrl(element.srcset || element.getAttribute("srcset")) ||
      backgroundUrl(element)
    );
    if (!source && element.tagName.toLowerCase() !== "canvas") {
      continue;
    }
    const key = `${source}|${cssPath(element)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const link = element.closest("a[href]");
    images.push({
      index: images.length + 1,
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      className: element.className || "",
      selector: cssPath(element),
      visible: isVisible(element),
      rect,
      src: compactSource(source),
      sourceKind: source.startsWith("data:") ? "data" : source.startsWith("blob:") ? "blob" : element.tagName.toLowerCase() === "canvas" ? "canvas" : "url",
      alt: element.alt || element.getAttribute("aria-label") || "",
      titleAttr: element.title || "",
      naturalWidth: Math.round(naturalWidth),
      naturalHeight: Math.round(naturalHeight),
      parentHref: link ? link.href : "",
      parentText: link ? (link.innerText || link.textContent || "").trim().slice(0, 500) : ""
    });
    if (images.length >= limit) {
      break;
    }
  }

  return {
    title: document.title,
    url: location.href,
    images
  };
}

async function pageResolveImageForDownload(payload = {}) {
  const selector = payload.selector || "img,canvas,[style*='background-image']";
  const index = Math.max(Number(payload.index || 1), 1);
  const visibleOnly = payload.visibleOnly !== false;
  const minWidth = payload.minWidth === undefined ? 20 : Number(payload.minWidth);
  const minHeight = payload.minHeight === undefined ? 20 : Number(payload.minHeight);

  function escapeCss(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    if (element.id) {
      return `#${escapeCss(element.id)}`;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
      const siblingIndex = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${siblingIndex})`);
      current = parent;
    }
    return `body > ${parts.join(" > ")}`;
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left)
    };
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0 && style.opacity !== "0";
  }

  function firstSrcsetUrl(value) {
    if (!value) {
      return "";
    }
    return value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).pop() || "";
  }

  function backgroundUrl(element) {
    const background = window.getComputedStyle(element).backgroundImage || "";
    const match = background.match(/url\((['"]?)(.*?)\1\)/);
    return match ? match[2] : "";
  }

  function absoluteUrl(value) {
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
      return value || "";
    }
    try {
      return new URL(value, location.href).href;
    } catch (_error) {
      return value;
    }
  }

  async function toDataUrl(url) {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  }

  const candidates = [];
  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (visibleOnly && !isVisible(element)) {
      continue;
    }
    const rect = rectOf(element);
    const naturalWidth = element.naturalWidth || rect.width || element.width || 0;
    const naturalHeight = element.naturalHeight || rect.height || element.height || 0;
    if (naturalWidth < minWidth || naturalHeight < minHeight) {
      continue;
    }
    const tag = element.tagName.toLowerCase();
    let source = absoluteUrl(
      element.currentSrc ||
      element.src ||
      element.getAttribute("data-src") ||
      element.getAttribute("data-original") ||
      firstSrcsetUrl(element.srcset || element.getAttribute("srcset")) ||
      backgroundUrl(element)
    );
    if (!source && tag !== "canvas") {
      continue;
    }
    candidates.push({ element, tag, source, rect, naturalWidth, naturalHeight });
  }

  const candidate = candidates[index - 1];
  if (!candidate) {
    return { ok: false, error: `Image index ${index} not found`, count: candidates.length };
  }

  const { element, tag, rect, naturalWidth, naturalHeight } = candidate;
  let source = candidate.source;
  let sourceKind = source.startsWith("data:") ? "data" : source.startsWith("blob:") ? "blob" : tag === "canvas" ? "canvas" : "url";
  if (tag === "canvas") {
    source = element.toDataURL(payload.mimeType || "image/png");
    sourceKind = "canvas";
  } else if (source.startsWith("blob:")) {
    source = await toDataUrl(source);
    sourceKind = "blob-data";
  }

  const link = element.closest("a[href]");
  const mimeMatch = source.match(/^data:([^;,]+)/);
  return {
    ok: true,
    index,
    count: candidates.length,
    url: source,
    sourceKind,
    mimeType: mimeMatch ? mimeMatch[1] : "",
    selector: cssPath(element),
    id: element.id || "",
    tag,
    rect,
    alt: element.alt || element.getAttribute("aria-label") || "",
    titleAttr: element.title || "",
    naturalWidth: Math.round(naturalWidth),
    naturalHeight: Math.round(naturalHeight),
    parentHref: link ? link.href : "",
    parentText: link ? (link.innerText || link.textContent || "").trim().slice(0, 500) : ""
  };
}

function pageResolveActionTarget(payload) {
  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function deepRoots(root = document) {
    const roots = [root];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        roots.push(...deepRoots(element.shadowRoot));
      }
    }
    return roots;
  }

  function deepQuery(selector) {
    const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    if (segments.length > 1) {
      let root = document;
      let element = null;
      for (let index = 0; index < segments.length; index += 1) {
        element = root.querySelector(segments[index]);
        if (!element) {
          return [];
        }
        if (index < segments.length - 1) {
          root = element.shadowRoot;
          if (!root) {
            return [];
          }
        }
      }
      return element ? [element] : [];
    }
    return deepRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  }

  function enabled(element) {
    return !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
  }

  function receivesEvents(element, rect) {
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!top) return false;
    if (top === element || element.contains(top)) return true;
    let current = element;
    while (current) {
      const root = current.getRootNode();
      if (!(root instanceof ShadowRoot)) break;
      if (top === root.host) return true;
      current = root.host;
    }
    return false;
  }

  function escapeCss(value) {
    if (globalThis.CSS?.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const root = current.getRootNode();
      const parts = [];
      let node = current;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        if (node.id) {
          parts.unshift(`#${escapeCss(node.id)}`);
          break;
        }
        const parent = node.parentElement;
        const tag = node.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
        node = parent;
      }
      const prefix = root === document && !String(parts[0] || "").startsWith("#") ? "body > " : "";
      segments.unshift(`${prefix}${parts.join(" > ")}`);
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return segments.join(" >>> ");
  }

  function actionableHref(element) {
    const anchor = element.matches("a[href]") ? element : element.closest("a[href]");
    const raw = anchor?.getAttribute("href") || "";
    if (!raw || raw === "#" || raw.startsWith("#") || /^\s*javascript:/i.test(raw)) {
      return "";
    }
    return anchor?.href || "";
  }

  function locatorScore(element, locator) {
    if (!locator || typeof locator !== "object") {
      return 0;
    }
    const text = normalize(element.innerText || element.textContent).toLowerCase();
    const expectedText = normalize(locator.text).toLowerCase();
    let score = 0;
    if (locator.tag) {
      score += element.tagName.toLowerCase() === normalize(locator.tag).toLowerCase() ? 18 : -60;
    }
    for (const [field, actual, weight] of [
      ["id", element.id, 40],
      ["name", element.getAttribute("name"), 24],
      ["type", element.getAttribute("type"), 12],
      ["role", element.getAttribute("role"), 18],
      ["ariaLabel", element.getAttribute("aria-label"), 28],
      ["placeholder", element.getAttribute("placeholder"), 20]
    ]) {
      if (locator[field]) {
        score += normalize(actual).toLowerCase() === normalize(locator[field]).toLowerCase() ? weight : 0;
      }
    }
    if (expectedText) {
      score += text === expectedText ? 28 : text.includes(expectedText) || expectedText.includes(text) ? 14 : 0;
    }
    if (locator.href) {
      const href = element.href || element.closest("a[href]")?.href || "";
      score += href === locator.href ? 20 : 0;
    }
    return score;
  }

  const locator = payload.locator && typeof payload.locator === "object" ? payload.locator : null;
  const currentDocumentId = globalThis.__TABWARD_OBSERVE_DOCUMENT_ID__ || "";
  const staleDocument = Boolean(locator?.documentId && locator.documentId !== currentDocumentId);
  if (staleDocument && payload.allowRecovery !== true) {
    return {
      ok: false,
      staleDocument: true,
      error: "Locator belongs to a different document",
      expectedDocumentId: locator.documentId,
      documentId: currentDocumentId
    };
  }

  let candidates = [];
  const selector = payload.ref || payload.selector
    || locator?.ref || locator?.selector || locator?.css;
  if (selector && !staleDocument) {
    candidates = deepQuery(selector);
  } else {
    const needle = normalize(payload.text || payload.contains).toLowerCase();
    const exact = Boolean(payload.text);
    candidates = deepRoots().flatMap((root) => Array.from(root.querySelectorAll("a,button,input,textarea,select,summary,[role='button'],[role='link'],[onclick],[tabindex]")))
      .filter((item) => {
        const haystack = normalize(item.innerText || item.value || item.getAttribute("aria-label") || item.textContent).toLowerCase();
        const roleMatches = !payload.role || normalize(item.getAttribute("role") || item.tagName).toLowerCase() === normalize(payload.role).toLowerCase();
        const nameValue = normalize(item.getAttribute("aria-label") || item.getAttribute("name") || item.innerText || item.value);
        const nameMatches = !payload.name || nameValue.toLowerCase() === normalize(payload.name).toLowerCase();
        return roleMatches && nameMatches && (needle ? (exact ? haystack === needle : haystack.includes(needle)) : true);
      });
  }

  candidates = candidates.filter((element) =>
    (payload.includeHidden === true || visible(element)) && enabled(element)
  );
  let recovered = false;
  let locatorScoreValue = 0;
  const locatorHasIdentity = locator && [
    "documentId", "fingerprint", "tag", "id", "name", "type",
    "role", "ariaLabel", "placeholder", "text", "href"
  ].some((key) => locator[key]);
  if (locatorHasIdentity) {
    const exact = candidates.length === 1 ? candidates[0] : null;
    const exactScore = exact ? locatorScore(exact, locator) : 0;
    const minimumScore = Math.max(20, Number(payload.minLocatorScore || 36));
    if (!exact || exactScore < minimumScore) {
      if (payload.allowRecovery !== true) {
        return {
          ok: false,
          staleLocator: true,
          error: "Exact locator no longer identifies the observed element",
          candidateCount: candidates.length,
          locatorScore: exactScore
        };
      }
      const pool = deepRoots().flatMap((root) => Array.from(root.querySelectorAll(
        "a[href],button,input,textarea,select,summary,[role='button'],[role='link'],[role='textbox'],[onclick],[tabindex]"
      ))).filter((element) => payload.includeHidden === true || visible(element));
      const ranked = pool
        .map((element) => ({ element, score: locatorScore(element, locator) }))
        .filter((item) => item.score >= minimumScore)
        .sort((left, right) => right.score - left.score);
      if (ranked.length === 0) {
        return { ok: false, staleLocator: true, error: "Locator recovery found no confident match", candidateCount: 0 };
      }
      if (ranked.length > 1 && ranked[0].score - ranked[1].score < Number(payload.locatorScoreMargin || 8)) {
        return {
          ok: false,
          ambiguous: true,
          staleLocator: true,
          error: "Locator recovery is ambiguous",
          candidateCount: ranked.length,
          candidates: ranked.slice(0, 5).map((item, index) => ({
            index: index + 1,
            score: item.score,
            tag: item.element.tagName.toLowerCase(),
            text: normalize(item.element.innerText || item.element.getAttribute("aria-label")).slice(0, 120)
          }))
        };
      }
      candidates = [ranked[0].element];
      locatorScoreValue = ranked[0].score;
      recovered = true;
    } else {
      locatorScoreValue = exactScore;
    }
  }
  const requestedIndex = Number(payload.index || 0);
  if (candidates.length === 0) {
    return { ok: false, error: "Element not found", candidateCount: 0 };
  }
  if (!requestedIndex && candidates.length > 1) {
    return {
      ok: false,
      ambiguous: true,
      error: `Target matched ${candidates.length} visible elements`,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 5).map((item, index) => ({
        index: index + 1,
        tag: item.tagName.toLowerCase(),
        text: normalize(item.innerText || item.getAttribute("aria-label") || "").slice(0, 120)
      }))
    };
  }
  const element = candidates[Math.max(requestedIndex - 1, 0)];
  if (!element) {
    return { ok: false, error: `Target index ${requestedIndex} does not exist`, candidateCount: candidates.length };
  }
  const beforeRect = element.getBoundingClientRect();
  const wasOutsideViewport = beforeRect.bottom <= 0
    || beforeRect.top >= (globalThis.innerHeight || 0)
    || beforeRect.right <= 0
    || beforeRect.left >= (globalThis.innerWidth || 0);
  element.scrollIntoView({ block: "center", inline: "center" });
  if (typeof element.focus === "function") {
    element.focus({ preventScroll: true });
  }
  const rect = element.getBoundingClientRect();
  if (!receivesEvents(element, rect)) {
    return {
      ok: false,
      error: "Target does not receive pointer events",
      candidateCount: candidates.length,
      ref: cssPath(element)
    };
  }
  return {
    ok: true,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type") || "",
    name: element.getAttribute("name") || "",
    id: element.id || "",
    placeholder: element.getAttribute("placeholder") || "",
    text: element.type === "password" ? "[REDACTED]" : normalize(element.innerText || element.value || element.getAttribute("aria-label") || "").slice(0, 500),
    href: actionableHref(element),
    candidateCount: candidates.length,
    index: requestedIndex || 1,
    ref: cssPath(element),
    scrolled: wasOutsideViewport,
    receivesEvents: true,
    recovered,
    staleDocument,
    locatorScore: locatorScoreValue
  };
}

function pageLocatorSnapshot(locator = {}) {
  function normalize(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function deepRoots(root = document) {
    const roots = [root];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        roots.push(...deepRoots(element.shadowRoot));
      }
    }
    return roots;
  }

  function deepQuery(selector) {
    const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    if (segments.length > 1) {
      let root = document;
      let element = null;
      for (let index = 0; index < segments.length; index += 1) {
        element = root.querySelector(segments[index]);
        if (!element) {
          return [];
        }
        if (index < segments.length - 1) {
          root = element.shadowRoot;
          if (!root) {
            return [];
          }
        }
      }
      return element ? [element] : [];
    }
    return deepRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  function escapeCss(value) {
    return globalThis.CSS?.escape
      ? CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const root = current.getRootNode();
      const parts = [];
      let node = current;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        if (node.id) {
          parts.unshift(`#${escapeCss(node.id)}`);
          break;
        }
        const parent = node.parentElement;
        const tag = node.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
        node = parent;
      }
      const prefix = root === document && !String(parts[0] || "").startsWith("#") ? "body > " : "";
      segments.unshift(`${prefix}${parts.join(" > ")}`);
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return segments.join(" >>> ");
  }

  function implicitRole(element) {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    if (tag === "button" || (tag === "input" && ["button", "submit", "reset", "image"].includes(type))) return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea" || (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "hidden", "file"].includes(type))) return "textbox";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (tag === "input" && type === "radio") return "radio";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    return "";
  }

  function accessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (normalize(value)) return normalize(value);
    }
    const aria = element.getAttribute("aria-label");
    if (aria) return normalize(aria);
    if (element.labels?.length) {
      return normalize(Array.from(element.labels).map((label) => label.innerText || label.textContent).join(" "));
    }
    return normalize(
      element.getAttribute("alt")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || element.value
      || element.innerText
      || element.textContent
    );
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0
      && rect.width > 0
      && rect.height > 0;
  }

  function isEnabled(element) {
    return !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
  }

  function isEditable(element) {
    return isEnabled(element) && (
      element.isContentEditable
      || element.tagName === "TEXTAREA"
      || (element.tagName === "INPUT" && !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes((element.type || "").toLowerCase()))
    ) && !element.readOnly;
  }

  function receivesEvents(element, rect) {
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!top) return false;
    if (top === element || element.contains(top)) return true;
    let current = element;
    while (current) {
      const root = current.getRootNode();
      if (!(root instanceof ShadowRoot)) break;
      if (top === root.host) return true;
      current = root.host;
    }
    return false;
  }

  function textMatches(actual, expected, exact) {
    if (expected === undefined || expected === null) return true;
    const left = normalize(actual).toLowerCase();
    const right = normalize(expected).toLowerCase();
    return exact ? left === right : left.includes(right);
  }

  let candidates;
  const selector = locator.ref || locator.selector || locator.css;
  if (selector) {
    candidates = deepQuery(selector);
  } else if (locator.xpath) {
    const result = document.evaluate(locator.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    candidates = Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index))
      .filter((item) => item?.nodeType === Node.ELEMENT_NODE);
  } else if (locator.testId) {
    const escaped = escapeCss(locator.testId);
    candidates = deepQuery(`[data-testid="${escaped}"],[data-test-id="${escaped}"],[data-test="${escaped}"]`);
  } else if (locator.label) {
    candidates = deepRoots().flatMap((root) => Array.from(root.querySelectorAll("input,textarea,select,button")))
      .filter((element) => textMatches(
        element.getAttribute("aria-label")
          || (element.labels?.length
            ? Array.from(element.labels).map((label) => label.innerText || label.textContent).join(" ")
            : ""),
        locator.label,
        locator.exact !== false
      ));
  } else {
    candidates = deepRoots().flatMap((root) => Array.from(root.querySelectorAll("*")));
  }

  candidates = candidates.filter((element) => {
    const text = normalize(element.innerText || element.textContent || element.value);
    const name = accessibleName(element);
    return (!locator.role || implicitRole(element).toLowerCase() === normalize(locator.role).toLowerCase())
      && textMatches(name, locator.name, locator.exact !== false)
      && textMatches(text, locator.text, locator.exact === true)
      && textMatches(element.getAttribute("placeholder"), locator.placeholder, locator.exact !== false)
      && textMatches(element.getAttribute("alt"), locator.alt, locator.exact !== false)
      && textMatches(element.getAttribute("title"), locator.title, locator.exact !== false);
  });

  if (locator.visible === true) {
    candidates = candidates.filter(isVisible);
  }
  if (locator.enabledOnly === true) {
    candidates = candidates.filter(isEnabled);
  }
  const summaries = candidates.map((element) => {
    const visible = isVisible(element);
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const role = implicitRole(element).toLowerCase();
    const nativeCheckable = tag === "input" && ["checkbox", "radio"].includes(type);
    const ariaCheckable = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role);
    const checkable = nativeCheckable || ariaCheckable;
    const ariaChecked = String(element.getAttribute("aria-checked") || "").toLowerCase();
    const checkedState = nativeCheckable
      ? (type === "checkbox" && element.indeterminate
        ? "mixed"
        : (element.checked ? "true" : "false"))
      : (ariaCheckable && ["true", "false", "mixed"].includes(ariaChecked)
        ? ariaChecked
        : null);
    let rect = element.getBoundingClientRect();
    let scrolled = false;
    if (locator.actionable === true && visible) {
      const outsideViewport = rect.bottom <= 0
        || rect.top >= (globalThis.innerHeight || 0)
        || rect.right <= 0
        || rect.left >= (globalThis.innerWidth || 0);
      if (outsideViewport) {
        element.scrollIntoView({ block: "center", inline: "center" });
        rect = element.getBoundingClientRect();
        scrolled = true;
      }
    }
    const text = (element.innerText || element.textContent || element.value || "").replace(/\s+/g, " ").trim();
    const fingerprint = [
      element.tagName.toLowerCase(),
      element.id || "",
      element.getAttribute("name") || "",
      element.getAttribute("type") || "",
      element.getAttribute("role") || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("placeholder") || "",
      text.slice(0, 100)
    ].join("|");
    return {
      ref: cssPath(element),
      documentId: globalThis.__TABWARD_OBSERVE_DOCUMENT_ID__ || "",
      fingerprint,
      tag,
      type,
      role,
      name: accessibleName(element).slice(0, 500),
      text: (element.type === "password" ? "[REDACTED]" : normalize(element.innerText || element.textContent || element.value)).slice(0, 500),
      value: element.type === "password" ? "[REDACTED]" : String(element.value ?? ""),
      visible,
      enabled: isEnabled(element),
      editable: isEditable(element),
      checkable,
      checkedState,
      checked: checkedState === "true",
      selected: Boolean(element.selected),
      receivesEvents: visible && receivesEvents(element, rect),
      scrolled,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  });
  const index = locator.index === undefined ? 0 : Math.max(0, Number(locator.index));
  return {
    ok: true,
    count: summaries.length,
    matches: summaries.slice(0, Math.max(20, index + 1)),
    target: summaries[index] || null,
    index
  };
}

function pageLocatorDomAction(payload) {
  const selector = payload.ref;
  const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
  let root = document;
  let element = null;
  for (let index = 0; index < segments.length; index += 1) {
    element = root.querySelector(segments[index]);
    if (!element) break;
    if (index < segments.length - 1) {
      root = element.shadowRoot;
      if (!root) {
        element = null;
        break;
      }
    }
  }
  if (!element) {
    return { ok: false, error: "Element not found" };
  }
  if (payload.action === "select") {
    const requested = Array.isArray(payload.value) ? payload.value.map(String) : [String(payload.value)];
    for (const option of element.options || []) {
      option.selected = requested.includes(option.value) || requested.includes(option.label);
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, values: Array.from(element.selectedOptions || []).map((option) => option.value) };
  }
  if (payload.action === "check" || payload.action === "uncheck") {
    if (!(element instanceof HTMLInputElement) || element.type !== "checkbox") {
      return { ok: false, error: `${payload.action} requires an input[type=checkbox] target` };
    }
    element.checked = payload.action === "check";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, checked: element.checked };
  }
  if (payload.action === "focus") {
    element.focus();
    return { ok: document.activeElement === element };
  }
  if (payload.action === "blur") {
    element.blur();
    return { ok: document.activeElement !== element };
  }
  return { ok: false, error: `Unsupported DOM action: ${payload.action}` };
}

function pageProbe(payload) {
  const limit = Math.max(1, Math.min(200, Number(payload.limit || 50)));
  const allowedStyles = new Set([
    "display", "visibility", "opacity", "position", "overflow", "overflow-x",
    "overflow-y", "width", "height", "max-width", "max-height", "color",
    "background-color", "font-size", "line-height", "z-index", "transform"
  ]);
  function roots(root = document) {
    const values = [root];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) values.push(...roots(element.shadowRoot));
    }
    return values;
  }
  function resolveSelector(selector) {
    const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    let root = document;
    let element = null;
    for (let index = 0; index < segments.length; index += 1) {
      element = root.querySelector(segments[index]);
      if (!element) return null;
      if (index < segments.length - 1) {
        root = element.shadowRoot;
        if (!root) return null;
      }
    }
    return element;
  }
  function normalized(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }
  function deepElements() {
    return roots().flatMap((root) => Array.from(root.querySelectorAll("*")));
  }
  function implicitRole(element) {
    return element.getAttribute("role")
      || ({
        BUTTON: "button", A: element.hasAttribute("href") ? "link" : "",
        INPUT: ["checkbox", "radio"].includes(element.type) ? element.type : "textbox",
        SELECT: "combobox", TEXTAREA: "textbox", IMG: "img"
      }[element.tagName] || "");
  }
  function accessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
    }
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return label.textContent || "";
    }
    const wrappingLabel = element.closest("label");
    return element.getAttribute("aria-label")
      || wrappingLabel?.textContent
      || element.getAttribute("alt")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || element.innerText
      || element.value
      || "";
  }
  function resolveLocator(locator) {
    const direct = locator?.ref || locator?.selector || locator?.css;
    if (direct) {
      try {
        return resolveSelector(direct);
      } catch (_error) {
        return null;
      }
    }
    let candidates = deepElements();
    if (locator?.testId) {
      candidates = candidates.filter((element) =>
        element.getAttribute("data-testid") === locator.testId
        || element.getAttribute("data-test-id") === locator.testId
      );
    }
    if (locator?.role) {
      candidates = candidates.filter((element) => implicitRole(element) === locator.role);
    }
    const checks = [
      ["name", (element) => accessibleName(element)],
      ["label", (element) => accessibleName(element)],
      ["text", (element) => element.innerText || element.textContent],
      ["placeholder", (element) => element.getAttribute("placeholder")],
      ["alt", (element) => element.getAttribute("alt")],
      ["title", (element) => element.getAttribute("title")]
    ];
    for (const [key, read] of checks) {
      if (!locator?.[key]) continue;
      const expected = normalized(locator[key]);
      candidates = candidates.filter((element) => {
        const actual = normalized(read(element));
        return locator.exact === true ? actual === expected : actual.includes(expected);
      });
    }
    if (locator?.visible !== false) candidates = candidates.filter(visible);
    const index = Math.max(0, Number(locator?.index || 0));
    return candidates[index] || null;
  }
  function rect(element) {
    const value = element.getBoundingClientRect();
    return {
      x: Math.round(value.x), y: Math.round(value.y),
      width: Math.round(value.width), height: Math.round(value.height),
      top: Math.round(value.top), right: Math.round(value.right),
      bottom: Math.round(value.bottom), left: Math.round(value.left)
    };
  }
  function visible(element) {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && style.opacity !== "0" && box.width > 0 && box.height > 0;
  }
  const selector = payload.selector;
  const locator = payload.locator || (selector ? { selector } : null);
  const target = locator ? resolveLocator(locator) : null;
  const operation = String(payload.operation || "page_metrics");
  if (selector && !target) return { ok: false, error: "Probe target was not found" };
  if (operation === "page_metrics") {
    return {
      ok: true,
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      document: {
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      },
      scroll: { x: scrollX, y: scrollY }
    };
  }
  if (operation === "overflow") {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const offenders = roots().flatMap((root) => Array.from(root.querySelectorAll("*")))
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ element, box }) => visible(element) && (
        box.right > viewportWidth + 1 || box.left < -1 || box.bottom > viewportHeight + 1
      ))
      .slice(0, limit)
      .map(({ element, box }) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        className: String(element.className || "").slice(0, 200),
        rect: {
          x: Math.round(box.x), y: Math.round(box.y),
          width: Math.round(box.width), height: Math.round(box.height),
          right: Math.round(box.right), bottom: Math.round(box.bottom)
        }
      }));
    return {
      ok: true,
      horizontal: document.documentElement.scrollWidth > viewportWidth + 1,
      vertical: document.documentElement.scrollHeight > viewportHeight + 1,
      viewport: { width: viewportWidth, height: viewportHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      offenders
    };
  }
  if (operation === "box") {
    const box = rect(target);
    const top = document.elementFromPoint(
      Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2)),
      Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2))
    );
    return {
      ok: true, rect: box, visible: visible(target),
      inViewport: box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth,
      receivesEvents: top === target || target.contains(top),
      overlappedBy: top && top !== target && !target.contains(top)
        ? { tag: top.tagName.toLowerCase(), id: top.id || "", className: String(top.className || "").slice(0, 200) }
        : null
    };
  }
  if (operation === "computed_style") {
    const style = getComputedStyle(target);
    const requested = (payload.properties || []).filter((name) => allowedStyles.has(String(name))).slice(0, 50);
    return { ok: true, properties: Object.fromEntries(requested.map((name) => [name, style.getPropertyValue(name)])) };
  }
  if (operation === "dom") {
    const property = String(payload.property || "");
    const attribute = String(payload.attribute || "");
    const safeProperties = new Set(["textContent", "innerText", "value", "checked", "disabled", "selected", "tagName"]);
    return {
      ok: true,
      count: selector
        ? roots().reduce((sum, root) => {
          try {
            return sum + root.querySelectorAll(selector).length;
          } catch (_error) {
            return sum;
          }
        }, 0)
        : target ? 1 : 0,
      text: String(target?.innerText || target?.textContent || "").slice(0, 5_000),
      attribute: attribute ? target?.getAttribute(attribute) : undefined,
      property: safeProperties.has(property) ? target?.[property] : undefined
    };
  }
  if (operation === "image") {
    return {
      ok: true,
      tag: target.tagName.toLowerCase(),
      loaded: target.tagName === "IMG" ? target.complete && target.naturalWidth > 0 : true,
      currentSrc: String(target.currentSrc || target.src || "").slice(0, 2_000),
      naturalWidth: Number(target.naturalWidth || 0),
      naturalHeight: Number(target.naturalHeight || 0),
      rect: rect(target)
    };
  }
  if (operation === "animation") {
    return {
      ok: true,
      animations: target.getAnimations({ subtree: true }).slice(0, limit).map((animation) => ({
        playState: animation.playState,
        currentTime: Number(animation.currentTime || 0),
        startTime: Number(animation.startTime || 0),
        timing: animation.effect?.getComputedTiming?.()
      }))
    };
  }
  if (operation === "accessibility") {
    return {
      ok: true,
      role: implicitRole(target),
      name: String(target.getAttribute("aria-label") || target.innerText || target.value || "").trim().slice(0, 500),
      disabled: target.disabled === true || target.getAttribute("aria-disabled") === "true",
      expanded: target.getAttribute("aria-expanded"),
      checked: target.checked === true || target.getAttribute("aria-checked") === "true"
    };
  }
  return { ok: false, error: `Unsupported probe: ${operation}` };
}

function pageStorageOperation(payload) {
  function entries(storage) {
    return Object.fromEntries(
      Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter(Boolean)
        .map((key) => [key, storage.getItem(key)])
    );
  }
  const operation = payload.operation;
  const data = payload.data || {};
  if (operation === "snapshot" || operation === "get") {
    return {
      origin: location.origin,
      localStorage: entries(localStorage),
      sessionStorage: entries(sessionStorage)
    };
  }
  if (operation === "clear") {
    localStorage.clear();
    sessionStorage.clear();
    return { ok: true, origin: location.origin };
  }
  if (operation === "set" || operation === "restore") {
    if (operation === "restore") {
      localStorage.clear();
      sessionStorage.clear();
    }
    for (const [key, value] of Object.entries(data.localStorage || {})) {
      localStorage.setItem(key, String(value));
    }
    for (const [key, value] of Object.entries(data.sessionStorage || {})) {
      sessionStorage.setItem(key, String(value));
    }
    return {
      ok: true,
      origin: location.origin,
      localStorage: entries(localStorage),
      sessionStorage: entries(sessionStorage)
    };
  }
  if (operation === "remove") {
    for (const key of data.localStorage || []) localStorage.removeItem(String(key));
    for (const key of data.sessionStorage || []) sessionStorage.removeItem(String(key));
    return { ok: true, origin: location.origin };
  }
  return { ok: false, error: `Unsupported storage operation: ${operation}` };
}

function pageInstallClickProbe(ref) {
  const segments = String(ref || "").split(/\s*>>>\s*/).filter(Boolean);
  let root = document;
  let element = null;
  for (let index = 0; index < segments.length; index += 1) {
    element = root.querySelector(segments[index]);
    if (!element) return null;
    if (index < segments.length - 1) {
      root = element.shadowRoot;
      if (!root) return null;
    }
  }
  const token = `${Date.now()}-${Math.random()}`;
  globalThis.__TABWARD_CLICK_PROBES__ = globalThis.__TABWARD_CLICK_PROBES__ || {};
  globalThis.__TABWARD_CLICK_PROBES__[token] = false;
  element.addEventListener("click", () => {
    globalThis.__TABWARD_CLICK_PROBES__[token] = true;
  }, { once: true, capture: true });
  return token;
}

function pageReadClickProbe(token) {
  const probes = globalThis.__TABWARD_CLICK_PROBES__ || {};
  const fired = probes[token] === true;
  delete probes[token];
  return fired;
}

function pageFindAndClick(payload) {
  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function deepRoots(root = document) {
    const roots = [root];
    for (const item of root.querySelectorAll("*")) {
      if (item.shadowRoot) {
        roots.push(...deepRoots(item.shadowRoot));
      }
    }
    return roots;
  }

  function deepQuery(selector) {
    const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    if (segments.length > 1) {
      let root = document;
      let found = null;
      for (let index = 0; index < segments.length; index += 1) {
        found = root.querySelector(segments[index]);
        if (!found) {
          return [];
        }
        if (index < segments.length - 1) {
          root = found.shadowRoot;
          if (!root) {
            return [];
          }
        }
      }
      return found ? [found] : [];
    }
    return deepRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  const selector = payload.ref || payload.selector;
  let candidates = [];
  if (selector) {
    candidates = deepQuery(selector);
  } else if (payload.text || payload.contains) {
    const needle = normalize(payload.text || payload.contains).toLowerCase();
    const exact = Boolean(payload.text);
    candidates = deepRoots().flatMap((root) => Array.from(root.querySelectorAll("a,button,input,textarea,select,summary,[role='button'],[role='link'],[onclick],[tabindex]"))).filter((item) => {
      const haystack = normalize(item.innerText || item.value || item.getAttribute("aria-label") || item.textContent).toLowerCase();
      return exact ? haystack === needle : haystack.includes(needle);
    });
  }

  const requestedIndex = Number(payload.index || 0);
  if (!requestedIndex && candidates.length > 1) {
    return { ok: false, ambiguous: true, error: `Target matched ${candidates.length} elements`, candidateCount: candidates.length };
  }
  const element = candidates[Math.max(requestedIndex - 1, 0)] || null;
  if (!element) {
    return { ok: false, error: "Element not found" };
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  if (typeof element.focus === "function") {
    element.focus({ preventScroll: true });
  }
  const before = location.href;
  // This function is serialized into the target frame and cannot reference
  // extension-worker globals.
  const eventPlan = payload.doubleClick === true
    ? ["click", "click", "dblclick"]
    : ["click"];
  for (const eventName of eventPlan) {
    if (eventName === "click") {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        composed: true,
        detail: 2,
        view: window
      }));
    }
  }
  const clickCount = eventPlan.filter((eventName) => eventName === "click").length;
  return {
    ok: true,
    clickCount,
    doubleClick: clickCount === 2,
    beforeUrl: before,
    afterUrl: location.href,
    tag: element.tagName.toLowerCase(),
    text: element.type === "password" ? "[REDACTED]" : normalize(element.innerText || element.value || element.getAttribute("aria-label") || "").slice(0, 500)
  };
}

function pageFill(payload) {
  const segments = String(payload.ref || payload.selector || "").split(/\s*>>>\s*/).filter(Boolean);
  let root = document;
  let element = null;
  for (let index = 0; index < segments.length; index += 1) {
    element = root.querySelector(segments[index]);
    if (!element) {
      break;
    }
    if (index < segments.length - 1) {
      root = element.shadowRoot;
      if (!root) {
        element = null;
        break;
      }
    }
  }
  if (!element) {
    return { ok: false, error: "Element not found" };
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  if (typeof element.focus === "function") {
    element.focus({ preventScroll: true });
  }
  element.value = payload.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selector: payload.selector, valueLength: String(payload.value || "").length };
}

function pageHasText(text) {
  const haystack = document.body ? document.body.innerText || "" : "";
  return haystack.includes(text);
}

function pageVerifyOutcome(expectation, baseline = null) {
  if (expectation.urlContains) {
    const matched = location.href.includes(expectation.urlContains);
    const changed = !baseline?.expectation?.urlMatched || location.href !== baseline.url;
    return { ok: matched && changed, kind: "url" };
  }
  if (expectation.selector) {
    const matches = Array.from(document.querySelectorAll(expectation.selector));
    const signature = matches.slice(0, 10).map((element) => element.outerHTML.slice(0, 500)).join("|");
    const changed = !baseline || baseline.expectation.selectorCount === 0 ||
      matches.length !== baseline.expectation.selectorCount ||
      signature !== baseline.expectation.selectorSignature;
    return { ok: matches.length > 0 && changed, kind: "selector" };
  }
  if (expectation.text) {
    const haystack = document.body ? document.body.innerText || "" : "";
    const matched = haystack.includes(expectation.text);
    const changed = !baseline?.expectation?.textMatched ||
      haystack.length !== baseline.signature.textLength;
    return { ok: matched && changed, kind: "text" };
  }
  return { ok: true, kind: "dispatch" };
}

function pageCaptureActionBaseline(ref, expectation = {}) {
  function deepQuery(selector) {
    const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    let root = document;
    let element = null;
    for (let index = 0; index < segments.length; index += 1) {
      element = root.querySelector(segments[index]);
      if (!element) {
        return null;
      }
      if (index < segments.length - 1) {
        root = element.shadowRoot;
        if (!root) {
          return null;
        }
      }
    }
    return element;
  }

  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16);
  }

  function targetState(element) {
    if (!element) {
      return null;
    }
    return {
      connected: element.isConnected,
      checked: element.checked === true,
      disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
      expanded: element.getAttribute("aria-expanded") || "",
      pressed: element.getAttribute("aria-pressed") || "",
      selected: element.selected === true || element.getAttribute("aria-selected") === "true",
      text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500)
    };
  }

  const stateKey = "__TABWARD_ACTION_MUTATION_STATE__";
  if (!globalThis[stateKey]) {
    const state = { version: 0 };
    const observer = new MutationObserver(() => {
      state.version += 1;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    state.observer = observer;
    globalThis[stateKey] = state;
  }
  const text = document.body ? document.body.innerText || "" : "";
  const selectorMatches = expectation.selector
    ? Array.from(document.querySelectorAll(expectation.selector))
    : [];
  return {
    documentId: globalThis.__TABWARD_OBSERVE_DOCUMENT_ID__ || "",
    url: location.href,
    mutationVersion: globalThis[stateKey].version,
    signature: {
      textHash: hash(text.slice(0, 30000)),
      textLength: text.length,
      interactiveCount: document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[role='link']").length
    },
    expectation: {
      urlMatched: Boolean(expectation.urlContains && location.href.includes(expectation.urlContains)),
      selectorCount: selectorMatches.length,
      selectorSignature: selectorMatches.slice(0, 10).map((element) => element.outerHTML.slice(0, 500)).join("|"),
      textMatched: Boolean(expectation.text && text.includes(expectation.text))
    },
    target: targetState(deepQuery(ref))
  };
}

function pageVerifyAutomaticOutcome(baseline, ref) {
  function deepQuery(selector) {
    const segments = String(selector || "").split(/\s*>>>\s*/).filter(Boolean);
    let root = document;
    let element = null;
    for (let index = 0; index < segments.length; index += 1) {
      element = root.querySelector(segments[index]);
      if (!element) {
        return null;
      }
      if (index < segments.length - 1) {
        root = element.shadowRoot;
        if (!root) {
          return null;
        }
      }
    }
    return element;
  }

  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16);
  }

  const currentDocumentId = globalThis.__TABWARD_OBSERVE_DOCUMENT_ID__ || "";
  if (baseline.documentId && currentDocumentId && baseline.documentId !== currentDocumentId) {
    return { ok: true, kind: "document-change" };
  }
  if (location.href !== baseline.url) {
    return { ok: true, kind: "url-change" };
  }
  const element = deepQuery(ref);
  const target = element ? {
    connected: element.isConnected,
    checked: element.checked === true,
    disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
    expanded: element.getAttribute("aria-expanded") || "",
    pressed: element.getAttribute("aria-pressed") || "",
    selected: element.selected === true || element.getAttribute("aria-selected") === "true",
    text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500)
  } : null;
  if (JSON.stringify(target) !== JSON.stringify(baseline.target)) {
    return { ok: true, kind: "target-change" };
  }
  const text = document.body ? document.body.innerText || "" : "";
  const signature = {
    textHash: hash(text.slice(0, 30000)),
    textLength: text.length,
    interactiveCount: document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[role='link']").length
  };
  const mutationVersion = globalThis.__TABWARD_ACTION_MUTATION_STATE__?.version || 0;
  if (mutationVersion > baseline.mutationVersion && JSON.stringify(signature) !== JSON.stringify(baseline.signature)) {
    return { ok: true, kind: "dom-change" };
  }
  return { ok: false, kind: "no-observed-change" };
}

function pageVerifyFillValue(ref, expectedValue) {
  const segments = String(ref || "").split(/\s*>>>\s*/).filter(Boolean);
  let root = document;
  let element = null;
  for (let index = 0; index < segments.length; index += 1) {
    element = root.querySelector(segments[index]);
    if (!element) {
      return { ok: false, error: "Element not found during fill verification" };
    }
    if (index < segments.length - 1) {
      root = element.shadowRoot;
      if (!root) {
        return { ok: false, error: "Shadow root not found during fill verification" };
      }
    }
  }
  const actual = element.isContentEditable ? element.innerText : element.value;
  return {
    ok: String(actual ?? "") === String(expectedValue ?? ""),
    valueLength: String(actual ?? "").length
  };
}

async function verifyActionOutcome(tabId, payload, baseline = null) {
  const expectation = {
    urlContains: payload.expectUrlContains,
    selector: payload.expectSelector,
    text: payload.expectText
  };
  if (!expectation.urlContains && !expectation.selector && !expectation.text) {
    return { ok: true, kind: "dispatch" };
  }
  const startedAt = Date.now();
  const timeoutMs = Number(payload.verifyTimeoutMs || 5000);
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await executeInTab(tabId, pageVerifyOutcome, [expectation, baseline], { frameId: payload.frameId });
      if (last?.ok) {
        return { ...last, waitedMs: Date.now() - startedAt };
      }
    } catch (error) {
      last = { ok: false, error: toSafeError(error) };
    }
    await sleep(200, commandSignal(payload));
  }
  return { ...(last || { ok: false }), timeout: true, waitedMs: Date.now() - startedAt };
}

async function verifyAutomaticActionOutcome(tabId, payload, baseline, ref) {
  const startedAt = Date.now();
  const timeoutMs = Math.max(100, Math.min(Number(payload.verifyTimeoutMs || 3000), 30000));
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await executeInTab(tabId, pageVerifyAutomaticOutcome, [baseline, ref], { frameId: payload.frameId });
      if (last?.ok) {
        return { ...last, waitedMs: Date.now() - startedAt };
      }
    } catch (error) {
      last = { ok: false, error: toSafeError(error) };
    }
    await sleep(100, commandSignal(payload));
  }
  return { ...(last || { ok: false, kind: "no-observed-change" }), timeout: true, waitedMs: Date.now() - startedAt };
}

function pageSelectorState(selector, visibleOnly = false) {
  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0 && style.opacity !== "0";
  }

  function escapeCss(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    if (element.id) {
      return `#${escapeCss(element.id)}`;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
      current = parent;
    }
    return `body > ${parts.join(" > ")}`;
  }

  const all = Array.from(document.querySelectorAll(selector));
  const matches = visibleOnly ? all.filter(isVisible) : all;
  const element = matches[0] || null;
  const result = {
    title: document.title,
    url: location.href,
    selector,
    visibleOnly,
    found: Boolean(element),
    count: matches.length,
    totalCount: all.length
  };
  if (!element) {
    return result;
  }

  const rect = element.getBoundingClientRect();
  const link = element.closest("a[href]");
  return {
    ...result,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type") || "",
    name: element.getAttribute("name") || "",
    id: element.id || "",
    placeholder: element.getAttribute("placeholder") || "",
    resolvedSelector: cssPath(element),
    visible: isVisible(element),
    text: (element.innerText || element.textContent || "").trim().slice(0, 500),
    value: element.value || "",
    href: element.href || "",
    parentHref: link ? link.href : "",
    src: element.currentSrc || element.src || "",
    alt: element.alt || "",
    ariaLabel: element.getAttribute("aria-label") || "",
    role: element.getAttribute("role") || "",
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      bottom: Math.round(rect.bottom),
      right: Math.round(rect.right)
    }
  };
}

async function waitForText(tabId, text, timeoutMs = 30000, context = null) {
  const deadline = Date.now() + timeoutMs;
  const probeTimeoutMs = Math.min(2000, Math.max(750, timeoutMs));
  while (Date.now() < deadline) {
    throwIfCommandAborted(context);
    const found = await bestEffort(executeInTab(tabId, pageHasText, [text]), probeTimeoutMs, "text probe");
    if (found === true) {
      return { ok: true, found: true };
    }
    await sleep(500, commandSignal(context));
  }
  return { ok: false, found: false, timeout: true };
}

async function waitForSelector(tabId, selector, timeoutMs = 30000, visibleOnly = false, context = null) {
  if (!selector) {
    throw new Error("selector is required");
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const probeTimeoutMs = Math.min(5000, Math.max(1500, timeoutMs));
  let last = null;
  while (Date.now() < deadline) {
    throwIfCommandAborted(context);
    try {
      last = await withTimeout(executeInTab(tabId, pageSelectorState, [selector, visibleOnly]), probeTimeoutMs, "selector probe");
    } catch (error) {
      last = { ok: false, error: toSafeError(error) };
    }
    if (last && last.found) {
      return { ok: true, waitedMs: Date.now() - startedAt, ...last };
    }
    await sleep(250, commandSignal(context));
  }
  return { ok: false, timeout: true, waitedMs: Date.now() - startedAt, selector, visibleOnly, last };
}

function waitForDownloadCreated(startedAt, timeoutMs, options = {}) {
  let cancel = null;
  const promise = new Promise((resolve) => {
    let finished = false;
    const candidates = [];
    const timer = setTimeout(() => {
      if (!finished) {
        cleanup();
        const ranked = [...candidates].sort((left, right) => right.score - left.score);
        if (ranked.length === 1 && ranked[0].score >= (options.expectedUrl ? 60 : 30)) {
          resolve({ item: ranked[0].item, correlation: ranked[0], ambiguous: false, timedOut: true });
        } else {
          resolve({
            item: null,
            ambiguous: ranked.length > 1,
            timedOut: true,
            candidates: candidates.map((candidate) => ({
              id: candidate.item.id,
              score: candidate.score,
              url: sanitizeUrl(candidate.item.url),
              filename: String(candidate.item.filename || "").split(/[\\/]/).pop()
            }))
          });
        }
      }
    }, timeoutMs);
    const listener = (item) => {
      if (options.beforeIds?.has(item.id)) {
        return;
      }
      const itemTime = item.startTime ? new Date(item.startTime).getTime() : Date.now();
      if (itemTime + 1000 < startedAt) {
        return;
      }
      let score = 0;
      if (options.expectedUrl && item.url === options.expectedUrl) {
        score += 100;
      } else if (options.expectedUrl) {
        try {
          const expected = new URL(options.expectedUrl);
          const actual = new URL(item.url);
          if (expected.origin === actual.origin && expected.pathname === actual.pathname) {
            score += 60;
          }
        } catch (_error) {
        }
      }
      if (options.sourceUrl && item.referrer) {
        try {
          if (new URL(options.sourceUrl).origin === new URL(item.referrer).origin) {
            score += 30;
          }
        } catch (_error) {
        }
      }
      candidates.push({ item, score });
      const best = [...candidates].sort((left, right) => right.score - left.score);
      const minimumScore = options.expectedUrl ? 60 : 30;
      if (best[0].score >= minimumScore && (best.length === 1 || best[0].score > best[1].score)) {
        cleanup();
        resolve({ item: best[0].item, correlation: best[0], ambiguous: false });
      }
    };
    function cleanup() {
      finished = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(listener);
    }
    cancel = () => {
      if (!finished) {
        cleanup();
        resolve({ item: null, cancelled: true, candidates: [] });
      }
    };
    chrome.downloads.onCreated.addListener(listener);
  });
  promise.cancel = () => cancel?.();
  return promise;
}

function waitForDownloadComplete(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(async () => {
      if (finished) {
        return;
      }
      cleanup();
      const items = await chrome.downloads.search({ id: downloadId });
      resolve(items[0] || null);
    }, timeoutMs);
    const listener = async (delta) => {
      if (delta.id !== downloadId || !delta.state) {
        return;
      }
      if (delta.state.current === "complete" || delta.state.current === "interrupted") {
        cleanup();
        const items = await chrome.downloads.search({ id: downloadId });
        resolve(items[0] || null);
      }
    };
    function cleanup() {
      finished = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
    }
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items[0];
      if (!finished && item && (item.state === "complete" || item.state === "interrupted")) {
        cleanup();
        resolve(item);
      }
    }).catch(() => {});
  });
}

async function reconcileCreatedDownload(startedAt, options = {}) {
  const items = await chrome.downloads.search({
    orderBy: ["-startTime"],
    limit: 100
  });
  const candidates = items
    .filter((item) => {
      if (options.beforeIds?.has(item.id)) return false;
      const itemTime = item.startTime ? new Date(item.startTime).getTime() : 0;
      return itemTime + 1000 >= startedAt;
    })
    .map((item) => {
      let score = 0;
      if (options.expectedUrl && item.url === options.expectedUrl) {
        score += 100;
      } else if (options.expectedUrl) {
        try {
          const expected = new URL(options.expectedUrl);
          const actual = new URL(item.url);
          if (expected.origin === actual.origin && expected.pathname === actual.pathname) {
            score += 60;
          }
        } catch (_error) {
        }
      }
      if (options.sourceUrl && item.referrer) {
        try {
          if (new URL(options.sourceUrl).origin === new URL(item.referrer).origin) {
            score += 30;
          }
        } catch (_error) {
        }
      }
      return { item, score };
    })
    .filter((candidate) => candidate.score >= (options.expectedUrl ? 60 : 30))
    .sort((left, right) => right.score - left.score);
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0];
}

function waitForNewTab(sourceTab, beforeTabIds, timeoutMs) {
  let cancel = null;
  const promise = new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        cleanup();
        resolve({ tab: null, timedOut: true });
      }
    }, timeoutMs);
    const listener = (tab) => {
      if (finished || !TabWardSecurity.correlateCreatedTab(tab, sourceTab, beforeTabIds)) {
        return;
      }
      cleanup();
      resolve({ tab, timedOut: false });
    };
    function cleanup() {
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(listener);
    }
    cancel = () => {
      if (!finished) {
        cleanup();
        resolve({ tab: null, cancelled: true });
      }
    };
    chrome.tabs.onCreated.addListener(listener);
  });
  promise.cancel = () => cancel?.();
  return promise;
}

async function rememberCorrelatedChildTab(tab, sourceTab, session) {
  if (!tab?.id || !TabWardSecurity.correlateCreatedTab(tab, sourceTab, [])) {
    const error = new Error("New tab correlation changed before ownership could be recorded");
    error.name = "OwnershipError";
    throw error;
  }
  const current = (await getOwnership())[tab.id];
  if (current && current.kind !== "released") {
    if (current.sessionId !== session.id) {
      const error = new Error("Correlated new tab is already owned by another session");
      error.name = "OwnershipError";
      throw error;
    }
    return tab;
  }
  const workspaceWindow = await getLiveSessionWindow(session);
  let ownedTab = tab;
  if (workspaceWindow?.id !== undefined && tab.windowId !== workspaceWindow.id) {
    ownedTab = await chrome.tabs.move(tab.id, {
      windowId: workspaceWindow.id,
      index: -1
    });
  }
  await rememberTab(ownedTab, "created-child", session);
  return ownedTab;
}

function extensionForImage(candidate) {
  const mime = String(candidate.mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return "jpg";
  }
  if (mime.includes("png")) {
    return "png";
  }
  if (mime.includes("webp")) {
    return "webp";
  }
  if (mime.includes("gif")) {
    return "gif";
  }
  if (mime.includes("svg")) {
    return "svg";
  }
  const url = String(candidate.url || "");
  const match = url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return match ? match[1].toLowerCase() : "jpg";
}

function sanitizeDownloadFilename(filename, fallback) {
  const safe = String(filename || fallback || "tabward-image.jpg")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 160);
  return safe || fallback || "tabward-image.jpg";
}

function publicImageSummary(candidate) {
  const url = String(candidate.url || "");
  let source = url;
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const header = comma >= 0 ? url.slice(0, comma) : "data:";
    source = `${header},<${Math.max(url.length - comma - 1, 0)} chars>`;
  } else {
    source = sanitizeUrl(url);
  }
  return {
    index: candidate.index,
    count: candidate.count,
    sourceKind: candidate.sourceKind,
    source,
    mimeType: candidate.mimeType,
    selector: candidate.selector,
    id: candidate.id,
    tag: candidate.tag,
    rect: candidate.rect,
    alt: candidate.alt,
    titleAttr: candidate.titleAttr,
    naturalWidth: candidate.naturalWidth,
    naturalHeight: candidate.naturalHeight,
    parentHref: sanitizeUrl(candidate.parentHref),
    parentText: candidate.parentText
  };
}

async function commandPing() {
  return {
    ok: true,
    extensionId: chrome.runtime.id,
    time: new Date().toISOString()
  };
}

async function commandOpenTab(payload) {
  const session = await resolveSessionContext(payload);
  const requestedWorkspace = payload.workspace === "isolated" ? "isolated" : "current";
  const workspace = await getSessionWorkspace(session);
  const url = payload.url || "about:blank";
  let tab;
  let windowCreated = false;
  let workspaceWindowId;
  if (session.cleanQa === true) {
    let cleanState = await validateCleanQa(session);
    if (!cleanState || cleanState.status === "tainted") {
      const error = new Error(cleanState?.reason || "Clean QA state is unavailable");
      error.name = "CleanQaTainted";
      throw error;
    }
    if (cleanState.status === "ready") {
      const createdWindow = await chrome.windows.create({
        url,
        focused: false,
        type: "normal",
        incognito: true
      });
      tab = createdWindow.tabs?.[0];
      if (!tab?.id || createdWindow.id === undefined || createdWindow.incognito !== true) {
        throw new Error("Chrome did not return a Clean QA incognito window and tab");
      }
      workspaceWindowId = createdWindow.id;
      windowCreated = true;
      await rememberSessionWindow(session, createdWindow.id);
      await rememberTab(tab, "created", session);
      const states = await getCleanQaStates();
      cleanState = {
        ...states[session.id],
        status: "active",
        windowId: createdWindow.id,
        createdTabIds: [tab.id],
        updatedAt: new Date().toISOString()
      };
      states[session.id] = cleanState;
      await setCleanQaStates(states);
      cleanState = await validateCleanQa(session);
      if (cleanState?.status === "tainted") {
        await bestEffort(chrome.tabs.remove(tab.id), 5000, "close tainted Clean QA tab");
        await bestEffort(chrome.windows.remove(createdWindow.id), 5000, "close tainted Clean QA window");
        await forgetTab(tab.id);
        const error = new Error(cleanState.reason || "Clean QA became tainted while opening its workspace");
        error.name = "CleanQaTainted";
        throw error;
      }
    } else {
      workspaceWindowId = cleanState.windowId;
      tab = await chrome.tabs.create({
        url,
        active: Boolean(payload.active),
        windowId: cleanState.windowId
      });
      await rememberTab(tab, "created", session);
      const states = await getCleanQaStates();
      states[session.id] = {
        ...states[session.id],
        createdTabIds: Array.from(new Set([
          ...(states[session.id]?.createdTabIds || []),
          tab.id
        ])),
        updatedAt: new Date().toISOString()
      };
      await setCleanQaStates(states);
    }
  } else if (workspace === "isolated") {
    const existingWindow = await getLiveSessionWindow(session);
    if (existingWindow) {
      workspaceWindowId = existingWindow.id;
      tab = await chrome.tabs.create({
        url,
        active: Boolean(payload.active),
        windowId: existingWindow.id
      });
    } else {
      const createdWindow = await chrome.windows.create({
        url,
        focused: false,
        type: "normal"
      });
      tab = createdWindow.tabs?.[0];
      if (!tab?.id || createdWindow.id === undefined) {
        throw new Error("Chrome did not return the isolated workspace window and tab");
      }
      workspaceWindowId = createdWindow.id;
      windowCreated = true;
      await rememberSessionWindow(session, createdWindow.id);
      if (payload.active === false && tab.active !== false) {
        tab = await chrome.tabs.get(tab.id);
      }
    }
  } else {
    const windowId = payload.windowId !== undefined ? payload.windowId : await getActiveWindowId();
    const createInfo = {
      url,
      active: Boolean(payload.active)
    };
    if (windowId !== undefined) {
      createInfo.windowId = windowId;
    }
    tab = await chrome.tabs.create(createInfo);
    workspaceWindowId = tab.windowId;
  }
  if (session.cleanQa !== true) {
    await rememberTab(tab, "created", session);
  }
  let groupId = tab.groupId;
  let groupError = null;
  if (payload.group !== false && session.cleanQa !== true) {
    try {
      groupId = await withTimeout(
        putInWorkspace(
          tab.id,
          tab.windowId,
          payload.groupTitle || `TabWard: ${session.name}`.slice(0, 80),
          payload.collapsed === true,
          session
        ),
        payload.groupTimeoutMs || GROUP_OPERATION_TIMEOUT_MS,
        "tab grouping"
      );
    } catch (error) {
      groupError = toSafeError(error);
    }
  }
  await mutateOwnership((ownership) => {
    if (ownership[tab.id]) {
      ownership[tab.id] = { ...ownership[tab.id], groupId };
    }
    return ownership;
  });
  const loaded = payload.wait === false
    ? await chrome.tabs.get(tab.id)
    : await waitForTabComplete(tab.id, payload.timeoutMs || 30000, payload);
  if (payload.visual !== false) {
    const visualUpdate = (async () => {
      await markTabWorking(tab.id, payload, "Open", payload.cursor === false ? null : {
        x: 80,
        y: 80,
        label: "TabWard",
        pulse: true
      });
      await markTabIdle(tab.id, payload);
    })();
    if (payload.wait === false) {
      visualUpdate.catch(() => {});
    } else {
      await bestEffort(visualUpdate, 2500, "open visual state");
    }
  }
  return {
    tab: slimTab(loaded),
    groupId,
    groupError,
    workspace,
    requestedWorkspace,
    workspaceEnforcedBy: "extension_user_setting",
    workspaceWindowId,
    windowCreated,
    cleanQa: publicCleanQaState(
      session.cleanQa === true ? await validateCleanQa(session) : null
    )
  };
}

async function commandNavigate(payload) {
  return withWorkingTab(payload.tabId, payload, "Navigate", async () => {
    if (payload.cursor !== false) {
      await setAgentCursor(payload.tabId, {
        x: 90,
        y: 90,
        label: "Navigate",
        pulse: true
      });
    }
    const tab = await chrome.tabs.update(payload.tabId, { url: payload.url });
    const loaded = payload.wait === false
      ? tab
      : await waitForTabComplete(payload.tabId, payload.timeoutMs || 30000, payload);
    return { tab: slimTab(loaded) };
  });
}

async function commandNavigateAdvanced(payload) {
  return withWorkingTab(payload.tabId, payload, "Navigate", async () => {
    const waitUntil = String(payload.waitUntil || "load").toLowerCase();
    const timeoutMs = Math.max(100, Number(payload.timeoutMs || 30000));
    if (waitUntil === "networkidle") {
      await enableCdpEvents(payload.tabId, ["network", "navigation"]);
    }
    const tab = await chrome.tabs.update(payload.tabId, { url: payload.url });
    if (["none", "commit"].includes(waitUntil)) {
      return { ok: true, tab: slimTab(tab), waitUntil };
    }
    const loaded = await waitForTabComplete(payload.tabId, timeoutMs, payload);
    let networkIdle = null;
    if (waitUntil === "networkidle") {
      networkIdle = await waitForNetworkIdle(
        payload.tabId,
        timeoutMs,
        Number(payload.idleMs || 500),
        payload
      );
    }
    return { ok: true, tab: slimTab(loaded), waitUntil, networkIdle };
  });
}

async function commandHistory(payload, direction) {
  return withWorkingTab(payload.tabId, payload, direction === "back" ? "Back" : "Forward", async () => {
    const timeoutMs = Math.max(100, Number(payload.timeoutMs || 30000));
    const tab = direction === "back"
      ? await chrome.tabs.goBack(payload.tabId)
      : await chrome.tabs.goForward(payload.tabId);
    if (payload.wait === false) return { ok: true, tab: slimTab(tab), direction };
    return {
      ok: true,
      tab: slimTab(await waitForTabComplete(payload.tabId, timeoutMs, payload)),
      direction
    };
  });
}

async function commandTabs(payload) {
  const session = await resolveSessionContext(payload);
  const settings = await getUserSettings();
  const workspace = await getSessionWorkspace(session);
  const workspaceWindow = workspace === "isolated"
    ? await getLiveSessionWindow(session)
    : null;
  const knownTabsResult = await bestEffort(getKnownTabs(), 3000, "get known tabs for tabs");
  const activeTabsResult = await bestEffort(chrome.tabs.query({ active: true, lastFocusedWindow: true }), 3000, "get active tab");
  const sessionTabs = Array.isArray(knownTabsResult)
    ? knownTabsResult.filter((tab) =>
      tab.sessionId === session.id
      && (tab.ownership !== "adopted" || settings.allowExistingTabs)
    )
    : [];
  let canAccessExisting =
    settings.allowExistingTabs
    && payload.sessionMode === "full_profile"
    && payload.canAdoptExistingTabs === true;
  let availableTabs = [];
  if (canAccessExisting) {
    const ownership = await getOwnership();
    const allTabsResult = await bestEffort(chrome.tabs.query({}), 3000, "get available user tabs");
    if (Array.isArray(allTabsResult)) {
      availableTabs = allTabsResult
        .filter((tab) => {
          const url = String(tab.url || "");
          const record = ownership[tab.id];
          return /^(https?|file):/i.test(url)
            && (!record || record.kind === "released");
        })
        .map(slimTab);
    }
  }
  const activeTab = Array.isArray(activeTabsResult) ? activeTabsResult[0] : null;
  if (canAccessExisting && !(await getUserSettings()).allowExistingTabs) {
    canAccessExisting = false;
    availableTabs = [];
  }
  const activeOwnedBySession = activeTab
    ? sessionTabs.some((tab) => tab.id === activeTab.id)
    : false;
  return {
    activeTab: activeOwnedBySession || canAccessExisting ? slimTab(activeTab) : null,
    knownTabs: sessionTabs,
    availableTabs,
    existingTabAccess: canAccessExisting ? "allowed" : "denied",
    workspace,
    workspaceEnforcedBy: "extension_user_setting",
    workspaceWindowId: workspaceWindow?.id ?? null,
    cleanQa: publicCleanQaState(
      session.cleanQa === true ? await validateCleanQa(session) : null
    ),
    warnings: [
      ...(knownTabsResult && knownTabsResult.ok === false ? [knownTabsResult.error] : []),
      ...(activeTabsResult && activeTabsResult.ok === false ? [activeTabsResult.error] : [])
    ]
  };
}

async function commandGetText(payload) {
  return withWorkingTab(payload.tabId, payload, "Read text", async () => {
    if (payload.allFrames === true) {
      return sanitizeBrowserPayload(boundedFrameAggregate(
        await executeInAllFrames(payload.tabId, pageText, [payload.maxChars || MAX_TEXT_CHARS])
      ));
    }
    return sanitizeBrowserPayload(await executeInTab(payload.tabId, pageText, [payload.maxChars || MAX_TEXT_CHARS]));
  });
}

async function commandGetHtml(payload) {
  return withWorkingTab(payload.tabId, payload, "Read HTML", async () => sanitizeBrowserPayload(
    await executeInTab(payload.tabId, pageHtml, [payload.maxChars || MAX_TEXT_CHARS])
  ));
}

async function commandGetPageState(payload) {
  return withWorkingTab(payload.tabId, payload, "Page state", async () => sanitizeBrowserPayload(
    await executeInTab(payload.tabId, pageState, [], { frameId: payload.frameId })
  ));
}

async function commandExtractTables(payload) {
  return withWorkingTab(payload.tabId, payload, "Tables", async () => sanitizeBrowserPayload(
    await executeInTab(payload.tabId, pageExtractTables, [{
      limit: payload.limit,
      maxCellChars: payload.maxCellChars
    }], { frameId: payload.frameId })
  ));
}

async function commandObserve(payload) {
  return withWorkingTab(payload.tabId, payload, "Observe", async () => {
    const requestedInclude = new Set(Array.isArray(payload.include)
      ? payload.include
      : ["state", "interactive", "links", "forms"]);
    if (requestedInclude.has("text_only")) {
      requestedInclude.delete("text_only");
      requestedInclude.add("state");
      requestedInclude.add("text");
    }
    if (requestedInclude.has("interactive_only")) {
      requestedInclude.delete("interactive_only");
      requestedInclude.add("state");
      requestedInclude.add("interactive");
    }
    if (requestedInclude.has("links_only")) {
      requestedInclude.delete("links_only");
      requestedInclude.add("state");
      requestedInclude.add("links");
    }
    const options = {
      include: [...requestedInclude],
      limits: payload.limits,
      selector: payload.selector,
      maxChars: payload.maxChars,
      visibleOnly: payload.visibleOnly === true,
      imageMinWidth: payload.imageMinWidth,
      imageMinHeight: payload.imageMinHeight
    };
    if (payload.allFrames === true) {
      const frames = await executeInAllFrames(payload.tabId, pageObserve, [options]);
      const limit = Math.max(1, Math.min(Number(payload.maxFrames || 20), 100));
      return sanitizeBrowserPayload(boundedFrameAggregate(frames, limit));
    }
    return sanitizeBrowserPayload(
      await executeInTab(payload.tabId, pageObserve, [options], { frameId: payload.frameId })
    );
  });
}

async function commandSnapshot(payload) {
  return withWorkingTab(payload.tabId, payload, "Snapshot", async () => {
    if (payload.allFrames === true) {
      return sanitizeBrowserPayload(boundedFrameAggregate(
        await executeInAllFrames(payload.tabId, pageSnapshot, [payload.limit || 120])
      ));
    }
    return sanitizeBrowserPayload(await executeInTab(payload.tabId, pageSnapshot, [payload.limit || 120]));
  });
}

async function commandQuery(payload) {
  return withWorkingTab(payload.tabId, payload, "Query", async () => sanitizeBrowserPayload(
    await executeInTab(payload.tabId, pageQuery, [payload.selector, payload.limit || 50])
  ));
}

async function commandQueryRich(payload) {
  return withWorkingTab(payload.tabId, payload, "Query rich", async () => {
    const args = [
      payload.selector,
      {
        limit: payload.limit || 50,
        maxText: payload.maxText || 1000,
        visibleOnly: payload.visibleOnly === true,
        includeData: payload.includeData === true
      }
    ];
    if (payload.allFrames === true) {
      return sanitizeBrowserPayload(boundedFrameAggregate(
        await executeInAllFrames(payload.tabId, pageQueryRich, args)
      ));
    }
    return sanitizeBrowserPayload(await executeInTab(payload.tabId, pageQueryRich, args, { frameId: payload.frameId }));
  });
}

async function commandExtractImages(payload) {
  return withWorkingTab(payload.tabId, payload, "Images", async () => {
    const args = [{
    selector: payload.selector || "img,canvas,[style*='background-image']",
    limit: payload.limit || 50,
    includeData: payload.includeData === true,
    visibleOnly: payload.visibleOnly !== false,
    minWidth: payload.minWidth,
    minHeight: payload.minHeight
    }];
    if (payload.allFrames === true) {
      return sanitizeBrowserPayload(boundedFrameAggregate(
        await executeInAllFrames(payload.tabId, pageExtractImages, args)
      ));
    }
    return sanitizeBrowserPayload(await executeInTab(payload.tabId, pageExtractImages, args, { frameId: payload.frameId }));
  });
}

async function commandResolveTarget(payload) {
  return withWorkingTab(payload.tabId, payload, "Resolve target", async () => sanitizeBrowserPayload(
    await executeInTab(payload.tabId, pageResolveActionTarget, [payload], { frameId: payload.frameId })
  ));
}

async function commandClick(payload) {
  return withWorkingTab(payload.tabId, payload, "Click", async () => {
    const target = await executeInTab(payload.tabId, pageResolveActionTarget, [payload], { frameId: payload.frameId });
    if (!target || target.ok !== true) {
      return { ok: false, actionAccepted: false, target };
    }
    const actionPayload = { ...payload, ref: target.ref || payload.ref };
    const nestedFrame = Number.isInteger(Number(payload.frameId))
      && Number(payload.frameId) !== 0;
    if (payload.cursor !== false && !nestedFrame) {
      await setAgentCursor(payload.tabId, {
        x: target.x,
        y: target.y,
        label: "Click",
        pulse: true
      });
      await sleep(payload.cursorDelayMs || 200, commandSignal(payload));
    }
    const hasExplicitExpectation = Boolean(payload.expectUrlContains || payload.expectSelector || payload.expectText);
    const baseline = payload.requireOutcome === true
      ? await executeInTab(payload.tabId, pageCaptureActionBaseline, [actionPayload.ref, {
        urlContains: payload.expectUrlContains,
        selector: payload.expectSelector,
        text: payload.expectText
      }], { frameId: payload.frameId })
      : null;
    throwIfCommandAborted(payload);
    let native = true;
    let action;
    if (
      (payload.frameId !== undefined && payload.frameId !== null) ||
      target.recovered === true ||
      String(actionPayload.ref || "").includes(">>>")
    ) {
      native = false;
      action = await executeInTab(payload.tabId, pageFindAndClick, [actionPayload], { frameId: payload.frameId });
    } else try {
      await cdpSend(payload.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: target.x,
        y: target.y,
        timestamp: cdpTimestamp()
      });
      await cdpSend(payload.tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
        timestamp: cdpTimestamp()
      });
      await cdpSend(payload.tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        timestamp: cdpTimestamp()
      });
      action = { ok: true };
    } catch (error) {
      if (payload.domFallback !== true) {
        throw error;
      }
      native = false;
      action = await executeInTab(payload.tabId, pageFindAndClick, [actionPayload], { frameId: payload.frameId });
    }
    if (payload.waitAfterMs) {
      await sleep(payload.waitAfterMs, commandSignal(payload));
    }
    const tab = await chrome.tabs.get(payload.tabId);
    const verification = action?.ok !== true
      ? { ok: false, kind: "action" }
      : baseline && !hasExplicitExpectation
        ? await verifyAutomaticActionOutcome(payload.tabId, payload, baseline, actionPayload.ref)
        : await verifyActionOutcome(payload.tabId, payload, baseline);
    const verified = action?.ok === true && verification.ok === true;
    return {
      ok: verified,
      actionAccepted: action?.ok === true,
      verified,
      verification,
      cursorSuppressed: nestedFrame && payload.cursor !== false,
      native,
      target,
      click: action,
      tab: slimTab(tab)
    };
  });
}

async function commandFill(payload) {
  return withWorkingTab(payload.tabId, payload, "Fill", async () => {
    const target = await executeInTab(payload.tabId, pageResolveActionTarget, [payload], { frameId: payload.frameId });
    if (!target || target.ok !== true) {
      return { ok: false, actionAccepted: false, target };
    }
    const actionPayload = { ...payload, ref: target.ref || payload.ref || payload.selector };
    const nestedFrame = Number.isInteger(Number(payload.frameId))
      && Number(payload.frameId) !== 0;
    if (payload.cursor !== false && !nestedFrame) {
      await setAgentCursor(payload.tabId, {
        x: target.x,
        y: target.y,
        label: "Fill",
        pulse: true
      });
      await sleep(payload.cursorDelayMs || 150, commandSignal(payload));
    }
    throwIfCommandAborted(payload);
    let native = true;
    let action;
    if (
      (payload.frameId !== undefined && payload.frameId !== null) ||
      target.recovered === true ||
      String(actionPayload.ref || "").includes(">>>")
    ) {
      native = false;
      action = await executeInTab(payload.tabId, pageFill, [actionPayload], { frameId: payload.frameId });
    } else try {
      await cdpSend(payload.tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
        timestamp: cdpTimestamp()
      });
      await cdpSend(payload.tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
        timestamp: cdpTimestamp()
      });
      await cdpSend(payload.tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
        timestamp: cdpTimestamp()
      });
      await cdpSend(payload.tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
        timestamp: cdpTimestamp()
      });
      await cdpSend(payload.tabId, "Input.insertText", { text: String(payload.value || "") });
      action = { ok: true };
    } catch (error) {
      if (payload.domFallback !== true) {
        throw error;
      }
      native = false;
      action = await executeInTab(payload.tabId, pageFill, [actionPayload], { frameId: payload.frameId });
    }
    const verification = await executeInTab(
      payload.tabId,
      pageVerifyFillValue,
      [actionPayload.ref, String(payload.value || "")],
      { frameId: payload.frameId }
    );
    return {
      ok: action?.ok === true && verification?.ok === true,
      actionAccepted: action?.ok === true,
      verified: verification?.ok === true,
      native,
      cursorSuppressed: nestedFrame && payload.cursor !== false,
      target,
      valueLength: String(payload.value || "").length,
      verification
    };
  });
}

async function commandSmartClick(payload) {
  return commandClick({
    ...payload,
    allowRecovery: payload.allowRecovery !== false,
    requireOutcome: true,
    verifyTimeoutMs: payload.verifyTimeoutMs || 3000,
    waitAfterMs: payload.waitAfterMs ?? 0
  });
}

async function commandSmartFill(payload) {
  return commandFill({
    ...payload,
    allowRecovery: payload.allowRecovery !== false
  });
}

async function locatorSnapshot(tabId, locator, frameId) {
  const targetFrameId = frameId ?? locator?.frameId;
  return sanitizeBrowserPayload(await executeInTab(
    tabId,
    pageLocatorSnapshot,
    [locator || {}],
    {
      frameId: targetFrameId,
      documentId: locator?.executionDocumentId
    }
  ));
}

async function resolveLocator(tabId, locator, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 30000));
  const deadline = Date.now() + timeoutMs;
  const includeHidden = options.includeHidden === true;
  const actionableLocator = {
    ...(locator || {}),
    visible: includeHidden ? false : true,
    enabledOnly: true,
    actionable: !includeHidden
  };
  let latest = null;
  while (Date.now() <= deadline) {
    throwIfCommandAborted(options);
    latest = await locatorSnapshot(
      tabId,
      actionableLocator,
      options.frameId ?? locator?.frameId
    );
    let target = latest?.target;
    const identityMismatch = target && (
      locator?.documentId && target.documentId !== locator.documentId
      || locator?.fingerprint && target.fingerprint !== locator.fingerprint
    );
    if (identityMismatch && options.allowRecovery === true) {
      const recovered = await executeInTab(tabId, pageResolveActionTarget, [{
        locator,
        allowRecovery: true,
        minLocatorScore: options.minLocatorScore,
        includeHidden
      }], { frameId: options.frameId });
      if (recovered?.ok === true && recovered.ref) {
        latest = await locatorSnapshot(tabId, {
          ref: recovered.ref,
          index: 0,
          strict: false
        }, options.frameId ?? locator?.frameId);
        target = latest?.target;
      }
    }
    if (identityMismatch && options.allowRecovery !== true) {
      const error = new Error("Locator handle is stale: document or DOM fingerprint changed");
      error.name = "StaleLocatorError";
      error.latest = latest;
      throw error;
    }
    const strict = locator?.strict !== false && locator?.index === undefined;
    if (latest?.count === 0 && options.preflight !== false) {
      const error = new Error(`Locator matched 0 ${includeHidden ? "" : "visible "}elements`);
      error.name = "LocatorError";
      error.candidateCount = 0;
      throw error;
    }
    if (latest?.count > 1 && strict) {
      const error = new Error(`Strict locator matched ${latest.count} ${includeHidden ? "" : "visible "}elements`);
      error.name = "StrictModeError";
      error.candidates = latest.matches;
      throw error;
    }
    const strictMatch = !strict || latest.count <= 1;
    const stateMatch = target
      && (includeHidden || options.visible === false || target.visible)
      && (options.enabled === false || target.enabled)
      && (options.editable !== true || target.editable)
      && (options.receivesEvents === false || target.receivesEvents);
    if (!stateMatch && target && options.preflight !== false) {
      const reason = !target.enabled
        ? "element is disabled"
        : options.editable === true && !target.editable
          ? "element is not editable"
          : options.receivesEvents !== false && !target.receivesEvents
            ? "element does not receive pointer events"
            : "element is not visible";
      const error = new Error(`Locator preflight rejected target: ${reason}`);
      error.name = "ActionPreflightError";
      error.candidateCount = latest.count;
      error.target = target;
      throw error;
    }
    if (stateMatch && strictMatch) {
      if (options.stable !== false) {
        await sleep(Math.min(100, Math.max(20, timeoutMs)), commandSignal(options));
        const followup = await locatorSnapshot(
          tabId,
          actionableLocator,
          options.frameId ?? locator?.frameId
        );
        const next = followup?.target;
        if (!next || JSON.stringify(next.rect) !== JSON.stringify(target.rect)) {
          latest = followup;
          await sleep(50, commandSignal(options));
          continue;
        }
      }
      return target;
    }
    if (Date.now() >= deadline) break;
    await sleep(100, commandSignal(options));
  }
  const error = new Error(`Locator did not become actionable within ${timeoutMs}ms`);
  error.name = "TimeoutError";
  error.locator = locator;
  error.latest = latest;
  throw error;
}

async function dispatchClick(tabId, target, options = {}) {
  const button = options.button || "left";
  const clickCount = Math.max(1, Number(options.clickCount || (options.doubleClick ? 2 : 1)));
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "none",
    timestamp: cdpTimestamp()
  });
  for (let count = 1; count <= clickCount; count += 1) {
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button,
      clickCount: count,
      modifiers: Number(options.modifiers || 0),
      timestamp: cdpTimestamp()
    });
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button,
      clickCount: count,
      modifiers: Number(options.modifiers || 0),
      timestamp: cdpTimestamp()
    });
  }
}

async function dispatchKey(tabId, value, options = {}) {
  const key = typeof value === "string" ? value : value?.key || "";
  const text = typeof value === "object" ? value?.text : null;
  const known = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 }
  };
  if (text !== null || (key.length === 1 && !options.modifiers)) {
    await cdpSend(tabId, "Input.insertText", { text: text ?? key });
    return;
  }
  const params = { ...(known[key] || { key, code: key }), modifiers: Number(options.modifiers || 0) };
  await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...params, timestamp: cdpTimestamp() });
  await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params, timestamp: cdpTimestamp() });
}

async function cdpSetInputFiles(
  tabId,
  ref,
  files,
  context = null,
  frameId = undefined,
  expectedDocumentId = undefined,
  uploadAuthorization = null
) {
  throwIfCommandAborted(context);
  const marker = `tabward-upload-${crypto.randomUUID()}`;
  const marked = await executeInTab(
    tabId,
    (segments, markerValue) => {
      let root = document;
      let element = null;
      for (const selector of segments) {
        element = root.querySelector(selector);
        if (!element) return { ok: false };
        root = element.shadowRoot || root;
      }
      if (!(element instanceof HTMLInputElement) || element.type !== "file") {
        return { ok: false };
      }
      element.setAttribute("data-tabward-upload-target", markerValue);
      return { ok: true };
    },
    [String(ref || "").split(/\s*>>>\s*/).filter(Boolean), marker],
    { frameId, documentId: expectedDocumentId }
  );
  if (!marked?.ok) {
    throw new Error("Could not resolve file input in the requested frame");
  }
  let effectAttempted = false;
  try {
    await cdpSend(tabId, "DOM.enable", {}, 5000);
    const document = await cdpSend(tabId, "DOM.getFlattenedDocument", {
      depth: -1,
      pierce: true
    }, 10000);
    const node = (document.nodes || []).find((candidate) => {
      const attributes = candidate.attributes || [];
      for (let index = 0; index < attributes.length; index += 2) {
        if (attributes[index] === "data-tabward-upload-target"
          && attributes[index + 1] === marker) {
          return true;
        }
      }
      return false;
    });
    if (!node?.backendNodeId) {
      throw new Error("Could not map the requested frame file input to CDP");
    }
    await revalidateUploadAuthorization(uploadAuthorization);
    throwIfCommandAborted(context);
    effectAttempted = true;
    await cdpSend(tabId, "DOM.setFileInputFiles", {
      backendNodeId: node.backendNodeId,
      files
    }, 10000);
    return {
      ok: true,
      retried: false,
      frameId: marked.frameId,
      documentId: marked.executionDocumentId
    };
  } catch (error) {
    if (effectAttempted) {
      const unknown = new Error(
        "File input command was dispatched but completion was not confirmed"
      );
      unknown.name = "OutcomeUnknown";
      unknown.details = {
        outcome: "effect_unknown",
        effectPossible: true,
        retrySafe: false,
        reason: "upload dispatch failed after effect boundary"
      };
      throw unknown;
    }
    throw error;
  } finally {
    await bestEffort(executeInTab(
      tabId,
      (markerValue) => {
        document
          .querySelector(`[data-tabward-upload-target="${CSS.escape(markerValue)}"]`)
          ?.removeAttribute("data-tabward-upload-target");
      },
      [marker],
      { frameId }
    ), 2000, "remove upload target marker");
  }
}

async function frameDocumentIdentity(tabId, frameId, documentId) {
  const identity = await executeInTab(
    tabId,
    () => ({ href: location.href, origin: location.origin }),
    [],
    { frameId, documentId }
  );
  if (
    !identity
    || typeof identity.executionDocumentId !== "string"
    || !identity.executionDocumentId
    || typeof identity.origin !== "string"
    || !identity.origin
  ) {
    const error = new Error("Target frame identity is unavailable");
    error.name = "ApprovalMismatch";
    throw error;
  }
  return {
    tabId,
    frameId: Number(identity.frameId ?? frameId ?? 0),
    documentId: identity.executionDocumentId,
    url: String(identity.href || ""),
    origin: identity.origin
  };
}

async function revalidateUploadAuthorization(authorization) {
  if (!authorization) {
    const error = new Error("Upload authorization is required at the effect boundary");
    error.name = "ApprovalMismatch";
    throw error;
  }
  const currentIdentity = await frameDocumentIdentity(
    authorization.tabId,
    authorization.frameId,
    authorization.documentId
  );
  const currentSite = TabWardSecurity.classifyUploadUrl(
    currentIdentity.url,
    (await getUserSettings()).trustedUploadSites
  );
  if (
    currentIdentity.documentId !== authorization.documentId
    || currentIdentity.origin !== authorization.origin
    || currentSite.host !== authorization.host
    || (authorization.trustedPattern && !currentSite.trusted)
  ) {
    const error = new Error("Upload authorization was invalidated by target-frame navigation or settings");
    error.name = "ApprovalMismatch";
    throw error;
  }
  TabWardSecurity.assertEffectAuthorizationFresh(authorization.expiresAt);
  return currentIdentity;
}

async function authorizeUpload(payload, files, frameId, documentId) {
  const identity = await frameDocumentIdentity(
    payload.tabId,
    frameId,
    documentId
  );
  const settings = await getUserSettings();
  const site = TabWardSecurity.classifyUploadUrl(
    identity.url,
    settings.trustedUploadSites
  );
  const context = commandContext(payload);
  const authorization = {
    approved: true,
    tabId: payload.tabId,
    frameId: identity.frameId,
    documentId: identity.documentId,
    origin: identity.origin,
    host: site.host,
    trustedPattern: site.trustedPattern,
    expiresAt: context.deadlineAt
  };
  if (site.trusted) return authorization;
  const fileFingerprint = await TabWardSecurity.sha256(
    files.map((file) => String(file))
  );
  const binding = {
    approvalId: crypto.randomUUID(),
    kind: "upload",
    operationId: context.operationId,
    fingerprint: context.fingerprint,
    deadlineAt: context.deadlineAt,
    sessionId: context.session?.id || null,
    tabId: payload.tabId,
    documentId: identity.documentId,
    origin: identity.origin,
    host: site.host,
    method: null,
    paramsFingerprint: null,
    fileFingerprint,
    workerInstanceId: WORKER_INSTANCE_ID,
    expiresAt: Math.min(Date.now() + APPROVAL_TTL_MS, context.deadlineAt)
  };
  const created = await createPendingApproval(binding, {
    riskCategory: "local-file-upload",
    riskText: "This site is not trusted for automatic local file uploads.",
    origin: site.origin,
    basenames: files.map((file) => String(file).split(/[\\/]/).pop()).filter(Boolean)
  });
  await consumeApproval({ ...binding, expiresAt: created.expiresAt }, payload);
  return {
    ...authorization,
    trustedPattern: null,
    decision: "approve_once",
    expiresAt: created.expiresAt
  };
}

async function commandLocatorAction(payload) {
  return runOwnedTabOperation(payload.tabId, payload, `Action: ${payload.action}`, async () => {
    const options = payload.options || {};
    const frameId = options.frameId ?? payload.locator?.frameId;
    const action = String(payload.action || "");
    const target = await resolveLocator(payload.tabId, payload.locator, {
      timeoutMs: payload.timeoutMs,
      frameId,
      editable: ["fill", "type"].includes(action),
      receivesEvents: !["focus", "blur", "select", "upload"].includes(action),
      includeHidden: action === "upload",
      allowRecovery: options.allowRecovery === true,
      minLocatorScore: options.minLocatorScore,
      stable: options.stable !== false,
      [OPERATION_CONTEXT]: commandContext(payload)
    });
    const elementKind = String(target.tag || "").toLowerCase();
    if (["check", "uncheck"].includes(action) && !(elementKind === "input" && target.type === "checkbox")) {
      throw new Error(`${action} requires an input[type=checkbox] target`);
    }
    if (action === "select" && elementKind !== "select") {
      throw new Error("select requires a <select> target");
    }
    if (action === "upload" && !(elementKind === "input" && target.type === "file")) {
      throw new Error("upload requires an input[type=file] target");
    }
    if (action === "drag" && !options.targetLocator) {
      throw new Error("drag requires options.targetLocator");
    }
    if (options.trial === true) {
      return { ok: true, trial: true, target };
    }
    let native = true;
    let fallbackUsed = false;
    const nestedFrame = Number.isInteger(Number(frameId)) && Number(frameId) !== 0;
    if (payload.cursor !== false && !nestedFrame) {
      await setAgentCursor(payload.tabId, {
        x: target.x,
        y: target.y,
        label: action,
        pulse: true
      });
    }
    if (action === "click" || action === "doubleClick") {
      if (nestedFrame) {
        const frameClick = await executeInTab(
          payload.tabId,
          pageFindAndClick,
          [{ ref: target.ref, index: 1, doubleClick: action === "doubleClick" }],
          { frameId, documentId: target.executionDocumentId }
        );
        if (!frameClick?.ok) {
          throw new Error(frameClick?.error || "Frame click was not accepted");
        }
        native = false;
        fallbackUsed = true;
      } else {
      const probe = await executeInTab(
        payload.tabId,
        pageInstallClickProbe,
        [target.ref],
        { frameId }
      );
      await dispatchClick(payload.tabId, target, { ...options, doubleClick: action === "doubleClick" });
      await sleep(50, commandSignal(payload));
      const fired = probe
        ? await executeInTab(payload.tabId, pageReadClickProbe, [probe], { frameId })
        : false;
      if (!fired && options.domFallback !== false) {
        const fallback = await executeInTab(
          payload.tabId,
          pageFindAndClick,
          [{ ref: target.ref, index: 1 }],
          { frameId }
        );
        if (!fallback?.ok) {
          throw new Error(fallback?.error || "Click was not accepted");
        }
        native = false;
        fallbackUsed = true;
      }
      }
    } else if (action === "hover") {
      if (nestedFrame) {
        const error = new Error("Native hover in a nested frame requires verified top-viewport coordinates");
        error.name = "FrameCoordinateError";
        throw error;
      }
      await cdpSend(payload.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: target.x,
        y: target.y,
        button: "none",
        timestamp: cdpTimestamp()
      });
    } else if (action === "fill") {
      if (nestedFrame) {
        const frameFill = await executeInTab(payload.tabId, pageFill, [{
          ref: target.ref,
          value: String(payload.value ?? "")
        }], { frameId, documentId: target.executionDocumentId });
        if (!frameFill?.ok) {
          throw new Error(frameFill?.error || "Frame fill was not accepted");
        }
        native = false;
        fallbackUsed = true;
      } else {
      await dispatchClick(payload.tabId, target, options);
      await cdpSend(payload.tabId, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65
      });
      await cdpSend(payload.tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65
      });
      await cdpSend(payload.tabId, "Input.insertText", { text: String(payload.value ?? "") });
      await sleep(50, commandSignal(payload));
      const filled = await locatorSnapshot(payload.tabId, payload.locator, frameId);
      if (String(filled?.target?.value ?? "") !== String(payload.value ?? "") && options.domFallback !== false) {
        const fallback = await executeInTab(payload.tabId, pageFill, [{
          ref: target.ref,
          value: String(payload.value ?? "")
        }], { frameId });
        if (!fallback?.ok) {
          throw new Error(fallback?.error || "Fill was not accepted");
        }
        native = false;
        fallbackUsed = true;
      }
      }
    } else if (action === "type") {
      if (nestedFrame) {
        const frameType = await executeInTab(payload.tabId, pageFill, [{
          ref: target.ref,
          value: `${String(target.value ?? "")}${String(payload.value ?? "")}`
        }], { frameId, documentId: target.executionDocumentId });
        if (!frameType?.ok) {
          throw new Error(frameType?.error || "Frame type was not accepted");
        }
        native = false;
        fallbackUsed = true;
      } else {
      await dispatchClick(payload.tabId, target, options);
      const delayMs = Math.max(0, Number(options.delayMs || 0));
      for (const character of String(payload.value ?? "")) {
        await cdpSend(payload.tabId, "Input.insertText", { text: character });
        if (delayMs) await sleep(delayMs, commandSignal(payload));
      }
      }
    } else if (action === "press") {
      if (nestedFrame) {
        const error = new Error("Native key dispatch in a nested frame is not safely targetable");
        error.name = "FrameCoordinateError";
        throw error;
      }
      await dispatchClick(payload.tabId, target, options);
      await dispatchKey(payload.tabId, payload.value, options);
    } else if (action === "check" || action === "uncheck") {
      const desired = action === "check";
      const desiredState = desired ? "true" : "false";
      if (target.checkedState !== desiredState) {
        if (nestedFrame) {
          const frameCheck = await executeInTab(payload.tabId, pageLocatorDomAction, [{
            ref: target.ref,
            action
          }], { frameId, documentId: target.executionDocumentId });
          if (!frameCheck?.ok) {
            throw new Error(frameCheck?.error || `${action} was not accepted`);
          }
          native = false;
          fallbackUsed = true;
        } else {
          await dispatchClick(payload.tabId, target, options);
        }
      }
      await sleep(50, commandSignal(payload));
      let checked = await locatorSnapshot(payload.tabId, payload.locator, frameId);
      if (checked?.target?.checkedState !== desiredState && options.domFallback !== false) {
        const fallback = await executeInTab(payload.tabId, pageLocatorDomAction, [{
          ref: target.ref,
          action
        }], { frameId });
        if (!fallback?.ok) {
          throw new Error(fallback?.error || `${action} was not accepted`);
        }
        native = false;
        fallbackUsed = true;
        checked = await locatorSnapshot(payload.tabId, payload.locator, frameId);
      }
      if (checked?.target?.checkedState !== desiredState) {
        throw new Error(`${action} did not reach the requested checkbox state`);
      }
    } else if (["select", "focus", "blur"].includes(action)) {
      const result = await executeInTab(payload.tabId, pageLocatorDomAction, [{
        ref: target.ref,
        action,
        value: payload.value
      }], { frameId });
      if (!result?.ok) {
        return result;
      }
    } else if (action === "drag") {
      const destination = await resolveLocator(payload.tabId, options.targetLocator, {
        timeoutMs: payload.timeoutMs,
        frameId: options.targetFrameId,
        receivesEvents: true,
        [OPERATION_CONTEXT]: commandContext(payload)
      });
      if (Number(target.frameId || 0) !== 0 || Number(destination.frameId || 0) !== 0) {
        const error = new Error(
          "Native drag across nested frames requires verified top-viewport coordinates"
        );
        error.name = "FrameCoordinateError";
        throw error;
      }
      const dragData = {
        items: [{
          mimeType: "text/plain",
          data: String(options.dragData ?? target.text ?? "")
        }],
        dragOperationsMask: 1
      };
      await cdpSend(payload.tabId, "Input.dispatchDragEvent", {
        type: "dragEnter", x: destination.x, y: destination.y, data: dragData
      });
      await cdpSend(payload.tabId, "Input.dispatchDragEvent", {
        type: "dragOver", x: destination.x, y: destination.y, data: dragData
      });
      await cdpSend(payload.tabId, "Input.dispatchDragEvent", {
        type: "drop", x: destination.x, y: destination.y, data: dragData
      });
      return { ok: true, action, source: target, destination };
    } else if (action === "upload") {
      const files = Array.isArray(payload.value) ? payload.value.map(String) : [String(payload.value || "")];
      const networkOrDevice = (file) =>
        /^(?:\\\\|\/\/|\\\\[?.]\\|\\\?\?\\)/.test(file)
        || /^\/dev\//.test(file);
      const localAbsolute = (file) =>
        /^[a-zA-Z]:[\\/](?![\\/])/.test(file)
        || /^\/(?!\/)/.test(file);
      if (
        !files.every(localAbsolute)
        || files.some(networkOrDevice)
      ) {
        throw new Error(
          "Upload paths must be absolute local files, not UNC, device, or network paths"
        );
      }
      const uploadAuthorization = await authorizeUpload(
        payload,
        files,
        frameId ?? target.frameId,
        target.executionDocumentId
      );
      const upload = await cdpSetInputFiles(
        payload.tabId,
        target.ref,
        files,
        payload,
        frameId ?? target.frameId,
        target.executionDocumentId,
        uploadAuthorization
      );
      fallbackUsed = upload.retried;
    } else {
      throw new Error(`Unsupported locator action: ${action}`);
    }
    if (options.waitAfterMs) {
      await sleep(Number(options.waitAfterMs), commandSignal(payload));
    }
    const verification = await locatorSnapshot(payload.tabId, payload.locator, frameId);
    return {
      ok: true,
      action,
      target,
      verification,
      native,
      fallbackUsed,
      cursorSuppressed: nestedFrame && payload.cursor !== false,
      trace: [
        { step: "found", count: target.candidateCount },
        { step: "scrolled", value: target.scrolled === true },
        { step: "clicked", value: ["click", "doubleClick"].includes(action) },
        { step: "next_action", value: options.nextAction || null }
      ]
    };
  }, payload.visual !== false);
}

async function commandForm(payload) {
  const results = [];
  for (const [index, field] of (payload.fields || []).entries()) {
    const startedAt = Date.now();
    try {
      const result = await commandLocatorAction(scopedPayload(payload, {
        tabId: payload.tabId,
        action: field.action,
        locator: field.locator,
        value: field.value,
        options: field.options || {},
        timeoutMs: payload.timeoutMs,
        cursor: false,
        visual: false
      }));
      results.push({
        index, action: field.action, ok: result?.ok !== false,
        elapsedMs: Date.now() - startedAt,
        target: result?.target ? {
          tag: result.target.tag, role: result.target.role,
          name: result.target.name, ref: result.target.ref
        } : null
      });
      if (result?.ok === false) return { ok: false, stoppedAt: index, fields: results };
    } catch (error) {
      results.push({ index, action: field.action, ok: false, error: toSafeError(error) });
      return { ok: false, stoppedAt: index, fields: results };
    }
  }
  let submitted = false;
  if (payload.submitLocator) {
    await commandLocatorAction(scopedPayload(payload, {
      tabId: payload.tabId,
      action: "click",
      locator: payload.submitLocator,
      options: {},
      timeoutMs: payload.timeoutMs,
      cursor: false,
      visual: false
    }));
    submitted = true;
  }
  return { ok: true, fields: results, submitted };
}

async function commandLocatorWait(payload) {
  const timeoutMs = Math.max(0, Number(payload.timeoutMs || 30000));
  if (payload.state === "networkidle") {
    return waitForNetworkIdle(
      payload.tabId,
      timeoutMs,
      Number(payload.idleMs || 500),
      payload
    );
  }
  if (["load", "domcontentloaded"].includes(payload.state)) {
    const tab = await waitForTabComplete(payload.tabId, timeoutMs, payload);
    return { ok: true, tab: slimTab(tab), state: payload.state };
  }
  const deadline = Date.now() + timeoutMs;
  let snapshot = null;
  while (Date.now() <= deadline) {
    throwIfCommandAborted(payload);
    if (payload.url !== undefined || payload.state === "url") {
      const tab = await chrome.tabs.get(payload.tabId);
      const actual = String(tab.url || "");
      if (payload.url ? actual.includes(payload.url) : Boolean(actual)) {
        return { ok: true, state: "url", actual };
      }
    } else {
      snapshot = await locatorSnapshot(payload.tabId, payload.locator, payload.frameId);
      const state = payload.state || "visible";
      if (TabWardStageOne.locatorWaitMatches(state, snapshot, payload.text)) {
        return { ok: true, state, snapshot };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(100, commandSignal(payload));
  }
  const error = new Error(`Wait condition was not met within ${timeoutMs}ms`);
  error.name = "TimeoutError";
  throw error;
}

async function commandLocatorAssert(payload) {
  const timeoutMs = Math.max(0, Number(payload.timeoutMs || 10000));
  const deadline = Date.now() + timeoutMs;
  let actual = null;
  while (Date.now() <= deadline) {
    throwIfCommandAborted(payload);
    const assertion = String(payload.assertion || "");
    if (assertion === "url" || assertion === "title") {
      const tab = await chrome.tabs.get(payload.tabId);
      actual = assertion === "url" ? tab.url : tab.title;
    } else {
      const snapshot = await locatorSnapshot(payload.tabId, payload.locator, payload.frameId);
      const target = snapshot?.target;
      actual = {
        count: snapshot?.count || 0,
        text: target?.text || target?.name || "",
        value: target?.value,
        visible: Boolean(target?.visible),
        enabled: Boolean(target?.enabled),
        editable: Boolean(target?.editable),
        checked: target?.checkedState === "true",
        checkedState: target?.checkedState ?? null
      };
    }
    const expected = payload.expected;
    let passed = false;
    if (assertion === "url" || assertion === "title") {
      passed = expected instanceof Object && expected.contains !== undefined
        ? String(actual || "").includes(String(expected.contains))
        : String(actual ?? "") === String(expected ?? "");
    } else if (assertion === "text") {
      passed = expected instanceof Object && expected.contains !== undefined
        ? actual.text.includes(String(expected.contains))
        : actual.text === String(expected ?? "");
    } else if (assertion === "value") {
      passed = String(actual.value ?? "") === String(expected ?? "");
    } else if (assertion === "count") {
      passed = actual.count === Number(expected);
    } else if (assertion === "checked") {
      passed = actual.checkedState === ((expected === undefined || Boolean(expected)) ? "true" : "false");
    } else if (["visible", "enabled", "editable"].includes(assertion)) {
      passed = actual[assertion] === (expected === undefined ? true : Boolean(expected));
    } else if (assertion === "hidden") {
      passed = actual.visible === false;
    } else {
      return { ok: true, passed: false, assertion, actual, expected, error: `Unsupported assertion: ${assertion}` };
    }
    if (passed) {
      return { ok: true, passed: true, assertion, actual, expected };
    }
    if (Date.now() >= deadline) break;
    await sleep(100, commandSignal(payload));
  }
  return {
    ok: true,
    passed: false,
    assertion: payload.assertion,
    actual,
    expected: payload.expected,
    error: `Assertion failed after ${timeoutMs}ms`
  };
}

async function commandDownloadClick(payload) {
  const session = await resolveSessionContext(payload);
  return withWorkingTab(payload.tabId, payload, "Download", async () => {
    const startedAt = Date.now();
    const timeoutMs = Math.max(100, Math.min(Number(payload.timeoutMs || 30000), 600000));
    const [beforeDownloads, sourceTab, beforeTabs] = await Promise.all([
      chrome.downloads.search({}),
      chrome.tabs.get(payload.tabId),
      chrome.tabs.query({})
    ]);
    const target = await executeInTab(payload.tabId, pageResolveActionTarget, [payload], { frameId: payload.frameId });
    if (!target || target.ok !== true) {
      return { ok: false, actionAccepted: false, target };
    }
    const reservationId = await reserveDownloadOwnership(session.id);
    let downloadPromise;
    let newTabPromise;
    try {
      downloadPromise = waitForDownloadCreated(startedAt, timeoutMs, {
        beforeIds: new Set(beforeDownloads.map((item) => item.id)),
        expectedUrl: target.href,
        sourceUrl: sourceTab.url
      });
      newTabPromise = waitForNewTab(
        sourceTab,
        beforeTabs.map((tab) => tab.id).filter(Number.isInteger),
        timeoutMs
      );
    } catch (error) {
      await rollbackDownloadOwnership(reservationId, session.id);
      throw error;
    }
    let action;
    try {
      action = await commandClick(scopedPayload(payload, { ...payload, waitAfterMs: 0 }));
    } catch (error) {
      downloadPromise.cancel?.();
      newTabPromise.cancel?.();
      throw downloadOutcomeUnknown(
        "post_click_error",
        "Download click outcome is unknown; observe downloads before deciding whether to retry",
        error
      );
    }
    if (action.actionAccepted !== true) {
      downloadPromise.cancel?.();
      newTabPromise.cancel?.();
      await rollbackDownloadOwnership(reservationId, session.id);
      return {
        ok: false,
        kind: "no_effect",
        actionAccepted: false,
        verified: false,
        click: action,
        diagnostic: "click was not accepted by the resolved target"
      };
    }
    const signal = await Promise.race([downloadPromise, newTabPromise]);
    if (signal?.item) {
      newTabPromise.cancel?.();
      try {
        await fulfillDownloadOwnership(reservationId, signal.item.id, session.id);
      } catch (error) {
        throw downloadOutcomeUnknown(
          "post_download_commit",
          "A download started but its ownership reservation could not be committed",
          error
        );
      }
      const remainingMs = Math.max(100, timeoutMs - (Date.now() - startedAt));
      const completed = await waitForDownloadComplete(signal.item.id, remainingMs);
      const download = completed || signal.item;
      return {
        ok: download.state === "complete",
        kind: "download_started",
        actionAccepted: true,
        verified: download.state === "complete",
        downloadId: download.id,
        filename: download.filename?.split(/[\\/]/).pop() || "",
        mime: download.mime || "",
        size: download.fileSize ?? download.totalBytes ?? 0,
        status: download.state,
        click: action,
        trace: [
          { step: "found", count: target.candidateCount },
          { step: "scrolled", value: target.scrolled === true },
          { step: "clicked", value: true },
          { step: "download_started", value: true },
          { step: "next_action", value: payload.nextAction || null }
        ],
        download: slimDownload(download),
        correlation: {
          ambiguous: signal.ambiguous === true,
          score: signal.correlation?.score,
          candidates: signal.candidates
        }
      };
    }
    if (signal?.tab) {
      downloadPromise.cancel?.();
      await rollbackDownloadOwnership(reservationId, session.id);
      const ownedTab = await rememberCorrelatedChildTab(
        signal.tab,
        sourceTab,
        session
      );
      return {
        ok: false,
        kind: "new_tab",
        actionAccepted: true,
        verified: false,
        newTab: slimTab(ownedTab),
        click: action,
        trace: [
          { step: "found", count: target.candidateCount },
          { step: "scrolled", value: target.scrolled === true },
          { step: "clicked", value: true },
          { step: "new_tab", value: true },
          { step: "next_action", value: payload.nextAction || null }
        ],
        diagnostic: "click opened a new tab instead of creating a download"
      };
    }
    if (signal?.timedOut) {
      const reconciled = await reconcileCreatedDownload(startedAt, {
        beforeIds: new Set(beforeDownloads.map((item) => item.id)),
        expectedUrl: target.href,
        sourceUrl: sourceTab.url
      });
      if (reconciled?.item) {
        try {
          await fulfillDownloadOwnership(reservationId, reconciled.item.id, session.id);
        } catch (error) {
          throw downloadOutcomeUnknown(
            "post_download_commit",
            "A reconciled download could not be committed to its ownership reservation",
            error
          );
        }
        const completed = await waitForDownloadComplete(reconciled.item.id, 5000);
        const download = completed || reconciled.item;
        return {
          ok: download.state === "complete",
          kind: "download_started",
          actionAccepted: true,
          verified: download.state === "complete",
          downloadId: download.id,
          filename: download.filename?.split(/[\\/]/).pop() || "",
          mime: download.mime || "",
          size: download.fileSize ?? download.totalBytes ?? 0,
          status: download.state,
          click: action,
          download: slimDownload(download),
          correlation: {
            reconciled: true,
            score: reconciled.score
          }
        };
      }
      const newTab = await newTabPromise;
      if (newTab?.tab) {
        await rollbackDownloadOwnership(reservationId, session.id);
        const ownedTab = await rememberCorrelatedChildTab(
          newTab.tab,
          sourceTab,
          session
        );
        return {
          ok: false,
          kind: "new_tab",
          actionAccepted: true,
          verified: false,
          newTab: slimTab(ownedTab),
          click: action
        };
      }
    }
    throw downloadOutcomeUnknown(
      "post_click_timeout",
      "Download click was accepted but no download or new tab was confirmed before timeout"
    );
  });
}

async function commandDownloadImage(payload) {
  const session = await resolveSessionContext(payload);
  return withWorkingTab(payload.tabId, payload, "Download image", async () => {
    const candidate = await executeInTab(payload.tabId, pageResolveImageForDownload, [{
      selector: payload.selector || "img,canvas,[style*='background-image']",
      index: payload.index || 1,
      visibleOnly: payload.visibleOnly !== false,
      minWidth: payload.minWidth,
      minHeight: payload.minHeight,
      mimeType: payload.mimeType
    }]);
    if (!candidate || candidate.ok === false) {
      throw new Error(candidate && candidate.error ? candidate.error : "Image not found");
    }
    if (payload.cursor !== false && candidate.rect) {
      await setAgentCursor(payload.tabId, {
        x: Math.round(candidate.rect.x + candidate.rect.width / 2),
        y: Math.round(candidate.rect.y + candidate.rect.height / 2),
        label: "Download",
        pulse: true
      });
      await sleep(payload.cursorDelayMs || 300, commandSignal(payload));
    }
    throwIfCommandAborted(payload);
    const extension = extensionForImage(candidate);
    const fallback = `tabward-image-${candidate.index || payload.index || 1}.${extension}`;
    const filename = sanitizeDownloadFilename(payload.filename, fallback);
    const reservationId = await reserveDownloadOwnership(session.id);
    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url: candidate.url,
        filename,
        saveAs: payload.saveAs === true,
        conflictAction: payload.conflictAction || "uniquify"
      });
    } catch (error) {
      await rollbackDownloadOwnership(reservationId, session.id);
      throw error;
    }
    try {
      await fulfillDownloadOwnership(reservationId, downloadId, session.id);
    } catch (error) {
      throw downloadOutcomeUnknown(
        "post_download_commit",
        "Image download started but its ownership reservation could not be committed",
        error
      );
    }
    const download = await waitForDownloadComplete(downloadId, payload.timeoutMs || 30000);
    return {
      ok: download?.state === "complete",
      image: publicImageSummary(candidate),
      downloadId,
      filename,
      download: slimDownload(download)
    };
  });
}

async function commandDownloads(payload) {
  const session = await resolveSessionContext(payload);
  const knownIds = await getKnownDownloadIds(session.id);
  const items = (await Promise.all([...knownIds].map((id) => chrome.downloads.search({ id })))).flat();
  items.sort((left, right) => String(right.startTime || "").localeCompare(String(left.startTime || "")));
  return {
    downloads: items
      .filter((item) => knownIds.has(item.id))
      .slice(0, payload.limit || 20)
      .map((item) => slimDownload(item, payload.includeSensitive === true))
  };
}

async function commandDeleteDownload(payload) {
  const session = await resolveSessionContext(payload);
  const knownIds = await getKnownDownloadIds(session.id);
  if (!knownIds.has(payload.downloadId)) {
    const error = new Error(`Download ${payload.downloadId} is not owned by the active TabWard session`);
    error.name = "OwnershipError";
    throw error;
  }
  await chrome.downloads.removeFile(payload.downloadId);
  if (payload.erase !== false) {
    await chrome.downloads.erase({ id: payload.downloadId });
  }
  await forgetDownload(payload.downloadId, session.id);
  return { ok: true, deleted: payload.downloadId, erased: payload.erase !== false };
}

async function commandCloseTab(payload) {
  await assertTabOwnership(payload.tabId, { context: payload, createdOnly: true });
  await bestEffort(finishTabWork(payload.tabId, payload), 2500, "finish before close");
  await withTimeout(chrome.tabs.remove(payload.tabId), 5000, "close tab");
  await forgetTab(payload.tabId);
  return { closed: payload.tabId };
}

async function commandActivateTab(payload) {
  const tab = await chrome.tabs.update(payload.tabId, { active: true });
  if (payload.focusWindow !== false && tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { tab: slimTab(await chrome.tabs.get(payload.tabId)) };
}

async function commandCursor(payload) {
  if (payload.visible === false) {
    return hideAgentCursor(payload.tabId);
  }
  return setAgentCursor(payload.tabId, {
    x: payload.x,
    y: payload.y,
    label: payload.label || "TabWard",
    pulse: payload.pulse === true
  });
}

async function commandFinish(payload) {
  const tabId = payload.tabId;
  if (tabId === undefined || tabId === null) {
    throw new Error("tabId is required");
  }
  return finishTabWork(tabId, payload);
}

async function commandCleanup(payload) {
  const session = await resolveSessionContext(payload);
  const knownTabs = await getKnownTabs();
  const ownership = await getOwnership();
  const cleaned = [];
  const closed = [];
  for (const tab of knownTabs) {
    if (!tab || tab.id === undefined) {
      continue;
    }
    if (ownership[tab.id]?.sessionId !== session.id) {
      continue;
    }
    await bestEffort(finishTabWork(tab.id, payload), 2500, "finish tab during cleanup");
    cleaned.push(tab.id);
    if (payload.closeCreatedTabs === true && ["created", "created-child"].includes(ownership[tab.id]?.kind)) {
      await bestEffort(chrome.tabs.remove(tab.id), 5000, "close tab during cleanup");
      await forgetTab(tab.id);
      closed.push(tab.id);
    }
  }
  await bestEffort(updateWorkspaceVisual(), 2500, "update workspace during cleanup");
  const cdp = await bestEffort(
    cdpDetachSession(session.id),
    3000,
    "session CDP detach during cleanup"
  );
  return { cleaned, closed, cdp };
}

async function commandReloadExtension(payload) {
  const delayMs = Math.max(Number.isFinite(payload.delayMs) ? payload.delayMs : 750, 750);
  reloadScheduled = true;
  setTimeout(() => {
    chrome.runtime.reload();
  }, Math.max(delayMs, 0));
  return { scheduled: true, delayMs };
}

async function commandReload(payload) {
  return withWorkingTab(payload.tabId, payload, "Reload", async () => {
    await chrome.tabs.reload(payload.tabId);
    const tab = await waitForTabComplete(
      payload.tabId,
      payload.timeoutMs || 30000,
      payload
    );
    return { tab: slimTab(tab) };
  });
}

async function commandWaitForText(payload) {
  return withWorkingTab(
    payload.tabId,
    payload,
    "Wait text",
    () => waitForText(payload.tabId, payload.text, payload.timeoutMs || 30000, payload)
  );
}

async function commandWaitForSelector(payload) {
  return withWorkingTab(payload.tabId, payload, "Wait selector", async () => sanitizeBrowserPayload(await waitForSelector(
    payload.tabId,
    payload.selector,
    payload.timeoutMs || 30000,
    payload.visible === true,
    payload
  )));
}

// ---------------------------------------------------------------------------
// CDP command handlers
// ---------------------------------------------------------------------------

async function commandAttach(payload) {
  await cdpAttach(payload.tabId);
  return { ok: true, tabId: payload.tabId, attached: true };
}

async function commandDetach(payload) {
  await cdpDetach(payload.tabId);
  cdpEventBrokers.delete(payload.tabId);
  return { ok: true, tabId: payload.tabId, attached: false };
}

async function requireCdpApproval(payload, classification) {
  const context = commandContext(payload);
  const identity = await tabDocumentIdentity(payload.tabId);
  const paramsFingerprint = await TabWardSecurity.sha256(payload.params || {});
  const binding = {
    approvalId: crypto.randomUUID(),
    kind: "cdp",
    operationId: context.operationId,
    fingerprint: context.fingerprint,
    deadlineAt: context.deadlineAt,
    sessionId: context.session?.id || null,
    tabId: payload.tabId,
    documentId: identity.documentId,
    origin: identity.origin,
    host: null,
    method: String(payload.method),
    paramsFingerprint,
    fileFingerprint: null,
    workerInstanceId: WORKER_INSTANCE_ID,
    expiresAt: Math.min(Date.now() + APPROVAL_TTL_MS, context.deadlineAt)
  };
  const created = await createPendingApproval(binding, {
    riskCategory: classification.category,
    riskText: classification.riskText,
    origin: identity.origin || sanitizeUrl(identity.url),
    basenames: []
  });
  await consumeApproval({ ...binding, expiresAt: created.expiresAt }, payload);
  const current = await tabDocumentIdentity(payload.tabId);
  if (current.documentId !== identity.documentId || current.origin !== identity.origin) {
    const error = new Error("CDP approval was invalidated by navigation");
    error.name = "ApprovalMismatch";
    throw error;
  }
  return {
    expiresAt: created.expiresAt
  };
}

async function commandExecuteCdp(payload) {
  const classification = TabWardSecurity.classifyCdp(
    payload.method,
    payload.params || {}
  );
  const approval = classification.approvalRequired
    ? await requireCdpApproval(payload, classification)
    : null;
  throwIfCommandAborted(payload);
  if (approval) {
    TabWardSecurity.assertEffectAuthorizationFresh(approval.expiresAt);
  }
  const result = await cdpSend(payload.tabId, payload.method, payload.params || {});
  return {
    ok: true,
    method: payload.method,
    policy: classification.category,
    result: sanitizeBrowserPayload(result)
  };
}

async function commandCdp(payload) {
  assertExpertCdpResourceSafe(payload);
  return commandExecuteCdp(scopedPayload(payload, { ...payload, privileged: true }));
}

async function commandEventsStart(payload) {
  const categories = Array.from(new Set(payload.categories || ["console", "network", "dialog", "navigation"]));
  const claim = claimCdpResource(payload, "events");
  let broker;
  try {
    broker = await enableCdpEvents(payload.tabId, categories);
  } catch (error) {
    if (claim.created) releaseCdpResource(payload, "events");
    throw error;
  }
  return {
    ok: true,
    tabId: payload.tabId,
    categories: Array.from(broker.categories),
    cursor: broker.sequence
  };
}

async function commandEventsPoll(payload) {
  const broker = cdpBroker(payload.tabId);
  const cursor = Math.max(0, Number(payload.cursor || 0));
  const categories = new Set(payload.categories || []);
  const limit = Math.max(1, Math.min(1000, Number(payload.limit || 200)));
  const available = broker.events.filter(
    (event) => event.sequence > cursor && (categories.size === 0 || categories.has(event.category))
  );
  const events = available.slice(0, limit);
  return {
    ok: true,
    events,
    cursor: events.length ? events[events.length - 1].sequence : cursor,
    latestCursor: broker.sequence,
    hasMore: available.length > events.length,
    dropped: broker.events.length > 0 && cursor > 0 && cursor < broker.events[0].sequence - 1,
    truncated: broker.eventsTruncated,
    droppedCount: broker.eventsDropped,
    retainedBytes: broker.eventBytes,
    partial: broker.eventsTruncated,
    complete: !broker.eventsTruncated
  };
}

async function commandEventsClear(payload) {
  const broker = cdpBroker(payload.tabId);
  broker.events = [];
  broker.eventBytes = 0;
  broker.eventsTruncated = false;
  broker.eventsDropped = 0;
  return { ok: true, cursor: broker.sequence };
}

async function commandEventsStop(payload) {
  const transition = transitionCdpResource(payload, "events", "stopping");
  if (!transition.owner) {
    return { ok: true, tabId: payload.tabId, alreadyStopped: true };
  }
  const broker = cdpBroker(payload.tabId);
  broker.categories.clear();
  broker.started = false;
  releaseCdpResource(payload, "events");
  return { ok: true, tabId: payload.tabId };
}

async function commandDialogHandle(payload) {
  const action = String(payload.action || "accept").toLowerCase();
  await cdpSend(payload.tabId, "Page.handleJavaScriptDialog", {
    accept: action !== "dismiss",
    promptText: payload.promptText
  });
  return { ok: true, action };
}

async function commandNetworkBody(payload) {
  if (!payload.requestId) {
    throw new Error("requestId is required");
  }
  const result = await cdpSend(payload.tabId, "Network.getResponseBody", {
    requestId: payload.requestId
  });
  const bounded = TabWardStageTwo.boundedNetworkBody(
    payload.requestId,
    TabWardSecurity.redactNetworkBody(result.body, result.base64Encoded === true),
    false,
    NETWORK_BODY_RESULT_MAX_BYTES
  );
  return {
    ...bounded,
    redacted: bounded.body !== String(result.body || "")
  };
}

async function commandNetworkHar(payload) {
  const broker = cdpBroker(payload.tabId);
  const records = new Map();
  for (const event of broker.events.filter((item) => item.category === "network")) {
    const requestId = event.params?.requestId;
    if (!requestId) continue;
    const record = records.get(requestId) || {
      requestId,
      startedDateTime: new Date(event.timestamp).toISOString(),
      time: 0,
      request: {},
      response: {},
      timings: {}
    };
    if (event.method === "Network.requestWillBeSent") {
      record.startedDateTime = new Date(event.timestamp).toISOString();
      record._startedAt = event.timestamp;
      record.request = {
        method: event.params.request?.method,
        url: event.params.request?.url,
        headers: event.params.request?.headers || {},
        postData: event.params.request?.hasPostData ? "[AVAILABLE THROUGH CDP]" : undefined
      };
    } else if (event.method === "Network.responseReceived") {
      record.response = {
        status: event.params.response?.status,
        statusText: event.params.response?.statusText,
        mimeType: event.params.response?.mimeType,
        headers: event.params.response?.headers || {},
        protocol: event.params.response?.protocol,
        fromDiskCache: event.params.response?.fromDiskCache === true,
        fromServiceWorker: event.params.response?.fromServiceWorker === true
      };
    } else if (event.method === "Network.loadingFinished") {
      record.time = Math.max(0, event.timestamp - (record._startedAt || event.timestamp));
      record.response.bodySize = event.params.encodedDataLength;
    } else if (event.method === "Network.loadingFailed") {
      record.time = Math.max(0, event.timestamp - (record._startedAt || event.timestamp));
      record.response.errorText = event.params.errorText;
    }
    records.set(requestId, record);
  }
  const entries = Array.from(records.values()).map((record) => {
    delete record._startedAt;
    return sanitizeBrowserPayload(record);
  });
  return {
    ok: true,
    log: {
      version: "1.2",
      creator: { name: "TabWard", version: "0.4.0" },
      pages: [],
      entries
    }
  };
}

async function commandInterceptionStart(payload) {
  const claim = claimCdpResource(payload, "interception");
  let broker;
  try {
    broker = await enableCdpEvents(payload.tabId, ["network"]);
    await cdpSend(payload.tabId, "Fetch.enable", {
      patterns: payload.patterns?.length ? payload.patterns : [{ urlPattern: "*" }],
      handleAuthRequests: payload.handleAuthRequests === true
    });
  } catch (error) {
    if (claim.created) releaseCdpResource(payload, "interception");
    throw error;
  }
  broker.interception = true;
  return { ok: true, patterns: payload.patterns || [{ urlPattern: "*" }] };
}

async function commandInterceptionContinue(payload) {
  if (!payload.requestId) throw new Error("requestId is required");
  await cdpSend(payload.tabId, "Fetch.continueRequest", {
    requestId: payload.requestId,
    url: payload.url,
    method: payload.method,
    postData: payload.postData,
    headers: payload.headers
  });
  return { ok: true, requestId: payload.requestId };
}

async function commandInterceptionFail(payload) {
  if (!payload.requestId) throw new Error("requestId is required");
  await cdpSend(payload.tabId, "Fetch.failRequest", {
    requestId: payload.requestId,
    errorReason: payload.errorReason || "Failed"
  });
  return { ok: true, requestId: payload.requestId };
}

function utf8Base64(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function commandInterceptionFulfill(payload) {
  if (!payload.requestId) throw new Error("requestId is required");
  await cdpSend(payload.tabId, "Fetch.fulfillRequest", {
    requestId: payload.requestId,
    responseCode: Number(payload.responseCode || 200),
    responseHeaders: payload.responseHeaders || [],
    body: payload.bodyBase64 || utf8Base64(payload.body || "")
  });
  return { ok: true, requestId: payload.requestId };
}

async function commandInterceptionStop(payload) {
  const transition = transitionCdpResource(payload, "interception", "stopping");
  if (!transition.owner) return { ok: true, alreadyStopped: true };
  await cdpSend(payload.tabId, "Fetch.disable", {});
  const broker = cdpBroker(payload.tabId);
  broker.interception = false;
  releaseCdpResource(payload, "interception");
  return { ok: true };
}

function pageViewportState() {
  return {
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    deviceScaleFactor: globalThis.devicePixelRatio
  };
}

async function commandEmulation(payload) {
  const settings = { ...(payload.settings || {}) };
  const presets = {
    desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
    mobile: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, maxTouchPoints: 5 },
    tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true, maxTouchPoints: 5 }
  };
  if (settings.preset && presets[settings.preset]) {
    settings.viewport = presets[settings.preset];
  }
  if (settings.clear === true) {
    const transition = transitionCdpResource(payload, "emulation", "stopping");
    const cleanup = {
      metrics: await bestEffort(cdpSend(payload.tabId, "Emulation.clearDeviceMetricsOverride", {}), 3000, "clear metrics"),
      touch: await bestEffort(cdpSend(payload.tabId, "Emulation.setTouchEmulationEnabled", { enabled: false }), 3000, "clear touch"),
      geolocation: await bestEffort(cdpSend(payload.tabId, "Emulation.clearGeolocationOverride", {}), 3000, "clear geolocation"),
      media: await bestEffort(cdpSend(payload.tabId, "Emulation.setEmulatedMedia", { media: "", features: [] }), 3000, "clear media"),
      timezone: await bestEffort(cdpSend(payload.tabId, "Emulation.setTimezoneOverride", { timezoneId: "" }), 3000, "clear timezone"),
      locale: await bestEffort(cdpSend(payload.tabId, "Emulation.setLocaleOverride", { locale: "" }), 3000, "clear locale"),
      network: await bestEffort(cdpSend(payload.tabId, "Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1
      }), 3000, "clear network")
    };
    const failures = Object.entries(cleanup)
      .filter(([, result]) => result?.ok === false)
      .map(([operation, result]) => ({ operation, error: result.error }));
    if (failures.length === 0) {
      await setEmulationState(payload.tabId, null);
      if (transition.owner) releaseCdpResource(payload, "emulation");
    }
    return { ok: failures.length === 0, cleared: true, cleanup, failures };
  }
  claimCdpResource(payload, "emulation");
  const applied = [];
  if (settings.viewport) {
    const viewport = settings.viewport;
    const requestedWidth = Math.max(0, Number(viewport.width || 1280));
    const requestedHeight = Math.max(0, Number(viewport.height || 720));
    const requestedDeviceScaleFactor = Math.max(0, Number(viewport.deviceScaleFactor || 1));
    const metrics = {
      width: requestedWidth,
      height: requestedHeight,
      deviceScaleFactor: requestedDeviceScaleFactor,
      mobile: viewport.mobile === true,
      screenOrientation: viewport.screenOrientation
    };
    let observed = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await cdpSend(payload.tabId, "Emulation.setDeviceMetricsOverride", metrics);
      await cdpSend(payload.tabId, "Emulation.setTouchEmulationEnabled", {
        enabled: viewport.touch === true,
        maxTouchPoints: viewport.touch === true
          ? Number(viewport.maxTouchPoints || 1)
          : 1
      });
      await sleep(50, commandSignal(payload));
      observed = await executeInTab(payload.tabId, pageViewportState);
      const sizeMatched = Math.abs(Number(observed?.width || 0) - requestedWidth) <= VIEWPORT_TOLERANCE_PX
        && Math.abs(Number(observed?.height || 0) - requestedHeight) <= VIEWPORT_TOLERANCE_PX;
      const scaleMatched = requestedDeviceScaleFactor === 0
        || Math.abs(Number(observed?.deviceScaleFactor || 0) - requestedDeviceScaleFactor) < 0.01;
      if (sizeMatched && scaleMatched) {
        break;
      }
      if (attempt < 2) {
        if (Number(observed?.width) > 0) {
          metrics.width = Math.max(
            1,
            Math.round(metrics.width * requestedWidth / Number(observed.width))
          );
        }
        if (Number(observed?.height) > 0) {
          metrics.height = Math.max(
            1,
            Math.round(metrics.height * requestedHeight / Number(observed.height))
          );
        }
        if (Number(observed?.deviceScaleFactor) > 0 && requestedDeviceScaleFactor > 0) {
          metrics.deviceScaleFactor *= requestedDeviceScaleFactor
            / Number(observed.deviceScaleFactor);
        }
      }
    }
    const sizeMatched = Math.abs(Number(observed?.width || 0) - requestedWidth) <= VIEWPORT_TOLERANCE_PX
      && Math.abs(Number(observed?.height || 0) - requestedHeight) <= VIEWPORT_TOLERANCE_PX;
    const scaleMatched = requestedDeviceScaleFactor === 0
      || Math.abs(Number(observed?.deviceScaleFactor || 0) - requestedDeviceScaleFactor) < 0.01;
    if (!sizeMatched || !scaleMatched) {
      await bestEffort(
        cdpSend(payload.tabId, "Emulation.clearDeviceMetricsOverride", {}),
        3000,
        "rollback unstable viewport emulation"
      );
      await bestEffort(
        cdpSend(payload.tabId, "Emulation.setTouchEmulationEnabled", { enabled: false }),
        3000,
        "rollback unstable touch emulation"
      );
      const error = new Error(
        `Viewport emulation did not stabilize at ${requestedWidth}x${requestedHeight}@${requestedDeviceScaleFactor}; observed ${observed?.width}x${observed?.height}@${observed?.deviceScaleFactor}`
      );
      error.name = "EmulationVerificationError";
      throw error;
    }
    applied.push("viewport");
  }
  if (settings.geolocation) {
    await cdpSend(payload.tabId, "Emulation.setGeolocationOverride", settings.geolocation);
    applied.push("geolocation");
  }
  if (settings.timezone) {
    await cdpSend(payload.tabId, "Emulation.setTimezoneOverride", { timezoneId: settings.timezone });
    applied.push("timezone");
  }
  if (settings.locale) {
    await cdpSend(payload.tabId, "Emulation.setLocaleOverride", { locale: settings.locale });
    applied.push("locale");
  }
  if (settings.userAgent) {
    await cdpSend(payload.tabId, "Emulation.setUserAgentOverride", {
      userAgent: settings.userAgent,
      acceptLanguage: settings.acceptLanguage,
      platform: settings.platform,
      userAgentMetadata: settings.userAgentMetadata
    });
    applied.push("userAgent");
  }
  if (settings.media || settings.colorScheme || settings.reducedMotion) {
    const features = [];
    if (settings.colorScheme) features.push({ name: "prefers-color-scheme", value: settings.colorScheme });
    if (settings.reducedMotion) features.push({ name: "prefers-reduced-motion", value: settings.reducedMotion });
    await cdpSend(payload.tabId, "Emulation.setEmulatedMedia", {
      media: settings.media || "",
      features
    });
    applied.push("media");
  }
  if (settings.offline !== undefined) {
    await cdpSend(payload.tabId, "Network.enable", {});
    await cdpSend(payload.tabId, "Network.emulateNetworkConditions", {
      offline: settings.offline === true,
      latency: Number(settings.latency || 0),
      downloadThroughput: Number(settings.downloadThroughput ?? -1),
      uploadThroughput: Number(settings.uploadThroughput ?? -1),
      connectionType: settings.connectionType
    });
    applied.push("network");
  }
  const previous = (await getEmulationStates())[payload.tabId] || {};
  await setEmulationState(payload.tabId, {
    ...previous,
    ...settings,
    viewport: settings.viewport
      ? { ...(previous.viewport || {}), ...settings.viewport }
      : previous.viewport
  });
  return { ok: true, applied };
}

async function commandStorage(payload) {
  const operation = String(payload.operation || "snapshot");
  let data = payload.data || {};
  const tab = await chrome.tabs.get(payload.tabId);
  if (operation === "restore" && data.snapshotId) {
    const saved = storageSnapshots.get(data.snapshotId);
    if (!saved) throw new Error("Unknown or expired storage snapshot");
    data = saved;
  }
  const webOperation = operation === "snapshot" ? "get" : operation;
  const webStorage = await executeInTab(payload.tabId, pageStorageOperation, [{ operation: webOperation, data }]);
  if (webStorage?.ok === false) {
    return webStorage;
  }
  if (operation === "snapshot") {
    await cdpSend(payload.tabId, "Network.enable", {});
    const cookies = await cdpSend(payload.tabId, "Network.getCookies", { urls: [tab.url] });
    const snapshotId = crypto.randomUUID();
    storageSnapshots.set(snapshotId, {
      localStorage: sanitizeBrowserPayload(webStorage.localStorage || {}),
      sessionStorage: sanitizeBrowserPayload(webStorage.sessionStorage || {}),
      cookies: [],
      cookieValuesRetained: false,
      cookieCount: (cookies.cookies || []).length
    });
    while (storageSnapshots.size > 20) {
      storageSnapshots.delete(storageSnapshots.keys().next().value);
    }
    return {
      ok: true,
      snapshotId,
      origin: webStorage.origin,
      localStorageCount: Object.keys(webStorage.localStorage || {}).length,
      sessionStorageCount: Object.keys(webStorage.sessionStorage || {}).length,
      cookieCount: (cookies.cookies || []).length
    };
  }
  if (operation === "get") {
    await cdpSend(payload.tabId, "Network.enable", {});
    const cookies = await cdpSend(payload.tabId, "Network.getCookies", { urls: [tab.url] });
    return sanitizeBrowserPayload({
      ok: true,
      ...webStorage,
      cookies: (cookies.cookies || []).map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expires: cookie.expires
      }))
    });
  }
  if (operation === "clear") {
    const current = await cdpSend(payload.tabId, "Network.getCookies", { urls: [tab.url] });
    for (const cookie of current.cookies || []) {
      await cdpSend(payload.tabId, "Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path
      });
    }
    return { ok: true, ...webStorage, cookiesCleared: (current.cookies || []).length };
  }
  if (["set", "restore"].includes(operation) && Array.isArray(data.cookies)) {
    if (operation === "restore" && data.cookieValuesRetained !== false) {
      const current = await cdpSend(payload.tabId, "Network.getCookies", { urls: [tab.url] });
      for (const cookie of current.cookies || []) {
        await cdpSend(payload.tabId, "Network.deleteCookies", {
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path
        });
      }
    }
    if (data.cookies.length && data.cookieValuesRetained !== false) {
      await cdpSend(payload.tabId, "Network.setCookies", { cookies: data.cookies });
    }
    return sanitizeBrowserPayload({
      ok: true,
      ...webStorage,
      cookiesSet: data.cookieValuesRetained === false ? 0 : data.cookies.length,
      cookiesRestored: data.cookieValuesRetained !== false
    });
  }
  return sanitizeBrowserPayload({ ok: true, ...webStorage });
}

async function commandTraceStart(payload) {
  const claim = claimCdpResource(payload, "tracing");
  const broker = cdpBroker(payload.tabId);
  broker.traceEvents = [];
  broker.traceBytes = 0;
  broker.traceTruncated = false;
  broker.traceDropped = 0;
  broker.traceComplete = false;
  try {
    await cdpSend(payload.tabId, "Tracing.start", {
      categories: payload.categories || "-*,devtools.timeline,v8.execute,blink.user_timing,loading",
      options: payload.options || "record-as-much-as-possible",
      transferMode: "ReportEvents"
    });
  } catch (error) {
    if (claim.created) releaseCdpResource(payload, "tracing");
    throw error;
  }
  return { ok: true, started: true };
}

async function commandTraceStop(payload) {
  const broker = cdpBroker(payload.tabId);
  const transition = transitionCdpResource(payload, "tracing", "stopping");
  if (!transition.owner && !broker.traceComplete) {
    const error = new Error("Tracing is not owned by this session");
    error.name = "CdpResourceNotOwned";
    throw error;
  }
  if (transition.previousState === "active") {
    await cdpSend(payload.tabId, "Tracing.end", {});
  }
  const timeoutMs = Math.max(1000, Number(payload.timeoutMs || 30000));
  const deadline = Date.now() + timeoutMs;
  while (!broker.traceComplete && Date.now() < deadline) {
    throwIfCommandAborted(payload);
    await sleep(50, commandSignal(payload));
  }
  if (!broker.traceComplete) {
    const error = new Error(`Trace did not complete within ${timeoutMs}ms`);
    error.name = "TimeoutError";
    throw error;
  }
  const traceEvents = broker.traceEvents;
  const truncated = broker.traceTruncated;
  const droppedCount = broker.traceDropped;
  const retainedBytes = broker.traceBytes;
  broker.traceEvents = [];
  broker.traceBytes = 0;
  broker.traceTruncated = false;
  broker.traceDropped = 0;
  TabWardStageThree.completeStoppingResource(
    broker.resourceOwners,
    "tracing"
  );
  return {
    ok: !truncated,
    traceEvents,
    eventCount: traceEvents.length,
    truncated,
    partial: truncated,
    droppedCount,
    retainedBytes,
    complete: !truncated
  };
}

async function commandScreencastStart(payload) {
  const claim = claimCdpResource(payload, "screencast");
  const broker = cdpBroker(payload.tabId);
  broker.screencastFrames = [];
  broker.screencastBytes = 0;
  broker.screencastTruncated = false;
  broker.screencastDropped = 0;
  try {
    await cdpSend(payload.tabId, "Page.startScreencast", {
      format: payload.format || "jpeg",
      quality: Number(payload.quality || 80),
      maxWidth: payload.maxWidth,
      maxHeight: payload.maxHeight,
      everyNthFrame: Number(payload.everyNthFrame || 1)
    });
  } catch (error) {
    if (claim.created) releaseCdpResource(payload, "screencast");
    throw error;
  }
  return { ok: true, started: true };
}

async function commandScreencastFrame(payload) {
  const broker = cdpBroker(payload.tabId);
  const timeoutMs = Math.max(100, Number(payload.timeoutMs || 10000));
  const deadline = Date.now() + timeoutMs;
  while (broker.screencastFrames.length === 0 && Date.now() < deadline) {
    throwIfCommandAborted(payload);
    await sleep(50, commandSignal(payload));
  }
  const frame = broker.screencastFrames.pop();
  if (!frame) {
    const error = new Error(`No screencast frame received within ${timeoutMs}ms`);
    error.name = "TimeoutError";
    throw error;
  }
  return {
    ok: !broker.screencastTruncated,
    ...frame,
    truncated: broker.screencastTruncated,
    partial: broker.screencastTruncated,
    droppedCount: broker.screencastDropped,
    retainedBytes: broker.screencastBytes,
    complete: !broker.screencastTruncated
  };
}

async function commandScreencastStop(payload) {
  const transition = transitionCdpResource(payload, "screencast", "stopping");
  if (!transition.owner) return { ok: true, stopped: true, alreadyStopped: true };
  await cdpSend(payload.tabId, "Page.stopScreencast", {});
  const broker = cdpBroker(payload.tabId);
  broker.screencastFrames = [];
  broker.screencastBytes = 0;
  broker.screencastTruncated = false;
  broker.screencastDropped = 0;
  releaseCdpResource(payload, "screencast");
  return { ok: true, stopped: true };
}

async function commandScreenshot(payload) {
  const format = payload.format || "png";
  const quality = Math.max(0, Math.min(100, Math.round(Number(payload.quality ?? 80))));
  let fullPageSize = null;
  let clipped = false;
  const params = {
    format
  };
  if (format !== "png") {
    params.quality = quality;
  }
  if (payload.scope === "element") {
    const target = await resolveLocator(payload.tabId, payload.locator, {
      timeoutMs: payload.timeoutMs || 30000,
      receivesEvents: false,
      frameId: payload.frameId
    });
    if (Number(target.frameId || 0) !== 0) {
      const error = new Error(
        "Nested-frame element screenshots require a verified frame-to-top coordinate chain"
      );
      error.name = "FrameCoordinateError";
      throw error;
    }
    const metrics = await cdpSend(payload.tabId, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
    const scaleProbe = await cdpSend(payload.tabId, "Runtime.evaluate", {
      expression: "({ deviceScaleFactor: window.devicePixelRatio, pageScaleFactor: window.visualViewport?.scale || 1 })",
      returnByValue: true,
      awaitPromise: false
    });
    const topRect = TabWardStageTwo.topViewportRect(
      target.rect,
      [],
      scaleProbe.result?.value || {}
    );
    params.clip = {
      x: Math.max(0, Number(viewport.pageX || 0) + topRect.x),
      y: Math.max(0, Number(viewport.pageY || 0) + topRect.y),
      width: Math.max(1, topRect.width),
      height: Math.max(1, topRect.height),
      scale: 1
    };
    params.captureBeyondViewport = true;
  } else if (payload.clip && typeof payload.clip === "object") {
    params.clip = payload.clip;
  } else if (payload.fullPage === true) {
    const metrics = await cdpSend(payload.tabId, "Page.getLayoutMetrics", {});
    const contentSize = metrics.cssContentSize || metrics.contentSize || {};
    const maxDimension = Math.max(1, Math.min(32767, Math.round(Number(payload.maxDimension || 16384))));
    const width = Math.max(1, Math.ceil(Number(contentSize.width || 1)));
    const height = Math.max(1, Math.ceil(Number(contentSize.height || 1)));
    params.clip = {
      x: 0,
      y: 0,
      width: Math.min(width, maxDimension),
      height: Math.min(height, maxDimension),
      scale: 1
    };
    params.captureBeyondViewport = true;
    fullPageSize = { width, height };
    clipped = width > maxDimension || height > maxDimension;
  }
  if (payload.fullPage === true) {
    params.captureBeyondViewport = true;
  }
  if (payload.fromSurface !== undefined) {
    params.fromSurface = payload.fromSurface;
  }
  let result;
  try {
    result = await cdpSend(payload.tabId, "Page.captureScreenshot", params, 15000);
  } catch (error) {
    if (!String(error?.message || "").includes("timed out")) {
      throw error;
    }
    await cdpDetachIfIdle(payload.tabId);
    result = await cdpSend(payload.tabId, "Page.captureScreenshot", params, 15000);
  }
  return {
    ok: true,
    data: result.data,
    mimeType: `image/${format}`,
    bytesApprox: Math.floor((result.data.length * 3) / 4),
    clip: params.clip || null,
    fullPageSize,
    clipped
  };
}

async function commandEvaluate(payload) {
  const tab = await chrome.tabs.get(payload.tabId);
  if (payload.localOnly === true) {
    await assertTabOwnership(payload.tabId, { context: payload, createdOnly: true });
    let url;
    try {
      url = new URL(String(tab.url || ""));
    } catch {
      throw new Error("Managed evaluate requires a valid loopback URL");
    }
    if (!["http:", "https:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      const error = new Error("Managed evaluate is allowed only on localhost or loopback pages; use tabward_probe instead");
      error.name = "LocalEvaluateOnly";
      throw error;
    }
  } else if (payload.privileged !== true) {
    const error = new Error("Runtime evaluation requires privileged mode");
    error.name = "PrivilegedModeError";
    throw error;
  }
  const params = {
    expression: payload.expression,
    includeCommandLineAPI: true,
    returnByValue: payload.returnByValue !== false,
    awaitPromise: payload.awaitPromise !== false
  };
  if (payload.userGesture === true) {
    params.userGesture = true;
  }
  if (payload.contextId !== undefined) {
    params.contextId = payload.contextId;
  }
  const result = await cdpSend(payload.tabId, "Runtime.evaluate", params);
  if (result.exceptionDetails) {
    return { ok: false, error: { description: result.exceptionDetails.exception?.description || result.exceptionDetails.text, line: result.exceptionDetails.lineNumber, column: result.exceptionDetails.columnNumber } };
  }
  const serialized = JSON.stringify(result.result ?? null);
  if (serialized.length > 1_000_000) {
    const error = new Error("Evaluate result exceeded 1,000,000 characters");
    error.name = "ResultTooLarge";
    throw error;
  }
  return { ok: true, result: result.result };
}

async function commandProbe(payload) {
  const resolvedPayload = { ...payload };
  if (payload.locator) {
    const snapshot = await locatorSnapshot(payload.tabId, payload.locator, payload.frameId);
    if (!snapshot?.target?.ref) {
      return { ok: false, error: "Probe target was not found" };
    }
    resolvedPayload.locator = { selector: snapshot.target.ref };
    delete resolvedPayload.selector;
  }
  return sanitizeBrowserPayload(await executeInTab(
    payload.tabId,
    pageProbe,
    [resolvedPayload],
    { frameId: payload.frameId }
  ));
}

async function commandQa(payload) {
  const steps = [];
  const screenshots = [];
  const cleanup = [];
  const categories = [
    ...(payload.captureConsole === false ? [] : ["console"]),
    ...(payload.captureNetwork === false ? [] : ["network"])
  ];
  const hadCdpAttachment = cdpTabs.has(payload.tabId);
  const priorBroker = cdpEventBrokers.get(payload.tabId);
  const priorBrokerState = priorBroker ? {
    categories: new Set(priorBroker.categories),
    started: priorBroker.started,
    resourceOwners: new Map(priorBroker.resourceOwners)
  } : null;
  const priorEmulationState = (await getEmulationStates())[payload.tabId];
  const priorEmulation = priorEmulationState
    ? structuredClone(priorEmulationState)
    : null;
  const qaOwner = cdpResourceOwner(payload);
  const suspendOwnedResources = (resources) => {
    const broker = cdpBroker(payload.tabId);
    const suspended = new Set();
    for (const resource of resources) {
      const owner = broker.resourceOwners.get(resource);
      if (!owner) continue;
      if (owner.sessionId !== qaOwner.sessionId || owner.state !== "active") {
        const error = new Error(
          `CDP resource ${resource} is already owned by operation ${owner.operationId}`
        );
        error.name = "CdpResourceBusy";
        throw error;
      }
      suspended.add(resource);
    }
    for (const resource of suspended) broker.resourceOwners.delete(resource);
    return suspended;
  };
  const suspendedResources = suspendOwnedResources([
    ...((payload.preset || payload.viewport) ? ["emulation"] : []),
    ...(categories.length ? ["events"] : [])
  ]);
  const suspendedEmulation = suspendedResources.has("emulation");
  const suspendedEvents = suspendedResources.has("events");
  let eventCursor = 0;
  let emulationApplied = false;
  let eventsStarted = false;
  let result = null;
  try {
    if (payload.preset || payload.viewport) {
      emulationApplied = true;
      const emulation = await commandEmulation(scopedPayload(payload, {
        tabId: payload.tabId,
        settings: { preset: payload.preset, viewport: payload.viewport }
      }));
      steps.push({ type: "emulation", ok: true, result: emulation });
    }
    if (categories.length) {
      const started = await commandEventsStart(scopedPayload(payload, {
        tabId: payload.tabId,
        categories
      }));
      eventsStarted = true;
      eventCursor = started.cursor || 0;
      steps.push({ type: "events_start", ok: true, categories });
    }
    for (const probe of payload.probes || []) {
      const result = await commandProbe(scopedPayload(payload, {
        tabId: payload.tabId,
        ...probe,
        frameId: probe.frame_id ?? probe.frameId
      }));
      steps.push({ type: "probe", operation: probe.operation, ok: result?.ok !== false, result });
      if (result?.ok === false) {
        return { ok: false, steps, screenshots, cleanup };
      }
    }
    for (const assertion of payload.assertions || []) {
      const result = await commandLocatorAssert(scopedPayload(payload, {
        tabId: payload.tabId,
        ...assertion,
        timeoutMs: payload.timeoutMs
      }));
      steps.push({ type: "assertion", assertion: assertion.assertion, ok: result.passed === true, result });
      if (!result.passed) {
        return { ok: false, steps, screenshots, cleanup };
      }
    }
    for (const [index, shot] of (payload.screenshots || []).entries()) {
      const result = await commandScreenshot(scopedPayload(payload, {
        tabId: payload.tabId,
        scope: shot.scope,
        locator: shot.locator,
        frameId: shot.frame_id ?? shot.frameId,
        fullPage: shot.scope === "full_page",
        format: "png",
        timeoutMs: payload.timeoutMs,
        visual: false
      }));
      screenshots.push({ ...result, name: shot.name || `qa-${index + 1}` });
    }
    const events = categories.length
      ? await commandEventsPoll(scopedPayload(payload, {
        tabId: payload.tabId,
        cursor: eventCursor,
        categories,
        limit: 500
      }))
      : { events: [] };
    const consoleErrors = (events.events || []).filter((event) =>
      event.category === "console"
      && /exception|error/i.test(`${event.method} ${JSON.stringify(event.params || {})}`)
    );
    const screenshotsPartial = screenshots.some((shot) =>
      shot.clipped === true || shot.truncated === true);
    const capturePartial = events.complete === false || screenshotsPartial;
    result = {
      ok: consoleErrors.length === 0 && !capturePartial,
      complete: !capturePartial,
      partial: capturePartial,
      truncated: events.truncated === true || screenshotsPartial,
      steps,
      screenshots,
      events: events.events || [],
      consoleErrors,
      cleanup
    };
    return result;
  } finally {
    const operations = [];
    if (emulationApplied) {
      const cleared = await bestEffort(commandEmulation(scopedPayload(payload, {
        tabId: payload.tabId,
        settings: { clear: true }
      })), 8000, "clear QA emulation");
      let restored = null;
      if (cleared?.ok !== false && priorEmulation) {
        restored = await bestEffort(commandEmulation(scopedPayload(payload, {
          tabId: payload.tabId,
          settings: priorEmulation
        })), 8000, "restore pre-QA emulation");
      }
      operations.push([
        "emulation",
        {
          ok: cleared?.ok !== false && restored?.ok !== false,
          cleared,
          restored,
          previousStateRestored: Boolean(priorEmulation)
        }
      ]);
    }
    if (eventsStarted) {
      const broker = cdpEventBrokers.get(payload.tabId);
      if (broker && priorBrokerState) {
        broker.categories = priorBrokerState.categories;
        broker.started = priorBrokerState.started;
      } else if (broker) {
        broker.categories.clear();
        broker.started = false;
      }
      operations.push(["events", {
        ok: true,
        previousStateRestored: Boolean(priorBrokerState)
      }]);
    }
    const restoredBroker = cdpEventBrokers.get(payload.tabId);
    if (restoredBroker && priorBrokerState) {
      restoredBroker.resourceOwners = priorBrokerState.resourceOwners;
    } else if (restoredBroker) {
      restoredBroker.resourceOwners.clear();
    }
    if (suspendedEmulation && !priorBrokerState?.resourceOwners.has("emulation")) {
      throw new Error("Pre-QA emulation ownership was not preserved");
    }
    if (suspendedEvents && !priorBrokerState?.resourceOwners.has("events")) {
      throw new Error("Pre-QA event ownership was not preserved");
    }
    if (!hadCdpAttachment && cdpTabs.has(payload.tabId)) {
      operations.push([
        "cdp",
        await bestEffort(cdpDetach(payload.tabId), 3000, "detach QA CDP")
      ]);
    } else {
      operations.push(["cdp", {
        ok: true,
        preservedExistingAttachment: hadCdpAttachment
      }]);
    }
    if (!priorBroker) {
      cdpEventBrokers.delete(payload.tabId);
    }
    for (const [operation, value] of operations) {
      cleanup.push({ operation, ok: value?.ok !== false, result: value });
    }
    if (result) {
      const cleanupFailed = cleanup.some((item) => item.ok === false);
      if (cleanupFailed) result.ok = false;
    }
  }
}

async function commandInputMouse(payload) {
  const params = {
    type: payload.type || "mouseMoved",
    x: Math.round(payload.x || 0),
    y: Math.round(payload.y || 0),
    modifiers: payload.modifiers || 0,
    timestamp: cdpTimestamp()
  };
  if (payload.button) {
    params.button = payload.button;
  }
  if (payload.clickCount !== undefined) {
    params.clickCount = payload.clickCount;
  }
  if (payload.buttons !== undefined) {
    params.buttons = payload.buttons;
  }
  if (payload.deltaX !== undefined) {
    params.deltaX = payload.deltaX;
  }
  if (payload.deltaY !== undefined) {
    params.deltaY = payload.deltaY;
  }
  const result = await cdpSend(payload.tabId, "Input.dispatchMouseEvent", params);
  return { ok: true, result };
}

async function commandInputKey(payload) {
  const params = {
    type: payload.type || "char",
    modifiers: payload.modifiers || 0,
    timestamp: cdpTimestamp()
  };
  if (payload.text !== undefined) {
    params.text = payload.text;
  }
  if (payload.key !== undefined) {
    params.key = payload.key;
  }
  if (payload.code !== undefined) {
    params.code = payload.code;
  }
  if (payload.windowsVirtualKeyCode !== undefined) {
    params.windowsVirtualKeyCode = payload.windowsVirtualKeyCode;
  }
  if (payload.unmodifiedText !== undefined) {
    params.unmodifiedText = payload.unmodifiedText;
  }
  const result = await cdpSend(payload.tabId, "Input.dispatchKeyEvent", params);
  return { ok: true, result };
}

async function cdpScrollPosition(tabId) {
  const result = await cdpSend(tabId, "Runtime.evaluate", {
    expression: "({ x: window.scrollX, y: window.scrollY })",
    returnByValue: true,
    awaitPromise: false
  });
  return result.result?.value || null;
}

async function commandInputScroll(payload) {
  const deltaX = Number.isFinite(Number(payload.deltaX)) ? Number(payload.deltaX) : 0;
  const deltaY = Number.isFinite(Number(payload.deltaY)) ? Number(payload.deltaY) : 0;
  const before = await bestEffort(cdpScrollPosition(payload.tabId), 1200, "scroll position before wheel");
  const result = await cdpSend(payload.tabId, "Runtime.evaluate", {
    expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}); ({ x: window.scrollX, y: window.scrollY })`,
    returnByValue: true,
    awaitPromise: false
  });
  const after = result.result?.value || await bestEffort(cdpScrollPosition(payload.tabId), 1200, "scroll position after scroll");
  return { ok: true, result: result.result, before, after, fallbackUsed: true };
}

function resolveWorkflowValue(value, results) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowValue(item, results));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Number.isInteger(value.$step) && typeof value.path === "string") {
    let current = results[value.$step]?.result;
    for (const segment of value.path.split(".").filter(Boolean)) {
      if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(Object(current), segment)) {
        throw new Error(`Workflow reference $step ${value.$step}.${value.path} was not found`);
      }
      current = current[segment];
    }
    return current;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveWorkflowValue(item, results)])
  );
}

async function commandWorkflow(payload) {
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const maxSteps = Math.max(1, Math.min(Number(payload.maxSteps || 20), 30));
  if (steps.length === 0) {
    return { ok: false, error: "Workflow requires at least one step", steps: [] };
  }
  if (steps.length > maxSteps) {
    return { ok: false, error: `Workflow has ${steps.length} steps, limit is ${maxSteps}`, steps: [] };
  }
  const allowed = {
    observe: commandObserve,
    smartClick: commandSmartClick,
    smartFill: commandSmartFill,
    navigate: commandNavigate,
    pageState: commandGetPageState,
    queryRich: commandQueryRich,
    extractImages: commandExtractImages,
    waitForText: commandWaitForText,
    waitForSelector: commandWaitForSelector,
    reload: commandReload,
    inputKey: commandInputKey,
    inputScroll: commandInputScroll
  };
  const defaultTabId = payload.tabId;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, Math.min(Number(payload.timeoutMs || 120000), 300000));
  const results = [];
  for (let index = 0; index < steps.length; index += 1) {
    throwIfCommandAborted(payload);
    if (Date.now() >= deadline) {
      results.push({ index, ok: false, error: "Workflow deadline exceeded" });
      return { ok: false, stoppedAt: index, steps: results };
    }
    const step = steps[index];
    const type = step && typeof step.type === "string" ? step.type : "";
    const handler = allowed[type];
    if (!handler) {
      results.push({ index, type, ok: false, error: `Workflow step type is not allowed: ${type || "<empty>"}` });
      return { ok: false, stoppedAt: index, steps: results };
    }
    try {
      const stepPayload = resolveWorkflowValue(step.payload || {}, results);
      if (stepPayload.tabId === undefined && defaultTabId !== undefined) {
        stepPayload.tabId = defaultTabId;
      }
      if ((type === "smartClick" || type === "smartFill") && stepPayload.cursor === undefined) {
        stepPayload.cursor = false;
      }
      const result = await handler(scopedPayload(payload, stepPayload));
      const ok = !result || result.ok !== false;
      results.push({
        index,
        type,
        ok,
        elapsedMs: Date.now() - startedAt,
        result
      });
      if (!ok && step.continueOnError !== true) {
        return { ok: false, stoppedAt: index, steps: results };
      }
    } catch (error) {
      results.push({ index, type, ok: false, error: toSafeError(error) });
      if (step.continueOnError !== true) {
        return { ok: false, stoppedAt: index, steps: results };
      }
    }
  }
  return { ok: results.every((step) => step.ok), steps: results };
}

// ---------------------------------------------------------------------------
// Session / turn command handlers
// ---------------------------------------------------------------------------

async function commandNameSession(payload) {
  const session = await resolveSessionContext(payload);
  if (
    session.mode === "full_profile"
    && (await getUserSettings()).existingTabAccess !== true
  ) {
    const error = new Error(
      "Full Profile requires the user to enable existing-tab access in the TabWard popup"
    );
    error.name = "ExistingTabAccessDisabled";
    throw error;
  }
  session.name = payload.name || session.name || "TabWard session";
  let cleanQa = null;
  if (session.cleanQa === true) {
    cleanQa = await prepareCleanQa(session);
  }
  const workspace = await getSessionWorkspace(session);
  return { ok: true, session, workspace, cleanQa: publicCleanQaState(cleanQa) };
}

async function commandAdoptTab(payload) {
  const settingsBefore = await getUserSettings();
  if (
    payload.sessionMode !== "full_profile"
    || payload.canAdoptExistingTabs !== true
    || settingsBefore.allowExistingTabs !== true
  ) {
    const error = new Error(
      "Access to existing user tabs is disabled in the TabWard extension"
    );
    error.name = "OwnershipError";
    throw error;
  }
  if (payload.confirm !== true) {
    const error = new Error("Explicit confirm=true is required to adopt an existing tab");
    error.name = "OwnershipError";
    throw error;
  }
  const tab = await chrome.tabs.get(payload.tabId);
  const url = String(tab.url || "");
  if (!/^(https?|file):/i.test(url)) {
    const error = new Error("Only regular web pages can be adopted");
    error.name = "OwnershipError";
    throw error;
  }
  const session = await resolveSessionContext(payload);
  const existing = (await getOwnership())[payload.tabId];
  if (existing && existing.kind !== "released") {
    if (existing.sessionId !== session.id) {
      const error = new Error(`Tab ${payload.tabId} is already owned by session ${existing.sessionName || existing.sessionId}`);
      error.name = "OwnershipError";
      throw error;
    }
    return { ok: true, alreadyOwned: true, tab: slimTab(tab), ownership: existing };
  }
  if (existing?.kind === "released") {
    if (existing.sessionId !== session.id) {
      const error = new Error(`Tab ${payload.tabId} was released by another session`);
      error.name = "OwnershipError";
      throw error;
    }
    let restored;
    await mutateOwnership((ownership) => {
      const current = ownership[payload.tabId];
      if (
        !current
        || current.kind !== "released"
        || current.sessionId !== session.id
      ) {
        const error = new Error(`Tab ${payload.tabId} ownership changed during adoption`);
        error.name = "OwnershipError";
        throw error;
      }
      restored = {
        ...current,
        kind: current.previousKind || "adopted",
        adoptedAt: new Date().toISOString()
      };
      delete restored.previousKind;
      delete restored.releasedAt;
      ownership[payload.tabId] = restored;
      return ownership;
    });
    if (!(await getUserSettings()).allowExistingTabs) {
      await releaseOwnership(payload.tabId);
      const error = new Error(
        "Access to existing user tabs was disabled before adoption completed"
      );
      error.name = "OwnershipError";
      throw error;
    }
    return { ok: true, adopted: true, restored: true, tab: slimTab(tab), ownership: restored };
  }
  const ownership = await rememberTab(tab, "adopted", session);
  if (!(await getUserSettings()).allowExistingTabs) {
    await releaseOwnership(payload.tabId);
    const error = new Error(
      "Access to existing user tabs was disabled before adoption completed"
    );
    error.name = "OwnershipError";
    throw error;
  }
  return { ok: true, adopted: true, tab: slimTab(tab), ownership };
}

async function commandReleaseTab(payload) {
  await assertTabOwnership(payload.tabId, { context: payload });
  await bestEffort(finishTabWork(payload.tabId, payload), 2500, "finish before release");
  await releaseOwnership(payload.tabId);
  return { ok: true, released: payload.tabId };
}

async function commandReleaseWorkspace(payload) {
  const session = await resolveSessionContext(payload);
  const ownership = await getOwnership();
  const released = [];
  const closed = [];
  const failures = [];
  let cleanQa = null;
  if (session.cleanQa === true) {
    cleanQa = await validateCleanQa(session);
  }
  const closeCreatedTabs = payload.closeCreatedTabs === true || session.cleanQa === true;
  const cleanWindowId = cleanQa?.windowId ?? null;
  let foreignCleanTabs = [];
  let cleanTabsVerified = true;
  let cleanTabsVerificationError = null;
  let cleanWindowClosed = !Number.isInteger(cleanWindowId);
  let cleanWindowCloseError = null;
  if (Number.isInteger(cleanWindowId)) {
    const cleanTabsResult = await bestEffort(
      chrome.tabs.query({ windowId: cleanWindowId }),
      3000,
      "list Clean QA tabs during cleanup"
    );
    cleanTabsVerified = Array.isArray(cleanTabsResult);
    cleanTabsVerificationError = cleanTabsVerified ? null : cleanTabsResult?.error;
    const cleanTabs = cleanTabsVerified ? cleanTabsResult : [];
    foreignCleanTabs = cleanTabs.filter((tab) => {
      const record = ownership[tab.id];
      return !record || record.sessionId !== session.id;
    });
  }
  const canCloseCreatedTabs = closeCreatedTabs
    && (session.cleanQa !== true || cleanTabsVerified);
  for (const [rawTabId, record] of Object.entries(ownership)) {
    if (record?.sessionId !== session.id || record.kind === "released") {
      continue;
    }
    if (session.cleanQa === true && !cleanTabsVerified) {
      continue;
    }
    const tabId = Number(rawTabId);
    await bestEffort(finishTabWork(tabId, payload), 2500, "finish before workspace release");
    if (
      canCloseCreatedTabs
      && ["created", "created-child"].includes(record.kind)
    ) {
      const closeResult = await bestEffort(
        chrome.tabs.remove(tabId),
        5000,
        "close workspace tab"
      );
      let stillPresent = null;
      if (closeResult?.ok === false) {
        stillPresent = classifyMissingTab(await bestEffort(
          chrome.tabs.get(tabId),
          2000,
          "verify workspace tab after close failure"
        ));
      }
      const removed = TabWardStageTwo.tabRemovalConfirmed(
        closeResult,
        stillPresent
      );
      if (removed) {
        await forgetTab(tabId);
        closed.push(tabId);
      } else {
        failures.push({
          resource: "tab",
          tabId,
          operation: "close",
          error: closeResult.error
        });
      }
    } else {
      const releaseResult = await bestEffort(
        releaseOwnership(tabId),
        2500,
        "release workspace tab"
      );
      if (releaseResult?.ok === false) {
        failures.push({
          resource: "tab",
          tabId,
          operation: "release",
          error: releaseResult.error
        });
      } else {
        released.push(tabId);
      }
    }
  }
  if (Number.isInteger(cleanWindowId) && cleanTabsVerified && foreignCleanTabs.length === 0) {
    const closeResult = await bestEffort(
      chrome.windows.remove(cleanWindowId),
      5000,
      "close Clean QA window"
    );
    if (closeResult?.ok === false) {
      const remainingWindows = await bestEffort(
        incognitoWindows(),
        3000,
        "verify Clean QA window cleanup"
      );
      cleanWindowClosed = Array.isArray(remainingWindows)
        && !remainingWindows.some((window) => window.id === cleanWindowId);
      cleanWindowCloseError = cleanWindowClosed ? null : closeResult.error;
      if (!cleanWindowClosed) {
        failures.push({
          resource: "clean_qa_window",
          windowId: cleanWindowId,
          operation: "close",
          error: closeResult.error
        });
      }
    } else {
      cleanWindowClosed = true;
    }
  }
  await releaseSessionDownloads(session.id);
  const partial = failures.length > 0 || !cleanTabsVerified;
  if (!partial) {
    await forgetSessionWindow(session.id);
    await forgetSessionPolicy(session.id);
  }
  if (!partial && (cleanWindowClosed || foreignCleanTabs.length > 0)) {
    await forgetCleanQaState(session.id);
  } else {
    const states = await getCleanQaStates();
    if (states[session.id]) {
      states[session.id] = {
        ...states[session.id],
        status: "tainted",
        reason: cleanTabsVerified
          ? "Could not close the Clean QA window"
          : "Could not verify Clean QA tabs during cleanup",
        leaseExpiresAt: Date.now() / 1000,
        updatedAt: new Date().toISOString()
      };
      await setCleanQaStates(states);
    }
  }
  return {
    ok: !partial,
    outcome: partial ? "cleanup_partial" : "completed",
    released,
    closed,
    failures,
    workspaceWindowPreserved: session.cleanQa === true
      ? !cleanWindowClosed
      : payload.closeCreatedTabs !== true,
    cleanQa: session.cleanQa === true ? {
      closed: cleanWindowClosed,
      wasTainted: cleanQa?.status === "tainted",
      foreignTabsPreserved: foreignCleanTabs.map((tab) => tab.id),
      inventoryVerified: cleanTabsVerified,
      verificationError: cleanTabsVerificationError,
      closeError: cleanWindowCloseError
    } : null
  };
}

async function commandTurnEnded(payload) {
  const session = await resolveSessionContext(payload);
  const ownership = await getOwnership();
  const tabIds = Object.values(ownership)
    .filter((record) => record.sessionId === session.id && record.kind !== "released")
    .map((record) => record.tabId);
  for (const tabId of tabIds) {
    await bestEffort(cdpDetach(tabId, {
      forceSessionId: session.id,
      preserveForeign: true
    }), 2000, "cdp detach on turn end");
  }
  return { ok: true, session, detachedTabIds: tabIds };
}

async function commandHandoff(payload) {
  if (payload.tabId === undefined || payload.tabId === null) {
    throw new Error("tabId is required");
  }
  const result = await handoffTab(payload.tabId, payload, payload.label || "TabWard");
  await releaseOwnership(payload.tabId, true);
  return { ...result, ownershipReleased: true };
}

async function commandDeliverable(payload) {
  if (payload.tabId === undefined || payload.tabId === null) {
    throw new Error("tabId is required");
  }
  return deliverableTab(payload.tabId, payload, payload.summary || "");
}

const handlers = {
  ping: commandPing,
  openTab: commandOpenTab,
  navigate: commandNavigate,
  navigateAdvanced: commandNavigateAdvanced,
  goBack: (payload) => commandHistory(payload, "back"),
  goForward: (payload) => commandHistory(payload, "forward"),
  tabs: commandTabs,
  getText: commandGetText,
  getHtml: commandGetHtml,
  getPageState: commandGetPageState,
  extractTables: commandExtractTables,
  observe: commandObserve,
  snapshot: commandSnapshot,
  query: commandQuery,
  queryRich: commandQueryRich,
  extractImages: commandExtractImages,
  resolveTarget: commandResolveTarget,
  click: commandClick,
  fill: commandFill,
  smartClick: commandSmartClick,
  smartFill: commandSmartFill,
  locatorAction: commandLocatorAction,
  form: commandForm,
  locatorWait: commandLocatorWait,
  locatorAssert: commandLocatorAssert,
  workflow: commandWorkflow,
  downloadClick: commandDownloadClick,
  downloadImage: commandDownloadImage,
  downloads: commandDownloads,
  deleteDownload: commandDeleteDownload,
  closeTab: commandCloseTab,
  activateTab: commandActivateTab,
  cursor: commandCursor,
  finish: commandFinish,
  cleanup: commandCleanup,
  reloadExtension: commandReloadExtension,
  reload: commandReload,
  waitForText: commandWaitForText,
  waitForSelector: commandWaitForSelector,
  attach: commandAttach,
  detach: commandDetach,
  cdp: commandCdp,
  eventsStart: commandEventsStart,
  eventsPoll: commandEventsPoll,
  eventsClear: commandEventsClear,
  eventsStop: commandEventsStop,
  dialogHandle: commandDialogHandle,
  networkBody: commandNetworkBody,
  networkHar: commandNetworkHar,
  interceptionStart: commandInterceptionStart,
  interceptionContinue: commandInterceptionContinue,
  interceptionFail: commandInterceptionFail,
  interceptionFulfill: commandInterceptionFulfill,
  interceptionStop: commandInterceptionStop,
  emulation: commandEmulation,
  storage: commandStorage,
  traceStart: commandTraceStart,
  traceStop: commandTraceStop,
  screencastStart: commandScreencastStart,
  screencastFrame: commandScreencastFrame,
  screencastStop: commandScreencastStop,
  screenshot: commandScreenshot,
  evaluate: commandEvaluate,
  probe: commandProbe,
  qa: commandQa,
  inputMouse: commandInputMouse,
  inputKey: commandInputKey,
  inputScroll: commandInputScroll,
  nameSession: commandNameSession,
  turnEnded: commandTurnEnded,
  handoff: commandHandoff,
  deliverable: commandDeliverable,
  adoptTab: commandAdoptTab,
  releaseTab: commandReleaseTab,
  releaseWorkspace: commandReleaseWorkspace,
  getUserSettings: async () => ({
    ok: true,
    settings: await getUserSettings()
  })
};

function commandCapabilities(type, payload, session) {
  const capabilities = [...(COMMAND_CAPABILITY_POLICY[type] || [])];
  if (type === "locatorAction" && payload.action === "upload") {
    return ["uploads"];
  }
  if (type === "evaluate") {
    return [session?.mode === "managed" ? "evaluate_local" : "evaluate"];
  }
  if (type === "qa") {
    if (payload.preset || payload.viewport) capabilities.push("emulation");
    if (payload.captureConsole === true || payload.captureNetwork === true) {
      capabilities.push("events");
    }
    if (Array.isArray(payload.screenshots) && payload.screenshots.length > 0) {
      capabilities.push("artifacts");
    }
  }
  if (type === "workflow") {
    if (!Array.isArray(payload.steps)) {
      throw new Error("workflow steps must be an array");
    }
    for (const [index, step] of payload.steps.entries()) {
      if (!step || typeof step !== "object" || Array.isArray(step) || typeof step.type !== "string") {
        throw new Error(`workflow step ${index} is invalid`);
      }
      const required = WORKFLOW_STEP_CAPABILITY_POLICY[step.type];
      if (!required) {
        throw new Error(`workflow step type is not allowed: ${step.type || "<empty>"}`);
      }
      capabilities.push(...required);
    }
  }
  if (type === "form") {
    if (!Array.isArray(payload.fields)) {
      throw new Error("form fields must be an array");
    }
    for (const [index, field] of payload.fields.entries()) {
      if (!field || typeof field !== "object" || Array.isArray(field) || typeof field.action !== "string") {
        throw new Error(`form field ${index} is invalid`);
      }
      const required = FORM_FIELD_CAPABILITY_POLICY[field.action];
      if (!required) {
        throw new Error(`form field action is not allowed: ${field.action || "<empty>"}`);
      }
      capabilities.push(...required);
    }
  }
  return [...new Set(capabilities)];
}

function validateOperationSession(session) {
  if (!session?.id || !["managed", "full_profile"].includes(session.mode)) {
    throw new Error("Authenticated session context is required");
  }
  if (!TabWardStageTwo.sessionExpiresAtValid(session.expiresAt)) {
    const error = new Error("Authenticated session context is expired");
    error.name = "SessionPolicyError";
    throw error;
  }
  const capabilities = Array.isArray(session.capabilities)
    ? session.capabilities.map(String)
    : [];
  const unique = new Set(capabilities);
  const allowed = session.mode === "managed"
    ? MANAGED_SESSION_CAPABILITIES
    : FULL_PROFILE_SESSION_CAPABILITIES;
  if (
    unique.size !== capabilities.length
    || capabilities.some((capability) => !allowed.has(capability))
  ) {
    const error = new Error("Authenticated session capabilities are invalid");
    error.name = "SessionPolicyError";
    throw error;
  }
  return unique;
}

async function dispatch(command, context) {
  const type = command.type;
  if (!handlers[type]) {
    throw new Error(`Unknown command: ${type}`);
  }
  if (!Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITY_POLICY, type)) {
    const error = new Error(`No capability policy exists for command: ${type}`);
    error.name = "SessionPolicyError";
    throw error;
  }
  const payload = { ...(command.payload || {}) };
  const capabilityPolicy = COMMAND_CAPABILITY_POLICY[type];
  if (capabilityPolicy !== null) {
    let capabilities;
    try {
      capabilities = validateOperationSession(context.session);
    } catch (error) {
      error.name = "SessionPolicyError";
      throw error;
    }
    for (const capability of commandCapabilities(type, payload, context.session)) {
      if (!capabilities.has(capability)) {
        const error = new Error(`${type} requires the ${capability} capability`);
        error.name = "SessionPolicyError";
        throw error;
      }
    }
    if (type !== "nameSession") {
    const policy = (await getSessionPolicies())[context.session.id];
    const policyCapabilities = Array.isArray(context.session.capabilities)
      ? [...context.session.capabilities].sort()
      : [];
    if (
      !policy
      || policy.mode !== context.session.mode
      || JSON.stringify(policy.capabilities || []) !== JSON.stringify(policyCapabilities)
    ) {
      const error = new Error("Session policy does not match the authenticated session");
      error.name = "SessionPolicyError";
      throw error;
    }
    }
    if (
      context.session.mode === "full_profile"
      && (await getUserSettings()).existingTabAccess !== true
      && !["releaseWorkspace", "releaseTab", "turnEnded"].includes(type)
    ) {
      const error = new Error(
        "Full Profile is disabled by the TabWard existing-tab access setting"
      );
      error.name = "ExistingTabAccessDisabled";
      throw error;
    }
  }
  Object.defineProperty(payload, OPERATION_CONTEXT, {
    value: context,
    enumerable: true,
    configurable: false,
    writable: false
  });
  if (payload.tabId !== undefined && type !== "adoptTab" && type !== "openTab") {
    await assertTabOwnership(payload.tabId, { context: context.session || undefined });
    if (context.session?.cleanQa === true) {
      const cleanState = await validateCleanQa(context.session);
      if (cleanState?.status === "tainted") {
        const error = new Error(cleanState.reason || "Clean QA state is tainted");
        error.name = "CleanQaTainted";
        throw error;
      }
    }
  }
  const timeoutMs = Math.max(1, context.deadlineAt - Date.now());
  return await withTimeout(
    handlers[type](payload),
    timeoutMs,
    `command ${type}`,
    () => activeOperations.get(context.operationId)?.controller.abort()
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TABWARD_STATUS") {
    connectTransport();
    sendResponse(transportStatus());
    return false;
  }
  if (message?.type === "TABWARD_PAIR_APPROVE") {
    try {
      approvePairing(message.code);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: toSafeError(error) });
    }
    return false;
  }
  if (message?.type === "TABWARD_PAIR_REVOKE") {
    revokePairing()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: toSafeError(error) }));
    return true;
  }
  if (message?.type === "TABWARD_SETTINGS_GET") {
    getUserSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: toSafeError(error) }));
    return true;
  }
  if (message?.type === "TABWARD_SETTINGS_UPDATE") {
    updateUserSettings(message.settings || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: toSafeError(error) }));
    return true;
  }
  if (message?.type === "TABWARD_APPROVALS_GET") {
    listPendingApprovals()
      .then((approvals) => sendResponse({ ok: true, approvals }))
      .catch((error) => sendResponse({ ok: false, error: toSafeError(error) }));
    return true;
  }
  if (message?.type === "TABWARD_APPROVAL_DECIDE") {
    decidePendingApproval(String(message.approvalId || ""), String(message.decision || ""))
      .then((approval) => sendResponse({ ok: true, approval }))
      .catch((error) => sendResponse({ ok: false, error: toSafeError(error) }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tabward-transport", { periodInMinutes: 0.5 });
  connectTransport();
});

chrome.runtime.onStartup.addListener(connectTransport);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "tabward-transport") {
    return;
  }
  connectTransport();
  sendTransportPing();
  syncApprovalBadge().catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  connectTransport();
  if (!tab?.id || tab.openerTabId === undefined) {
    return;
  }
  (async () => {
    const ownership = await getOwnership();
    const opener = ownership[tab.openerTabId];
    if (!opener || opener.kind === "released") {
      return;
    }
    const session = {
      id: opener.sessionId,
      name: opener.sessionName || "TabWard MCP",
      mode: "managed",
      cleanQa: opener.cleanQa === true
    };
    const workspaceWindow = await getLiveSessionWindow(session);
    let ownedTab = tab;
    if (workspaceWindow?.id !== undefined && tab.windowId !== workspaceWindow.id) {
      ownedTab = await chrome.tabs.move(tab.id, {
        windowId: workspaceWindow.id,
        index: -1
      });
    }
    await rememberTab(ownedTab, "created-child", session);
    try {
      if (session.cleanQa === true) {
        const states = await getCleanQaStates();
        if (states[session.id]) {
          states[session.id] = {
            ...states[session.id],
            createdTabIds: Array.from(new Set([
              ...(states[session.id].createdTabIds || []),
              ownedTab.id
            ])),
            updatedAt: new Date().toISOString()
          };
          await setCleanQaStates(states);
        }
        await validateCleanQa(session);
        return;
      }
      const groupId = await putInWorkspace(
        ownedTab.id,
        ownedTab.windowId,
        `TabWard: ${session.name}`.slice(0, 80),
        false,
        session
      );
      await mutateOwnership((ownership) => {
        if (ownership[ownedTab.id]) {
          ownership[ownedTab.id] = {
            ...ownership[ownedTab.id],
            groupId
          };
        }
        return ownership;
      });
    } catch (_error) {
    }
  })().catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url) {
    connectTransport();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  connectTransport();
});

chrome.windows.onRemoved.addListener((windowId) => {
  (async () => {
    const windows = await getWorkspaceWindows();
    let changed = false;
    for (const [sessionId, record] of Object.entries(windows)) {
      if (record?.windowId === windowId) {
        delete windows[sessionId];
        changed = true;
      }
    }
    if (changed) {
      await setWorkspaceWindows(windows);
    }
  })().catch(() => {});
});

connectTransport();
syncApprovalBadge().catch(() => {});
