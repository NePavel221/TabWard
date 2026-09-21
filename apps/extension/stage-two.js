(function installStageTwoHelpers(root) {
  const encoder = new TextEncoder();

  function byteLength(value) {
    return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
  }

  function createStateStore(adapter) {
    let tail = Promise.resolve();
    const serialize = (run) => {
      const current = tail.then(run, run);
      tail = current.then(() => undefined, () => undefined);
      return current;
    };
    return Object.freeze({
      read(defaults) {
        return adapter.get(defaults);
      },
      mutate(defaults, mutator) {
        return serialize(async () => {
          const current = await adapter.get(defaults);
          const next = mutator(structuredClone(current));
          if (next && typeof next.then === "function") {
            throw new Error("StateStore mutations must not await external work");
          }
          await adapter.set(next);
          return structuredClone(next);
        });
      }
    });
  }

  function operationContext(message) {
    if (typeof message?.operationId !== "string" || !message.operationId) {
      throw new Error("operationId is required");
    }
    if (typeof message?.fingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(message.fingerprint)) {
      throw new Error("operation fingerprint is required");
    }
    if (!Number.isFinite(message?.deadlineAt)) {
      throw new Error("absolute operation deadline is required");
    }
    const payload = message.payload || {};
    const session = payload.sessionId ? Object.freeze({
      id: String(payload.sessionId),
      name: String(payload.sessionName || "TabWard MCP"),
      mode: String(payload.sessionMode || "managed"),
      cleanQa: payload.cleanQa === true,
      expiresAt: Number(payload.sessionExpiresAt || 0) || null
    }) : null;
    return Object.freeze({
      operationId: message.operationId,
      fingerprint: message.fingerprint,
      deadlineAt: Number(message.deadlineAt),
      session
    });
  }

  function boundedAppend(entries, value, limits) {
    const maxCount = Math.max(1, Number(limits?.maxCount || 1));
    const maxBytes = Math.max(1024, Number(limits?.maxBytes || 1024));
    const current = Array.isArray(entries) ? [...entries] : [];
    current.push(value);
    let bytes = current.reduce((total, entry) => total + byteLength(entry), 0);
    let droppedCount = 0;
    let droppedBytes = 0;
    while (current.length > maxCount || bytes > maxBytes) {
      const removed = current.shift();
      const removedBytes = byteLength(removed);
      bytes -= removedBytes;
      droppedCount += 1;
      droppedBytes += removedBytes;
    }
    return {
      entries: current,
      bytes,
      truncated: droppedCount > 0,
      droppedCount,
      droppedBytes
    };
  }

  function topViewportRect(rect, frameChain, metrics) {
    const values = [
      rect?.x, rect?.y, rect?.width, rect?.height,
      metrics?.deviceScaleFactor, metrics?.pageScaleFactor
    ].map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("Frame coordinates require verified CSS metrics");
    }
    if (values[2] <= 0 || values[3] <= 0
      || values[4] <= 0 || values[5] <= 0) {
      throw new Error("Frame coordinates have invalid scale or size");
    }
    let x = values[0];
    let y = values[1];
    for (const frame of frameChain || []) {
      if (!Number.isFinite(Number(frame?.x)) || !Number.isFinite(Number(frame?.y))) {
        throw new Error("Frame chain is incomplete");
      }
      x += Number(frame.x);
      y += Number(frame.y);
    }
    // CDP Input and screenshot clips consume CSS pixels. DPR is validated but
    // intentionally not multiplied into the coordinates.
    return {
      x,
      y,
      width: values[2],
      height: values[3],
      deviceScaleFactor: values[4],
      pageScaleFactor: values[5]
    };
  }

  function frameTarget(result, requestedFrameId, expectedDocumentId) {
    if (!result || Number(result.frameId) !== Number(requestedFrameId)) {
      throw new Error("Frame target identity changed");
    }
    if (expectedDocumentId && result.documentId !== expectedDocumentId) {
      const error = new Error("Frame document was replaced");
      error.name = "StaleLocatorError";
      throw error;
    }
    return result;
  }

  function tabRemovalConfirmed(closeResult, stillPresentResult) {
    if (closeResult?.ok !== false) return true;
    return stillPresentResult?.ok === false
      && ["NotFoundError", "NoSuchTabError"].includes(stillPresentResult.error?.name);
  }

  function hasPartialEvidence(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || depth > 8) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (value.partial === true || value.complete === false || value.outputTruncated === true) {
      return true;
    }
    if (value.truncated === true) return true;
    if (value.truncated && typeof value.truncated === "object"
      && Object.values(value.truncated).some((item) =>
        item === true || hasPartialEvidence(item, depth + 1, seen))) {
      return true;
    }
    return ["result", "metadata", "completeness", "capture", "output"]
      .some((key) =>
        value[key]
        && typeof value[key] === "object"
        && hasPartialEvidence(value[key], depth + 1, seen));
  }

  function aggregateCompleteness(frames, storageTruncated = false) {
    const retainedPartial = (frames || []).some((frame) =>
      hasPartialEvidence(frame?.result));
    const truncated = storageTruncated || retainedPartial;
    return {
      truncated,
      partial: truncated,
      complete: !truncated
    };
  }

  function operationSession(context) {
    const session = context?.session?.id ? context.session : context;
    if (!session?.id) {
      const error = new Error("Immutable operation session context is required");
      error.name = "OwnershipError";
      throw error;
    }
    return session;
  }

  function assertOwnedRecord(record, context, options = {}) {
    const session = operationSession(context);
    if (!record || record.sessionId !== session.id || record.kind === "released") {
      const error = new Error("Tab is not owned by the operation session");
      error.name = "OwnershipError";
      throw error;
    }
    if (options.createdOnly === true
      && !["created", "created-child"].includes(record.kind)) {
      const error = new Error("Adopted tabs cannot be closed automatically");
      error.name = "OwnershipError";
      throw error;
    }
    return record;
  }

  function boundedNetworkBody(requestId, body, base64Encoded, maxResultBytes) {
    const source = String(body || "");
    const originalBytes = byteLength(source);
    const makeResult = (retained, truncated) => ({
      ok: true,
      requestId,
      body: retained,
      base64Encoded: base64Encoded === true,
      truncated,
      outputTruncated: truncated,
      partial: truncated,
      complete: !truncated,
      originalBytes,
      retainedBytes: byteLength(retained)
    });
    const complete = makeResult(source, false);
    const completeBytes = byteLength(complete);
    if (completeBytes <= maxResultBytes) return complete;
    let end = Math.max(
      0,
      Math.floor(source.length * Math.max(0, maxResultBytes - 4096) / completeBytes)
    );
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (base64Encoded === true) end -= end % 4;
      const bounded = makeResult(source.slice(0, end), true);
      const bytes = byteLength(bounded);
      if (bytes <= maxResultBytes) return bounded;
      end = Math.max(0, Math.floor(end * Math.max(0, maxResultBytes - 4096) / bytes));
    }
    const worstCaseChars = Math.max(0, Math.floor((maxResultBytes - 4096) / 6));
    end = Math.min(end, worstCaseChars);
    if (base64Encoded === true) end -= end % 4;
    return makeResult(source.slice(0, Math.max(0, end)), true);
  }

  function outboxReservationBytes(type) {
    if (["screenshot", "traceStop", "screencastFrame"].includes(type)) {
      return 16 * 1024 * 1024;
    }
    if ([
      "observe", "snapshot", "queryRich", "getText", "getHtml",
      "extractTables", "extractImages", "eventsPoll", "networkBody",
      "networkHar", "storage", "qa"
    ].includes(type)) {
      return 8 * 1024 * 1024;
    }
    return 1024 * 1024;
  }

  function expiredReservationIds(entries, activeOperationIds, now, ttlMs) {
    const active = new Set(activeOperationIds || []);
    return (entries || [])
      .filter((entry) =>
        entry?.status === "reserved"
        && !entry.envelope
        && !active.has(entry.operationId)
        && Number(entry.createdAt || 0) + ttlMs <= now)
      .map((entry) => entry.id);
  }

  function resultTransportSocket(currentSocket, transportState, openState) {
    return currentSocket
      && currentSocket.readyState === openState
      && transportState === "connected"
      ? currentSocket
      : null;
  }

  function clickEventPlan(doubleClick) {
    return doubleClick === true ? ["click", "click", "dblclick"] : ["click"];
  }

  function abortIsEffectUnknown(signalAborted, errorName) {
    return signalAborted === true && errorName !== "NotStarted";
  }

  function orphanReconciliationPlan(resources, now = Date.now()) {
    const releasable = [];
    const preservedTabs = [];
    for (const resource of resources || []) {
      const expired = Number.isFinite(Number(resource?.leaseExpiresAt))
        && Number(resource.leaseExpiresAt) <= now;
      if (!expired) continue;
      if (resource.type === "tab") {
        preservedTabs.push(resource.id);
      } else if (["debugger", "emulation", "interception", "clean_qa_lease"].includes(resource.type)) {
        releasable.push(resource);
      }
    }
    return { releasable, preservedTabs };
  }

  root.TabWardStageTwo = Object.freeze({
    boundedAppend,
    byteLength,
    createStateStore,
    frameTarget,
    operationContext,
    orphanReconciliationPlan,
    aggregateCompleteness,
    assertOwnedRecord,
    abortIsEffectUnknown,
    clickEventPlan,
    boundedNetworkBody,
    expiredReservationIds,
    outboxReservationBytes,
    operationSession,
    resultTransportSocket,
    tabRemovalConfirmed,
    topViewportRect
  });
})(globalThis);
