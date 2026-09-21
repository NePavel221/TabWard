import { randomUUID } from "node:crypto";

export const MANAGED_QA_CAPABILITIES = [
  "read",
  "action",
  "artifacts",
  "downloads",
  "emulation",
  "evaluate_local",
  "events",
  "probes",
  "tracing",
  "uploads"
] as const;

export const FULL_PROFILE_CAPABILITIES = [
  ...MANAGED_QA_CAPABILITIES,
  "adopt_tabs",
  "cdp",
  "evaluate",
  "network_interception",
  "storage"
] as const;

export type Capability = typeof FULL_PROFILE_CAPABILITIES[number];
export type SessionMode = "managed" | "full_profile";
export type WorkspaceMode = "isolated" | "current";
const CLOSING_TTL_SECONDS = 5 * 60;

export interface Session {
  id: string;
  name: string;
  mode: SessionMode;
  workspace: WorkspaceMode;
  capabilities: Set<Capability>;
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
  tabIds: Set<number>;
  createdTabIds: Set<number>;
  adoptedTabIds: Set<number>;
  workspaceWindowId: number | null;
  cleanQa: boolean;
  cleanQaTainted: boolean;
  state: "active" | "closing" | "cleanup_partial";
  cleanup?: unknown;
}

function isCapability(value: string): value is Capability {
  return (FULL_PROFILE_CAPABILITIES as readonly string[]).includes(value);
}

export class SessionPolicy {
  #sessions = new Map<string, Session>();

  start(options: {
    name?: string;
    mode?: SessionMode;
    workspace?: WorkspaceMode;
    ttlSeconds?: number;
    capabilities?: string[];
    cleanQa?: boolean;
  } = {}): Session {
    const {
      name = "TabWard MCP",
      mode = "managed",
      workspace = "current",
      ttlSeconds = 1800,
      capabilities,
      cleanQa = false
    } = options;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
      throw new Error("ttl_seconds must be between 60 and 86400");
    }
    const allowed = new Set<Capability>(
      mode === "full_profile"
        ? FULL_PROFILE_CAPABILITIES
        : MANAGED_QA_CAPABILITIES
    );
    const requested = capabilities ?? [...allowed];
    const unknown = requested.filter((item) => !isCapability(item));
    const forbidden = requested.filter((item) =>
      isCapability(item) && !allowed.has(item)
    );
    if (unknown.length > 0) {
      throw new Error(`Unknown capabilities: ${unknown.join(", ")}`);
    }
    if (forbidden.length > 0) {
      throw new Error(
        `Capabilities require full_profile mode: ${forbidden.join(", ")}`
      );
    }
    const now = Date.now() / 1000;
    const session: Session = {
      id: `tabward-${randomUUID().replaceAll("-", "")}`,
      name,
      mode,
      workspace,
      capabilities: new Set(requested as Capability[]),
      createdAt: now,
      expiresAt: now + ttlSeconds,
      ttlSeconds,
      tabIds: new Set(),
      createdTabIds: new Set(),
      adoptedTabIds: new Set(),
      workspaceWindowId: null,
      cleanQa,
      cleanQaTainted: false,
      state: "active"
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string, touch = true, allowClosing = false): Session {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new Error("Unknown TabWard session");
    }
    const now = Date.now() / 1000;
    if (session.expiresAt <= now) {
      this.#sessions.delete(id);
      throw new Error("TabWard session expired");
    }
    if (!allowClosing && session.state !== "active") {
      throw new Error(`TabWard session is ${session.state}; new commands are rejected`);
    }
    if (touch) {
      session.expiresAt = now + session.ttlSeconds;
    }
    return session;
  }

  require(id: string, ...capabilities: Capability[]): Session {
    const session = this.get(id);
    const missing = capabilities.filter((item) =>
      !session.capabilities.has(item)
    );
    if (missing.length > 0) {
      throw new Error(`Session lacks capabilities: ${missing.join(", ")}`);
    }
    return session;
  }

  owner(tabId: number, excludeSessionId?: string): Session | null {
    for (const session of this.#liveSessions()) {
      if (session.id !== excludeSessionId && session.tabIds.has(tabId)) {
        return session;
      }
    }
    return null;
  }

  assignTab(
    sessionId: string,
    tabId: number,
    options: { created?: boolean; adopted?: boolean } = {}
  ): Session {
    const session = this.get(sessionId);
    const owner = this.owner(tabId, sessionId);
    if (owner) {
      throw new Error(`Tab ${tabId} is already owned by session ${owner.name}`);
    }
    session.tabIds.add(tabId);
    if (options.created) {
      session.createdTabIds.add(tabId);
    }
    if (options.adopted) {
      session.adoptedTabIds.add(tabId);
    }
    return session;
  }

  releaseTab(sessionId: string, tabId: number): Session {
    const session = this.get(sessionId);
    session.tabIds.delete(tabId);
    session.createdTabIds.delete(tabId);
    session.adoptedTabIds.delete(tabId);
    return session;
  }

  close(id: string): Session {
    const session = this.get(id, false, true);
    this.#sessions.delete(id);
    return session;
  }

  beginClose(id: string): Session {
    const session = this.get(id, false, true);
    if (session.state === "active" || session.state === "cleanup_partial") {
      session.state = "closing";
      session.expiresAt = Math.max(
        session.expiresAt,
        Date.now() / 1000 + CLOSING_TTL_SECONDS
      );
      return session;
    }
    throw new Error("TabWard session is already closing");
  }

  cleanupPartial(id: string, cleanup: unknown): Session {
    const session = this.get(id, false, true);
    session.state = "cleanup_partial";
    session.cleanup = cleanup;
    session.expiresAt = Math.max(
      session.expiresAt,
      Date.now() / 1000 + CLOSING_TTL_SECONDS
    );
    return session;
  }

  active(): Record<string, unknown>[] {
    return this.#liveSessions().map(publicSession);
  }

  #liveSessions(): Session[] {
    const now = Date.now() / 1000;
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(id);
      }
    }
    return [...this.#sessions.values()];
  }
}

export function publicSession(session: Session): Record<string, unknown> {
  return {
    sessionId: session.id,
    name: session.name,
    mode: session.mode,
    workspace: session.workspace,
    capabilities: [...session.capabilities].sort(),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ttlSeconds: session.ttlSeconds,
    workspaceWindowId: session.workspaceWindowId,
    tabIds: [...session.tabIds].sort((a, b) => a - b),
    createdTabIds: [...session.createdTabIds].sort((a, b) => a - b),
    adoptedTabIds: [...session.adoptedTabIds].sort((a, b) => a - b),
    cleanQa: session.cleanQa,
    cleanQaTainted: session.cleanQaTainted,
    state: session.state,
    cleanup: session.cleanup ?? null
  };
}
