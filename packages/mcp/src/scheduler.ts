import {
  cancelledBeforeEffect,
  notStarted,
  OperationFailure,
  type OperationDescriptor
} from "./operation.js";

export type SchedulerLane =
  | { kind: "session"; key: string; resources: string[] }
  | { kind: "global"; key: string | null; resources: [] };

export interface SchedulerMetrics {
  active: number;
  queued: number;
  configuredMax: number;
  maxObservedActive: number;
}

interface ScheduledWork<T> {
  sequence: number;
  operation: OperationDescriptor;
  lane: SchedulerLane;
  run: () => Promise<T>;
  queuedAt: number;
  cancelled: boolean;
  active: boolean;
  settled: boolean;
  expiry: NodeJS.Timeout | null;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  onWait?: (waitMs: number) => void;
}

export interface SchedulerOptions {
  maxConcurrency: number;
  maxQueuePerSession: number;
  maxQueueTotal: number;
}

const SESSION_SCOPED_WITHOUT_TAB = new Set([
  "ping",
  "nameSession",
  "openTab",
  "tabs",
  "downloads"
]);

const GLOBAL_COMMANDS = new Set([
  "attach",
  "cdp",
  "cleanup",
  "detach",
  "executeCdp",
  "reloadExtension",
  "releaseWorkspace",
  "storage",
  "turnEnded"
]);

const CORRELATION_EXCLUSIVE_COMMANDS = new Set([
  "downloadClick",
  "downloadImage"
]);

const TAB_SCOPED_COMMANDS = new Set(`
  navigate navigateAdvanced goBack goForward getText getHtml getPageState
  extractTables observe snapshot query queryRich extractImages resolveTarget
  click fill smartClick smartFill locatorAction form locatorWait locatorAssert
  workflow closeTab activateTab cursor finish reload waitForText waitForSelector
  eventsStart eventsPoll eventsClear eventsStop dialogHandle networkBody
  networkHar interceptionStart interceptionContinue interceptionFail
  interceptionFulfill interceptionStop emulation traceStart traceStop
  screencastStart screencastFrame screencastStop screenshot evaluate probe qa
  inputMouse inputKey inputScroll adoptTab releaseTab handoff deliverable
  deleteDownload
`.trim().split(/\s+/));

export function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function schedulerOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SchedulerOptions {
  return {
    maxConcurrency: boundedInteger(
      env.TABWARD_SCHEDULER_MAX_CONCURRENCY,
      2,
      1,
      4
    ),
    maxQueuePerSession: boundedInteger(
      env.TABWARD_SCHEDULER_MAX_QUEUE_PER_SESSION,
      64,
      1,
      1024
    ),
    maxQueueTotal: boundedInteger(
      env.TABWARD_SCHEDULER_MAX_QUEUE_TOTAL,
      256,
      1,
      4096
    )
  };
}

export function classifyCommand(
  type: string,
  payload: Record<string, unknown>
): SchedulerLane {
  const sessionId = typeof payload.sessionId === "string"
    && payload.sessionId.length > 0
    ? payload.sessionId
    : null;
  const tabId = typeof payload.tabId === "number"
    && Number.isInteger(payload.tabId)
    && payload.tabId > 0
    ? payload.tabId
    : null;

  if (
    !sessionId
    || payload.cleanQa === true
    || GLOBAL_COMMANDS.has(type)
    || CORRELATION_EXCLUSIVE_COMMANDS.has(type)
    || type === "cdp"
  ) {
    return { kind: "global", key: sessionId, resources: [] };
  }
  if (tabId !== null && TAB_SCOPED_COMMANDS.has(type)) {
    return {
      kind: "session",
      key: sessionId,
      resources: [`tab:${tabId}`]
    };
  }
  if (SESSION_SCOPED_WITHOUT_TAB.has(type)) {
    return { kind: "session", key: sessionId, resources: [] };
  }
  return { kind: "global", key: sessionId, resources: [] };
}

