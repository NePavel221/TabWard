(function installStageThreeHelpers(root) {
  const GLOBAL_COMMANDS = new Set([
    "attach",
    "cdp",
    "cleanup",
    "detach",
    "executeCdp",
    "reloadExtension",
    "releaseWorkspace",
    "storage",
    "turnEnded",
    "downloadClick",
    "downloadImage",
    "cdp"
  ]);
  const SESSION_COMMANDS = new Set([
    "ping", "nameSession", "openTab", "tabs", "downloads"
  ]);
  const TAB_COMMANDS = new Set(`
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

  function classifyCommand(command) {
    const payload = command?.payload || {};
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId
      ? payload.sessionId
      : null;
    const tabId = Number.isInteger(payload.tabId) && payload.tabId > 0
      ? payload.tabId
      : null;
    if (
      !sessionId
      || payload.cleanQa === true
      || GLOBAL_COMMANDS.has(command?.type)
      || (tabId === null && !SESSION_COMMANDS.has(command?.type))
      || (tabId !== null && !TAB_COMMANDS.has(command?.type))
    ) {
      return Object.freeze({
        global: true,
        sessionKey: sessionId,
        resources: Object.freeze([])
      });
    }
    return Object.freeze({
      global: false,
      resources: Object.freeze([
        `session:${sessionId}`,
        ...(tabId === null ? [] : [`tab:${tabId}`])
      ])
    });
  }

  function createResourceGate() {
    let sequence = 0;
    let active = 0;
    let globalActive = false;
    const activeResources = new Set();
    const queue = [];

    function firstGlobalSequence() {
      return queue.find((item) => item.scope.global)?.sequence
        ?? Number.POSITIVE_INFINITY;
    }

    function start(item) {
      queue.splice(queue.indexOf(item), 1);
      active += 1;
      globalActive = item.scope.global;
      for (const resource of item.scope.resources) activeResources.add(resource);
      Promise.resolve()
        .then(item.run)
        .then(item.resolve, item.reject)
        .finally(() => {
          active = Math.max(0, active - 1);
          if (item.scope.global) globalActive = false;
          for (const resource of item.scope.resources) activeResources.delete(resource);
          pump();
        });
    }

    function pump() {
      if (globalActive) return;
      const global = queue.find((item) => item.scope.global);
      if (global && active === 0 && queue[0] === global) {
        start(global);
        return;
      }
      const barrier = firstGlobalSequence();
      for (const item of [...queue]) {
        if (item.sequence > barrier) break;
        if (item.scope.global) continue;
        if (item.scope.resources.some((resource) => activeResources.has(resource))) {
          continue;
        }
        start(item);
      }
    }

    return Object.freeze({
      run(scope, run) {
        return new Promise((resolve, reject) => {
          queue.push({
            sequence: ++sequence,
            scope,
            run,
            resolve,
            reject
          });
          pump();
        });
      },
      metrics() {
        return {
          active,
          queued: queue.length,
          globalActive,
          resources: activeResources.size
        };
      }
    });
  }

  function resourceBusy(resource, owner) {
    const error = new Error(
      `CDP resource ${resource} is already owned by operation ${owner.operationId}`
    );
    error.name = "CdpResourceBusy";
    return error;
  }

  function claimResource(owners, resource, owner) {
    const existing = owners.get(resource);
    if (existing) {
      if (
        existing.operationId === owner.operationId
        && existing.sessionId === owner.sessionId
        && existing.state === "active"
      ) {
        return { created: false, owner: existing };
      }
      throw resourceBusy(resource, existing);
    }
    const claimed = Object.freeze({ ...owner, state: "active" });
    owners.set(resource, claimed);
    return { created: true, owner: claimed };
  }

  function transitionResource(owners, resource, owner, state) {
    const existing = owners.get(resource);
    if (!existing) return {
      transitioned: false,
      owner: null,
      previousState: null
    };
    if (existing.sessionId !== owner.sessionId) {
      throw resourceBusy(resource, existing);
    }
    if (existing.state === state && existing.operationId === owner.operationId) {
      return {
        transitioned: false,
        owner: existing,
        previousState: existing.state
      };
    }
    if (existing.state !== "active" && existing.state !== state) {
      throw resourceBusy(resource, existing);
    }
    const transitioned = Object.freeze({
      ...existing,
      operationId: owner.operationId,
      state
    });
    owners.set(resource, transitioned);
    return {
      transitioned: true,
      owner: transitioned,
      previousState: existing.state
    };
  }

  function releaseResource(owners, resource, owner) {
    const existing = owners.get(resource);
    if (!existing) return false;
    if (
      existing.operationId !== owner.operationId
      || existing.sessionId !== owner.sessionId
    ) {
      throw resourceBusy(resource, existing);
    }
    owners.delete(resource);
    return true;
  }

  function completeStoppingResource(owners, resource) {
    const existing = owners.get(resource);
    if (!existing || existing.state !== "stopping") return false;
    owners.delete(resource);
    return true;
  }

  function sessionDetachDecision(resource, sessionId) {
    const owners = Array.from(resource?.owners || []);
    const belongs = resource?.attachmentSessionId === sessionId
      || resource?.tabSessionId === sessionId
      || owners.some((owner) => owner.sessionId === sessionId);
    const foreignOwners = owners.filter(
      (owner) => owner.sessionId && owner.sessionId !== sessionId
    );
    return Object.freeze({
      belongs,
      detach: belongs && foreignOwners.length === 0,
      foreignOwners: foreignOwners.length
    });
  }

  root.TabWardStageThree = Object.freeze({
    classifyCommand,
    createResourceGate,
    claimResource,
    completeStoppingResource,
    releaseResource,
    sessionDetachDecision,
    transitionResource
  });
})(globalThis);
