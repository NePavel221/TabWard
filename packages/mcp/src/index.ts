#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { saveBase64Artifact, saveJsonArtifact } from "./artifacts.js";
import { ExtensionBridge } from "./bridge.js";
import {
  publicSession,
  SessionPolicy,
  type Capability,
  type Session
} from "./session.js";

const VERSION = "0.1.0";
const bridge = new ExtensionBridge();
const sessions = new SessionPolicy();
const objectSchema = z.record(z.unknown());
const locatorSchema = z.object({
  ref: z.string().optional(),
  selector: z.string().optional(),
  css: z.string().optional(),
  xpath: z.string().optional(),
  testId: z.string().optional(),
  label: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  role: z.string().optional(),
  placeholder: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  index: z.number().int().min(0).max(10_000).optional(),
  exact: z.boolean().optional(),
  strict: z.boolean().optional(),
  visible: z.boolean().optional()
}).passthrough();

const server = new McpServer({
  name: "TabWard",
  version: VERSION
}, {
  instructions: [
    "Control authenticated Chrome tabs through TabWard.",
    "Start a managed session by default.",
    "Managed sessions access only tabs they create.",
    "Observe before acting and close the session when finished.",
    "Existing-tab adoption and privileged operations require full_profile mode."
  ].join(" ")
});

function output(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function context(session: Session): Record<string, unknown> {
  return {
    sessionId: session.id,
    sessionName: session.name,
    sessionMode: session.mode,
    canAdoptExistingTabs: session.capabilities.has("adopt_tabs"),
    workspace: session.workspace
  };
}

function tabIdFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function syncSessionTabs(
  session: Session,
  result: Record<string, unknown>
): void {
  if (!Array.isArray(result.knownTabs)) {
    return;
  }
  for (const value of result.knownTabs) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const tab = value as {
      id?: unknown;
      sessionId?: unknown;
      ownership?: unknown;
    };
    const id = tabIdFrom(tab.id);
    if (id === null || tab.sessionId !== session.id) {
      continue;
    }
    sessions.assignTab(session.id, id, {
      created: tab.ownership === "created"
        || tab.ownership === "created-child"
    });
  }
  const windowId = tabIdFrom(result.workspaceWindowId);
  if (windowId !== null) {
    session.workspaceWindowId = windowId;
  }
}

async function send(
  sessionId: string,
  capability: Capability,
  command: string,
  payload: Record<string, unknown> = {},
  options: { tabId?: number; timeoutMs?: number } = {}
): Promise<Record<string, unknown>> {
  const session = sessions.require(sessionId, capability);
  const tabId = options.tabId;
  if (tabId !== undefined) {
    if (session.mode === "managed" && !session.tabIds.has(tabId)) {
      const known = await bridge.send(
        "tabs",
        context(session),
        8_000
      ) as Record<string, unknown>;
      syncSessionTabs(session, known);
      if (!session.tabIds.has(tabId)) {
        throw new Error("Managed sessions can access only tabs opened by that session");
      }
    }
    const owner = sessions.owner(tabId, session.id);
    if (owner) {
      throw new Error(`Tab ${tabId} is already owned by session ${owner.name}`);
    }
    if (session.mode === "full_profile" && !session.tabIds.has(tabId)) {
      sessions.require(sessionId, "adopt_tabs");
      await bridge.send("adoptTab", {
        ...context(session),
        tabId,
        confirm: true
      }, 8_000);
      sessions.assignTab(session.id, tabId, { adopted: true });
    }
  }
  return await bridge.send(command, {
    ...payload,
    ...context(session),
    ...(tabId === undefined ? {} : { tabId })
  }, options.timeoutMs) as Record<string, unknown>;
}

server.registerTool("tabward_health", {
  description: "Check the local MCP, pairing state, and Chrome extension connection.",
  inputSchema: {}
}, async () => output({
  ok: bridge.status().state === "connected",
  serverVersion: VERSION,
  bridge: { host: bridge.host, port: bridge.port, ...bridge.status() },
  activeSessions: sessions.active().length
}));

