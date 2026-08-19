const elements = {
  bridge: document.getElementById("bridge"),
  extension: document.getElementById("extension"),
  details: document.getElementById("details"),
  code: document.getElementById("code"),
  pair: document.getElementById("pair"),
  revoke: document.getElementById("revoke"),
  refresh: document.getElementById("refresh"),
  allowExistingTabs: document.getElementById("allow-existing-tabs"),
  separateWindow: document.getElementById("separate-window"),
  settingsNotice: document.getElementById("settings-notice")
};

function setStatus(element, value, kind) {
  element.textContent = value;
  element.className = `status ${kind}`;
}

function render(status) {
  const connected = status?.state === "connected";
  const pairing = status?.state === "pairing_required";
  setStatus(
    elements.bridge,
    connected ? "Connected" : pairing ? "Pairing required" : "Not running",
    connected ? "ok" : pairing ? "warn" : "bad"
  );
  setStatus(elements.extension, "Loaded", "ok");

  elements.pair.hidden = !pairing;
  elements.code.hidden = !pairing;
  elements.revoke.hidden = !connected;
  elements.pair.textContent = "Approve pairing";

  if (connected) {
    elements.details.textContent = "Ready. Browser data stays on this computer.";
  } else if (pairing) {
    elements.details.textContent =
      "Enter the pairing code shown by tabward_health in Factory.";
  } else if (status?.state === "version_mismatch") {
    elements.details.textContent =
      "The extension and MCP protocol versions do not match.";
  } else {
    elements.details.textContent =
      "Start the TabWard MCP from Factory, then refresh this popup.";
  }
}

async function refresh() {
  elements.refresh.disabled = true;
  try {
    const [status, settingsResult] = await Promise.all([
      chrome.runtime.sendMessage({ type: "TABWARD_STATUS" }),
      chrome.runtime.sendMessage({ type: "TABWARD_SETTINGS_GET" })
    ]);
    render(status);
    if (settingsResult?.ok !== true) {
      throw new Error(settingsResult?.error?.message || "Could not read TabWard settings.");
    }
    elements.allowExistingTabs.checked =
      settingsResult.settings?.allowExistingTabs === true;
    elements.separateWindow.checked =
      settingsResult.settings?.openInSeparateWindow === true;
  } catch (error) {
    setStatus(elements.bridge, "Unavailable", "bad");
    setStatus(elements.extension, "Loaded", "ok");
    elements.details.textContent = error?.message || "Could not read TabWard status.";
  } finally {
    elements.refresh.disabled = false;
  }
}

async function saveSettings(patch) {
  elements.allowExistingTabs.disabled = true;
  elements.separateWindow.disabled = true;
  elements.settingsNotice.textContent = "Saving...";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "TABWARD_SETTINGS_UPDATE",
      settings: patch
    });
    if (result?.ok !== true) {
      throw new Error(result?.error?.message || "Could not save TabWard settings.");
    }
    elements.allowExistingTabs.checked =
      result.settings?.allowExistingTabs === true;
    elements.separateWindow.checked =
      result.settings?.openInSeparateWindow === true;
    const released = result.releasedAdoptedTabIds?.length || 0;
    elements.settingsNotice.textContent = released > 0
      ? `Saved. Released ${released} existing tab${released === 1 ? "" : "s"} without closing.`
      : "Saved.";
  } catch (error) {
    elements.settingsNotice.textContent = error?.message || "Could not save settings.";
    await refresh();
  } finally {
    elements.allowExistingTabs.disabled = false;
    elements.separateWindow.disabled = false;
  }
}

elements.allowExistingTabs.addEventListener("change", () => {
  saveSettings({ allowExistingTabs: elements.allowExistingTabs.checked });
});

elements.separateWindow.addEventListener("change", () => {
  saveSettings({ openInSeparateWindow: elements.separateWindow.checked });
});

elements.pair.addEventListener("click", async () => {
  const code = elements.code.value.trim();
  if (!/^\d{6}$/.test(code)) {
    elements.details.textContent = "Enter the six-digit pairing code.";
    return;
  }
  const result = await chrome.runtime.sendMessage({
    type: "TABWARD_PAIR_APPROVE",
    code
  });
  if (result?.ok !== true) {
    elements.details.textContent = result?.error?.message || "Pairing failed.";
    return;
  }
  elements.details.textContent = "Pairing approved. Reconnecting...";
  setTimeout(refresh, 750);
});

elements.revoke.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TABWARD_PAIR_REVOKE" });
  setTimeout(refresh, 250);
});

elements.refresh.addEventListener("click", refresh);
refresh();