function capacityExceeded(reason: string): OperationFailure {
  return new OperationFailure(
    "CapacityExceeded",
    `TabWard scheduler capacity exceeded: ${reason}`,
    {
      outcome: "not_started",
      effectPossible: false,
      retrySafe: true,
      reason
    }
  );
}

export class FairScheduler {
  readonly #options: SchedulerOptions;
  #sequence = 0;
  #active = 0;
  #queued = 0;
  #maxObservedActive = 0;
  #globalActive = false;
  #globalQueue: ScheduledWork<unknown>[] = [];
  #globalRoundRobin: string[] = [];
  #globalRoundRobinIndex = 0;
  #sessionQueues = new Map<string, ScheduledWork<unknown>[]>();
  #roundRobin: string[] = [];
  #roundRobinIndex = 0;
  #activeResources = new Set<string>();
  #activeSessions = new Set<string>();
  #sessionLoad = new Map<string, number>();
  #operations = new Map<string, ScheduledWork<unknown>>();
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#options = {
      maxConcurrency: boundedInteger(options.maxConcurrency, 1, 1, 4),
      maxQueuePerSession: boundedInteger(options.maxQueuePerSession, 64, 1, 1024),
      maxQueueTotal: boundedInteger(options.maxQueueTotal, 256, 1, 4096)
    };
  }

  metrics(): SchedulerMetrics {
    return {
      active: this.#active,
      queued: this.#queued,
      configuredMax: this.#options.maxConcurrency,
      maxObservedActive: this.#maxObservedActive
    };
  }

  schedule<T>(
    operation: OperationDescriptor,
    lane: SchedulerLane,
    run: () => Promise<T>,
    onWait?: (waitMs: number) => void
  ): Promise<T> {
    if (this.#stopped) {
      return Promise.reject(notStarted("scheduler is stopped"));
    }
    if (this.#operations.has(operation.operationId)) {
      return Promise.reject(new Error(
        `Operation ${operation.operationId} is already queued`
      ));
    }
    if (Date.now() >= operation.deadlineAt) {
      return Promise.reject(notStarted("deadline expired before scheduler admission"));
    }
    if (this.#queued >= this.#options.maxQueueTotal) {
      return Promise.reject(capacityExceeded("total queue depth limit reached"));
    }
    if (lane.key !== null) {
      const load = this.#sessionLoad.get(lane.key) ?? 0;
      if (load >= this.#options.maxQueuePerSession) {
        return Promise.reject(capacityExceeded("per-session queue depth limit reached"));
      }
    }

    return new Promise<T>((resolve, reject) => {
      const work: ScheduledWork<T> = {
        sequence: ++this.#sequence,
        operation,
        lane,
        run,
        queuedAt: performance.now(),
        cancelled: false,
        active: false,
        settled: false,
        expiry: null,
        resolve,
        reject,
        onWait
      };
      const delay = Math.max(1, operation.deadlineAt - Date.now());
      work.expiry = setTimeout(() => {
        if (work.active || work.settled) return;
        this.#removeQueued(work as ScheduledWork<unknown>);
        this.#releaseAdmission(work as ScheduledWork<unknown>);
        work.settled = true;
        work.reject(notStarted("deadline expired while waiting in the scheduler"));
        this.#pump();
      }, delay);
      this.#operations.set(operation.operationId, work as ScheduledWork<unknown>);
      this.#queued += 1;
      if (lane.key !== null) {
        this.#sessionLoad.set(lane.key, (this.#sessionLoad.get(lane.key) ?? 0) + 1);
      }
      if (lane.kind === "global") {
        this.#globalQueue.push(work as ScheduledWork<unknown>);
        const key = lane.key ?? "__anonymous__";
        if (!this.#globalRoundRobin.includes(key)) this.#globalRoundRobin.push(key);
      } else {
        let queue = this.#sessionQueues.get(lane.key);
        if (!queue) {
          queue = [];
          this.#sessionQueues.set(lane.key, queue);
          this.#roundRobin.push(lane.key);
        }
        queue.push(work as ScheduledWork<unknown>);
      }
      this.#pump();
    });
  }

  cancel(operationId: string): "not_found" | "queued" | "active" {
    const work = this.#operations.get(operationId);
    if (!work) return "not_found";
    if (work.active) return "active";
    if (work.settled) return "not_found";
    work.cancelled = true;
    this.#removeQueued(work);
    this.#releaseAdmission(work);
    work.settled = true;
    if (work.expiry) clearTimeout(work.expiry);
    work.reject(cancelledBeforeEffect("cancelled while waiting in the scheduler"));
    this.#pump();
    return "queued";
  }

  stop(): void {
    this.#stopped = true;
    for (const work of [...this.#operations.values()]) {
      if (work.active || work.settled) continue;
      this.#removeQueued(work);
      this.#releaseAdmission(work);
      work.settled = true;
      if (work.expiry) clearTimeout(work.expiry);
      work.reject(notStarted("scheduler stopped before dispatch"));
    }
  }

  #removeQueued(work: ScheduledWork<unknown>): void {
    const queue = work.lane.kind === "global"
      ? this.#globalQueue
      : this.#sessionQueues.get(work.lane.key);
    if (!queue) return;
    const index = queue.indexOf(work);
    if (index < 0) return;
    queue.splice(index, 1);
    this.#queued = Math.max(0, this.#queued - 1);
    this.#operations.delete(work.operation.operationId);
    if (work.lane.kind === "session" && queue.length === 0) {
      this.#removeSessionQueue(work.lane.key);
    } else if (work.lane.kind === "global") {
      this.#removeGlobalKeyIfEmpty(work.lane.key ?? "__anonymous__");
    }
  }

  #releaseAdmission(work: ScheduledWork<unknown>): void {
    const key = work.lane.key;
    if (key === null) return;
    const remaining = Math.max(0, (this.#sessionLoad.get(key) ?? 1) - 1);
    if (remaining === 0) this.#sessionLoad.delete(key);
    else this.#sessionLoad.set(key, remaining);
  }

  #removeGlobalKeyIfEmpty(key: string): void {
    const remains = this.#globalQueue.some(
      (work) => (work.lane.key ?? "__anonymous__") === key
    );
    if (remains) return;
    const index = this.#globalRoundRobin.indexOf(key);
    if (index < 0) return;
    this.#globalRoundRobin.splice(index, 1);
    if (this.#globalRoundRobin.length === 0) {
      this.#globalRoundRobinIndex = 0;
    } else if (index < this.#globalRoundRobinIndex) {
      this.#globalRoundRobinIndex -= 1;
    } else {
      this.#globalRoundRobinIndex %= this.#globalRoundRobin.length;
    }
  }

  #removeSessionQueue(key: string): void {
    this.#sessionQueues.delete(key);
    const index = this.#roundRobin.indexOf(key);
    if (index < 0) return;
    this.#roundRobin.splice(index, 1);
    if (this.#roundRobin.length === 0) {
      this.#roundRobinIndex = 0;
    } else if (index < this.#roundRobinIndex) {
      this.#roundRobinIndex -= 1;
    } else {
      this.#roundRobinIndex %= this.#roundRobin.length;
    }
  }

  #globalWorkEligible(work: ScheduledWork<unknown>): boolean {
    if (this.#hasEarlierSessionWork(work.sequence)) return false;
    const key = work.lane.key ?? "__anonymous__";
    return !this.#globalQueue.some(
      (candidate) =>
        candidate.sequence < work.sequence
        && (candidate.lane.key ?? "__anonymous__") === key
    );
  }

  #nextEligibleGlobalWork(): ScheduledWork<unknown> | null {
    if (this.#options.maxConcurrency === 1) {
      const work = this.#globalQueue[0];
      return work && this.#globalWorkEligible(work) ? work : null;
    }
    const count = this.#globalRoundRobin.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.#globalRoundRobinIndex + offset) % count;
      const key = this.#globalRoundRobin[index];
      if (key === undefined) continue;
      const work = this.#globalQueue.find(
        (candidate) => (candidate.lane.key ?? "__anonymous__") === key
      );
      if (!work || !this.#globalWorkEligible(work)) continue;
      this.#globalRoundRobinIndex = (index + 1) % count;
      return work;
    }
    return null;
  }

  #hasEarlierSessionWork(sequence: number): boolean {
    for (const queue of this.#sessionQueues.values()) {
      if ((queue[0]?.sequence ?? Number.POSITIVE_INFINITY) < sequence) return true;
    }
    return false;
  }

  #resourcesAvailable(work: ScheduledWork<unknown>): boolean {
    return work.lane.resources.every((resource) => !this.#activeResources.has(resource));
  }

  #nextSessionWork(barrier: number): ScheduledWork<unknown> | null {
    if (this.#options.maxConcurrency === 1) {
      let earliest: ScheduledWork<unknown> | null = null;
      for (const [key, queue] of this.#sessionQueues) {
        const work = queue[0];
        if (
          !work
          || this.#activeSessions.has(key)
          || work.sequence > barrier
          || !this.#resourcesAvailable(work)
        ) continue;
        if (!earliest || work.sequence < earliest.sequence) earliest = work;
      }
      return earliest;
    }
    const count = this.#roundRobin.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.#roundRobinIndex + offset) % count;
      const key = this.#roundRobin[index];
      if (key === undefined) continue;
      const work = this.#sessionQueues.get(key)?.[0];
      if (
        !work
        || this.#activeSessions.has(key)
        || work.sequence > barrier
        || !this.#resourcesAvailable(work)
      ) continue;
      this.#roundRobinIndex = count === 0 ? 0 : (index + 1) % count;
      return work;
    }
    return null;
  }

  #pump(): void {
    if (this.#stopped || this.#globalActive) return;
    if (this.#active === 0) {
      const global = this.#nextEligibleGlobalWork();
      if (global) {
        this.#start(global);
        return;
      }
    }
    const global = this.#globalQueue[0];
    const barrier = global?.sequence ?? Number.POSITIVE_INFINITY;
    while (this.#active < this.#options.maxConcurrency) {
      const next = this.#nextSessionWork(barrier);
      if (!next) break;
      this.#start(next);
    }
  }

  #start(work: ScheduledWork<unknown>): void {
    this.#removeQueued(work);
    work.active = true;
    if (work.expiry) clearTimeout(work.expiry);
    this.#operations.set(work.operation.operationId, work);
    this.#active += 1;
    this.#maxObservedActive = Math.max(this.#maxObservedActive, this.#active);
    if (work.lane.kind === "global") this.#globalActive = true;
    if (work.lane.kind === "session") this.#activeSessions.add(work.lane.key);
    for (const resource of work.lane.resources) this.#activeResources.add(resource);
    work.onWait?.(performance.now() - work.queuedAt);

    Promise.resolve()
      .then(() => {
        if (work.cancelled) {
          throw cancelledBeforeEffect("cancelled before scheduler dispatch");
        }
        if (Date.now() >= work.operation.deadlineAt) {
          throw notStarted("deadline expired before scheduler dispatch");
        }
        return work.run();
      })
      .then(work.resolve, work.reject)
      .finally(() => {
        work.settled = true;
        this.#operations.delete(work.operation.operationId);
        this.#releaseAdmission(work);
        this.#active = Math.max(0, this.#active - 1);
        if (work.lane.kind === "global") this.#globalActive = false;
        if (work.lane.kind === "session") this.#activeSessions.delete(work.lane.key);
        for (const resource of work.lane.resources) this.#activeResources.delete(resource);
        this.#pump();
      });
  }
}