server.registerTool("tabward_session_start", {
  description: "Start a managed or explicitly privileged full-profile browser session. The extension chooses the user-approved workspace.",
  inputSchema: {
    mode: z.enum(["managed", "full_profile"]).default("managed"),
    workspace: z.enum(["isolated", "current"]).optional().describe(
      "Compatibility hint only. The extension's user setting is authoritative."
    ),
    name: z.string().min(1).max(80).default("TabWard MCP"),
    ttl_seconds: z.number().int().min(60).max(86_400).default(1800),
    capabilities: z.array(z.string()).optional()
  }
}, async ({ mode, name, ttl_seconds, capabilities }) => {
  if (bridge.status().state !== "connected") {
    throw new Error("TabWard extension is not connected or paired");
  }
  const session = sessions.start({
    mode,
    workspace: "current",
    name,
    ttlSeconds: ttl_seconds,
    capabilities
  });
  try {
    const named = await bridge.send("nameSession", {
      ...context(session),
      name: session.name
    }, 5_000) as { workspace?: unknown };
    session.workspace = named.workspace === "isolated" ? "isolated" : "current";
  } catch (error) {
    sessions.close(session.id);
    throw error;
  }
  return output({
    ok: true,
    serverVersion: VERSION,
    session: publicSession(session)
  });
});

server.registerTool("tabward_session_list", {
  description: "List active sessions owned by this TabWard MCP process.",
  inputSchema: {}
}, async () => output({ sessions: sessions.active() }));

server.registerTool("tabward_session_close", {
  description: "Release a TabWard session; created tabs are preserved unless explicitly closed.",
  inputSchema: {
    session_id: z.string().min(1),
    close_created_tabs: z.boolean().default(false)
  }
}, async ({ session_id, close_created_tabs }) => {
  const session = sessions.get(session_id, false);
  const cleanup = await bridge.send("releaseWorkspace", {
    ...context(session),
    closeCreatedTabs: close_created_tabs
  }, 10_000);
  sessions.close(session_id);
  return output({
    ok: true,
    session: publicSession(session),
    cleanup
  });
});

server.registerTool("tabward_tabs", {
  description: "List, open, adopt, release, activate, close, reload, or navigate tabs.",
  inputSchema: {
    session_id: z.string().min(1),
    operation: z.enum([
      "list", "open", "adopt", "release",
      "activate", "close", "reload", "navigate"
    ]).default("list"),
    tab_id: z.number().int().positive().optional(),
    url: z.string().default("about:blank"),
    active: z.boolean().default(false),
    wait: z.boolean().default(true)
  }
}, async ({ session_id, operation, tab_id, url, active, wait }) => {
  const session = sessions.get(session_id);
  if (operation === "list") {
    const result = await bridge.send("tabs", context(session)) as Record<string, unknown>;
    syncSessionTabs(session, result);
    if (session.mode === "managed" && Array.isArray(result.knownTabs)) {
      result.knownTabs = result.knownTabs.filter((tab) =>
        typeof tab === "object" && tab !== null
        && session.tabIds.has(Number((tab as { id?: unknown }).id))
      );
      const activeId = typeof result.activeTab === "object" && result.activeTab !== null
        ? Number((result.activeTab as { id?: unknown }).id)
        : NaN;
      if (!session.tabIds.has(activeId)) {
        result.activeTab = null;
      }
    }
    return output(result);
  }
  if (operation === "open") {
    const result = await bridge.send("openTab", {
      ...context(session), url, active, wait
    }) as Record<string, unknown>;
    const openedId = tabIdFrom((result.tab as { id?: unknown } | undefined)?.id);
    if (openedId !== null) {
      sessions.assignTab(session.id, openedId, { created: true });
    }
    const windowId = tabIdFrom(result.workspaceWindowId);
    if (windowId !== null) {
      session.workspaceWindowId = windowId;
    }
    return output(result);
  }
  if (tab_id === undefined) {
    throw new Error(`tab_id is required for ${operation}`);
  }
  if (operation === "adopt") {
    sessions.require(session_id, "adopt_tabs");
    const result = await bridge.send("adoptTab", {
      ...context(session), tabId: tab_id, confirm: true
    }) as Record<string, unknown>;
    sessions.assignTab(session.id, tab_id, { adopted: true });
    return output(result);
  }
  const commands = {
    release: "releaseTab",
    activate: "activateTab",
    close: "closeTab",
    reload: "reload",
    navigate: "navigate"
  } as const;
  const result = await send(session_id, "action", commands[operation], {
    url, active, wait
  }, { tabId: tab_id });
  if (operation === "release" || operation === "close") {
    sessions.releaseTab(session.id, tab_id);
  }
  return output(result);
});

