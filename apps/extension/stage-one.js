(function installStageOneHelpers(root) {
  const MAX_DOWNLOAD_RECORDS = 200;

  function ownershipError(message) {
    const error = new Error(message);
    error.name = "OwnershipError";
    return error;
  }

  function requireSessionId(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) {
      throw ownershipError("A session is required for download ownership");
    }
  }

  function ownedDownloadRecords(value) {
    // Pre-stage-one numeric IDs and malformed records remain unowned.
    return Array.isArray(value) ? value.filter((entry) =>
      entry && typeof entry === "object"
      && typeof entry.sessionId === "string" && entry.sessionId.length > 0
      && (
        (Number.isInteger(entry.downloadId) && entry.downloadId >= 0
          && entry.reservationId === undefined)
        || (typeof entry.reservationId === "string" && entry.reservationId.length > 0
          && entry.downloadId === undefined)
      )
    ) : [];
  }

  function reserveDownload(value, reservationId, sessionId) {
    requireSessionId(sessionId);
    const stored = Array.isArray(value) ? [...value] : [];
    const records = ownedDownloadRecords(value);
    if (typeof reservationId !== "string" || !reservationId
      || records.some((entry) => entry.reservationId === reservationId)) {
      throw ownershipError("A unique download ownership reservation is required");
    }
    if (records.length >= MAX_DOWNLOAD_RECORDS) {
      throw ownershipError("Download ownership capacity is exhausted");
    }
    return [...stored, { reservationId, sessionId }];
  }

  function fulfillDownloadReservation(value, reservationId, downloadId, sessionId) {
    requireSessionId(sessionId);
    const stored = Array.isArray(value) ? [...value] : [];
    const records = ownedDownloadRecords(value);
    const reservationIndex = stored.findIndex((entry) =>
      entry && typeof entry === "object"
      && entry.reservationId === reservationId && entry.sessionId === sessionId
      && entry.downloadId === undefined);
    if (reservationIndex === -1
      || !Number.isInteger(downloadId) || downloadId < 0
      || (Array.isArray(value) && value.includes(downloadId))
      || records.some((entry) => entry.downloadId === downloadId)) {
      throw ownershipError("Cannot fulfill an absent or conflicting download reservation");
    }
    const fulfilled = [...stored];
    fulfilled[reservationIndex] = { downloadId, sessionId };
    return fulfilled;
  }

  function rollbackDownloadReservation(value, reservationId, sessionId) {
    requireSessionId(sessionId);
    return (Array.isArray(value) ? value : []).filter((entry) =>
      !(entry && typeof entry === "object"
        && entry.reservationId === reservationId
        && entry.sessionId === sessionId
        && entry.downloadId === undefined));
  }

  function releaseSessionDownloads(value, sessionId) {
    requireSessionId(sessionId);
    return (Array.isArray(value) ? value : []).filter((entry) =>
      !(entry && typeof entry === "object" && entry.sessionId === sessionId));
  }

  function downloadIdsForSession(value, sessionId) {
    requireSessionId(sessionId);
    return ownedDownloadRecords(value)
      .filter((entry) =>
        entry.sessionId === sessionId && Number.isInteger(entry.downloadId))
      .map((entry) => entry.downloadId);
  }

  function forgetDownloadForSession(value, downloadId, sessionId) {
    requireSessionId(sessionId);
    return (Array.isArray(value) ? value : []).filter((entry) =>
      !(entry && typeof entry === "object"
        && entry.downloadId === downloadId && entry.sessionId === sessionId));
  }

  function locatorWaitMatches(state, snapshot, text) {
    const target = snapshot?.target;
    const textMatches = text === undefined
      || String(target?.text || target?.name || "").includes(String(text));
    const matched = (
      (state === "attached" && snapshot?.count > 0)
      || (state === "detached" && snapshot?.count === 0)
      || (state === "visible" && target?.visible)
      || (state === "hidden" && (!target || !target.visible))
      || (state === "enabled" && target?.enabled)
      || (state === "editable" && target?.editable)
      || (state === "checked" && target?.checkable === true && target.checkedState === "true")
      || (state === "unchecked" && snapshot?.count > 0
        && target?.checkable === true && target.checkedState === "false")
    );
    return Boolean(matched && textMatches);
  }

  root.TabWardStageOne = Object.freeze({
    downloadIdsForSession,
    forgetDownloadForSession,
    fulfillDownloadReservation,
    locatorWaitMatches,
    ownedDownloadRecords,
    releaseSessionDownloads,
    reserveDownload,
    rollbackDownloadReservation
  });
})(globalThis);