server.registerTool("tabward_navigate", {
  description: "Navigate a session-owned tab and wait for a selected lifecycle state.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    url: z.string().min(1),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle", "none"]).default("load"),
    timeout_ms: z.number().int().min(100).max(600_000).default(30_000)
  }
}, async ({ session_id, tab_id, url, wait_until, timeout_ms }) =>
  output(await send(session_id, "action", "navigateAdvanced", {
    url, waitUntil: wait_until, timeoutMs: timeout_ms
  }, { tabId: tab_id, timeoutMs: timeout_ms }))
);

server.registerTool("tabward_observe", {
  description: "Read a bounded semantic snapshot, text, HTML, state, tables, images, or query.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    mode: z.enum([
      "snapshot", "text", "html", "state", "tables",
      "images", "query", "text_only", "interactive_only", "links_only"
    ]).default("snapshot"),
    selector: z.string().optional(),
    include: z.array(z.string()).optional(),
    visible_only: z.boolean().default(true),
    max_chars: z.number().int().min(1_000).max(200_000).default(50_000),
    frame_id: z.number().int().optional()
  }
}, async ({ session_id, tab_id, mode, selector, include, visible_only, max_chars, frame_id }) => {
  const commands: Record<string, string> = {
    snapshot: "observe", text: "getText", html: "getHtml",
    state: "getPageState", tables: "extractTables",
    images: "extractImages", query: "queryRich",
    text_only: "observe", interactive_only: "observe", links_only: "observe"
  };
  const compact: Record<string, string[]> = {
    text_only: ["state", "text"],
    interactive_only: ["state", "interactive"],
    links_only: ["state", "links"]
  };
  return output(await send(session_id, "read", commands[mode]!, {
    selector,
    include: compact[mode] ?? include,
    visibleOnly: visible_only,
    maxChars: max_chars,
    frameId: frame_id
  }, { tabId: tab_id }));
});

server.registerTool("tabward_action", {
  description: "Perform a semantic locator action such as click, fill, type, press, or upload.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    action: z.enum([
      "click", "doubleClick", "hover", "fill", "type", "press",
      "check", "uncheck", "select", "focus", "blur", "drag", "upload"
    ]),
    locator: locatorSchema,
    value: z.unknown().optional(),
    options: objectSchema.optional(),
    timeout_ms: z.number().int().min(100).max(600_000).default(30_000)
  }
}, async ({ session_id, tab_id, action, locator, value, options, timeout_ms }) =>
  output(await send(
    session_id,
    action === "upload" ? "uploads" : "action",
    "locatorAction",
    { action, locator, value, options: options ?? {}, timeoutMs: timeout_ms },
    { tabId: tab_id, timeoutMs: timeout_ms }
  ))
);

server.registerTool("tabward_wait", {
  description: "Wait for locator, text, URL, load, DOM content, or network idle.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    locator: locatorSchema.optional(),
    state: z.enum([
      "visible", "hidden", "attached", "detached", "editable",
      "checked", "unchecked", "url", "load", "domcontentloaded", "networkidle"
    ]).default("visible"),
    text: z.string().optional(),
    url: z.string().optional(),
    timeout_ms: z.number().int().min(100).max(600_000).default(30_000)
  }
}, async ({ session_id, tab_id, locator, state, text, url, timeout_ms }) =>
  output(await send(session_id, "read", "locatorWait", {
    locator: locator ?? {}, state, text, url, timeoutMs: timeout_ms
  }, { tabId: tab_id, timeoutMs: timeout_ms }))
);

server.registerTool("tabward_assert", {
  description: "Assert URL, title, text, value, count, visibility, enabled, checked, or editable state.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    assertion: z.string().min(1),
    locator: locatorSchema.optional(),
    expected: z.unknown().optional(),
    timeout_ms: z.number().int().min(100).max(600_000).default(10_000),
    soft: z.boolean().default(false)
  }
}, async ({ session_id, tab_id, assertion, locator, expected, timeout_ms, soft }) => {
  const result = await send(session_id, "read", "locatorAssert", {
    assertion, locator: locator ?? {}, expected, timeoutMs: timeout_ms
  }, { tabId: tab_id, timeoutMs: timeout_ms });
  if (result.passed === false && !soft) {
    throw new Error(String(result.error || `Assertion failed: ${assertion}`));
  }
  return output(result);
});

server.registerTool("tabward_events", {
  description: "Start, poll, clear, stop, or handle console/network/dialog/navigation events.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    operation: z.enum(["start", "poll", "clear", "stop", "dialog"]).default("poll"),
    categories: z.array(z.string()).optional(),
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2_000).default(200),
    dialog_action: z.string().optional(),
    prompt_text: z.string().optional()
  }
}, async ({ session_id, tab_id, operation, categories, cursor, limit, dialog_action, prompt_text }) => {
  const commands = {
    start: "eventsStart", poll: "eventsPoll", clear: "eventsClear",
    stop: "eventsStop", dialog: "dialogHandle"
  };
  return output(await send(session_id, "events", commands[operation], {
    categories: categories ?? ["console", "network", "dialog", "navigation"],
    cursor, limit, action: dialog_action, promptText: prompt_text
  }, { tabId: tab_id }));
});

server.registerTool("tabward_network", {
  description: "Read response bodies/HAR or control request interception.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    operation: z.enum([
      "body", "har", "intercept_start", "continue",
      "fail", "fulfill", "intercept_stop"
    ]),
    request_id: z.string().optional(),
    patterns: z.array(objectSchema).optional(),
    response_code: z.number().int().min(100).max(599).default(200),
    response_headers: z.array(objectSchema).optional(),
    body: z.string().optional(),
    error_reason: z.string().default("Failed")
  }
}, async ({ session_id, tab_id, operation, request_id, patterns, response_code, response_headers, body, error_reason }) => {
  const commands = {
    body: "networkBody", har: "networkHar",
    intercept_start: "interceptionStart", continue: "interceptionContinue",
    fail: "interceptionFail", fulfill: "interceptionFulfill",
    intercept_stop: "interceptionStop"
  };
  const capability: Capability = ["body", "har"].includes(operation)
    ? "events"
    : "network_interception";
  return output(await send(session_id, capability, commands[operation], {
    requestId: request_id, patterns: patterns ?? [], responseCode: response_code,
    responseHeaders: response_headers ?? [], body, errorReason: error_reason
  }, { tabId: tab_id }));
});

server.registerTool("tabward_emulation", {
  description: "Apply or clear viewport, mobile, geolocation, timezone, locale, media, and user-agent emulation.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    settings: objectSchema
  }
}, async ({ session_id, tab_id, settings }) =>
  output(await send(session_id, "emulation", "emulation", { settings }, { tabId: tab_id }))
);

server.registerTool("tabward_storage", {
  description: "Snapshot, restore, get, set, or clear cookies and web storage using opaque snapshots.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    operation: z.string().min(1),
    data: objectSchema.optional()
  }
}, async ({ session_id, tab_id, operation, data }) =>
  output(await send(session_id, "storage", "storage", {
    operation, data: data ?? {}
  }, { tabId: tab_id }))
);

server.registerTool("tabward_artifact", {
  description: "Capture a screenshot, trace, or screencast frame into the local TabWard artifact directory.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    operation: z.enum([
      "screenshot", "trace_start", "trace_stop",
      "screencast_start", "screencast_frame", "screencast_stop"
    ]).default("screenshot"),
    name: z.string().optional(),
    options: objectSchema.optional()
  }
}, async ({ session_id, tab_id, operation, name, options }) => {
  const commands = {
    screenshot: "screenshot", trace_start: "traceStart", trace_stop: "traceStop",
    screencast_start: "screencastStart", screencast_frame: "screencastFrame",
    screencast_stop: "screencastStop"
  };
  const capability: Capability = operation.startsWith("trace")
    || operation.startsWith("screencast")
    ? "tracing"
    : "artifacts";
  const result = await send(session_id, capability, commands[operation], options ?? {}, {
    tabId: tab_id, timeoutMs: 60_000
  });
  if ((operation === "screenshot" || operation === "screencast_frame")
      && typeof result.data === "string") {
    const data = result.data;
    delete result.data;
    result.artifact = await saveBase64Artifact(
      data, name, result.mimeType === "image/jpeg" ? ".jpg" : ".png"
    );
  } else if (operation === "trace_stop" && Array.isArray(result.traceEvents)) {
    const traceEvents = result.traceEvents;
    delete result.traceEvents;
    result.artifact = await saveJsonArtifact({ traceEvents }, name, ".trace.json");
  }
  return output(result);
});

server.registerTool("tabward_evaluate", {
  description: "Evaluate privileged JavaScript in a full-profile session-owned tab.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    expression: z.string().min(1),
    await_promise: z.boolean().default(true),
    return_by_value: z.boolean().default(true)
  }
}, async ({ session_id, tab_id, expression, await_promise, return_by_value }) =>
  output(await send(session_id, "evaluate", "evaluate", {
    expression, awaitPromise: await_promise,
    returnByValue: return_by_value, privileged: true
  }, { tabId: tab_id }))
);

server.registerTool("tabward_cdp", {
  description: "Send an expert-level Chrome DevTools Protocol command.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    method: z.string().min(1),
    params: objectSchema.optional()
  }
}, async ({ session_id, tab_id, method, params }) =>
  output(await send(session_id, "cdp", "cdp", {
    method, params: params ?? {}
  }, { tabId: tab_id }))
);

server.registerTool("tabward_downloads", {
  description: "List, initiate, inspect, or delete downloads owned by a TabWard session.",
  inputSchema: {
    session_id: z.string(),
    operation: z.enum(["list", "click", "image", "delete"]).default("list"),
    tab_id: z.number().int().positive().optional(),
    locator: locatorSchema.optional(),
    selector: z.string().optional(),
    download_id: z.number().int().positive().optional(),
    index: z.number().int().min(1).max(500).default(1),
    filename: z.string().optional(),
    save_as: z.boolean().default(false),
    conflict_action: z.enum(["uniquify", "overwrite", "prompt"]).default("uniquify"),
    timeout_ms: z.number().int().min(100).max(600_000).default(60_000)
  }
}, async ({ session_id, operation, tab_id, locator, selector, download_id, index, filename, save_as, conflict_action, timeout_ms }) => {
  if (operation !== "list" && operation !== "delete" && tab_id === undefined) {
    throw new Error(`tab_id is required for ${operation}`);
  }
  const commands = {
    list: "downloads", click: "downloadClick",
    image: "downloadImage", delete: "deleteDownload"
  };
  return output(await send(session_id, "downloads", commands[operation], {
    locator: locator ?? {}, selector, downloadId: download_id, index,
    filename, saveAs: save_as, conflictAction: conflict_action,
    timeoutMs: timeout_ms
  }, {
    ...(tab_id === undefined ? {} : { tabId: tab_id }),
    timeoutMs: timeout_ms
  }));
});

server.registerTool("tabward_download_click", {
  description: "Click a framework download control and return a typed download outcome.",
  inputSchema: {
    session_id: z.string(),
    tab_id: z.number().int().positive(),
    locator: locatorSchema,
    timeout_ms: z.number().int().min(100).max(600_000).default(60_000)
  }
}, async ({ session_id, tab_id, locator, timeout_ms }) =>
  output(await send(session_id, "downloads", "downloadClick", {
    locator, timeoutMs: timeout_ms
  }, { tabId: tab_id, timeoutMs: timeout_ms }))
);

await bridge.start();
await server.connect(new StdioServerTransport());

async function shutdown(): Promise<void> {
  await bridge.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
