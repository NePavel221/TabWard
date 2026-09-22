const LANGUAGE_KEY = "uiLanguage";
const translations = {
  en: {
    localMcp: "Local MCP",
    extension: "Extension",
    browserSettings: "Browser access settings",
    language: "Language",
    languageHelp: "Your choice is saved for this extension.",
    allowExisting: "Allow access to existing tabs",
    allowExistingHelp: "Off by default. Applies only to full-profile sessions.",
    separateWindow: "Use a separate Chrome window",
    separateWindowHelp: "When off, new tabs join a TabWard group in the current window.",
    trustedUploadSites: "Trusted upload sites",
    trustedUploadSitesPlaceholder: "uploads.example.com\nfiles.example.org",
    trustedUploadSitesHelp: "One exact host per line. Wildcards are rejected. HTTPS only.",
    saveTrustedUploadSites: "Save trusted sites",
    approvalRequired: "Approval required",
    approvalCategory: "Category",
    approvalMethod: "Method",
    approvalSession: "Session",
    approvalOrigin: "Origin",
    approvalFiles: "Files",
    approvalExpires: "Expires",
    approveOnce: "Approve once",
    trustExactHost: "Trust this exact host",
    deny: "Deny",
    approvalExpired: "Expired. This notification remains visible.",
    approvalApproved: "Approved once. This notification remains visible.",
    approvalDenied: "Denied. This notification remains visible.",
    approvalCancelled: "No longer active. This notification remains visible.",
    notApplicable: "Not applicable",
    checking: "Checking...",
    connected: "Connected",
    pairingRequired: "Pairing required",
    notRunning: "Not running",
    unavailable: "Unavailable",
    loaded: "Loaded",
    readyDetails: "Ready. Browser data stays on this computer.",
    pairingDetails: "Enter the pairing code shown by tabward_health in Factory.",
    mismatchDetails: "The extension and MCP protocol versions do not match.",
    startDetails: "Start the TabWard MCP from Factory, then refresh this popup.",
    readSettingsError: "Could not read TabWard settings.",
    readStatusError: "Could not read TabWard status.",
    saving: "Saving...",
    saveSettingsError: "Could not save TabWard settings.",
    saved: "Saved.",
    releasedTabs: (count) => `Saved. Released ${count} existing tab${count === 1 ? "" : "s"} without closing.`,
    pairingPlaceholder: "6-digit code",
    approvePairing: "Approve pairing",
    revokePairing: "Revoke pairing",
    refresh: "Refresh",
    invalidCode: "Enter the six-digit pairing code.",
    pairingFailed: "Pairing failed.",
    pairingApproved: "Pairing approved. Reconnecting...",
    approvalFailed: "Approval decision failed."
  },
  ru: {
    localMcp: "Локальный MCP",
    extension: "Расширение",
    browserSettings: "Настройки доступа к браузеру",
    language: "Язык",
    languageHelp: "Выбор сохраняется для этого расширения.",
    allowExisting: "Разрешить доступ к существующим вкладкам",
    allowExistingHelp: "По умолчанию выключено. Только для full-profile сессий.",
    separateWindow: "Использовать отдельное окно Chrome",
    separateWindowHelp: "Если выключено, новые вкладки добавляются в группу TabWard в текущем окне.",
    trustedUploadSites: "Доверенные сайты загрузки",
    trustedUploadSitesPlaceholder: "uploads.example.com\nfiles.example.org",
    trustedUploadSitesHelp: "Один точный хост на строку. Шаблоны запрещены. Только HTTPS.",
    saveTrustedUploadSites: "Сохранить доверенные сайты",
    approvalRequired: "Требуется подтверждение",
    approvalCategory: "Категория",
    approvalMethod: "Метод",
    approvalSession: "Сессия",
    approvalOrigin: "Источник",
    approvalFiles: "Файлы",
    approvalExpires: "Истекает",
    approveOnce: "Разрешить один раз",
    trustExactHost: "Доверять этому точному хосту",
    deny: "Запретить",
    approvalExpired: "Срок истёк. Уведомление осталось в popup.",
    approvalApproved: "Разрешено один раз. Уведомление осталось в popup.",
    approvalDenied: "Запрещено. Уведомление осталось в popup.",
    approvalCancelled: "Запрос больше не активен. Уведомление осталось в popup.",
    notApplicable: "Не применяется",
    checking: "Проверка...",
    connected: "Подключено",
    pairingRequired: "Требуется сопряжение",
    notRunning: "Не запущено",
    unavailable: "Недоступно",
    loaded: "Загружено",
    readyDetails: "Готово. Данные браузера остаются на этом компьютере.",
    pairingDetails: "Введите код сопряжения, показанный tabward_health в Factory.",
    mismatchDetails: "Версии протокола расширения и MCP не совпадают.",
    startDetails: "Запустите TabWard MCP из Factory, затем обновите это окно.",
    readSettingsError: "Не удалось прочитать настройки TabWard.",
    readStatusError: "Не удалось прочитать состояние TabWard.",
    saving: "Сохранение...",
    saveSettingsError: "Не удалось сохранить настройки TabWard.",
    saved: "Сохранено.",
    releasedTabs: (count) => `Сохранено. Освобождено существующих вкладок без закрытия: ${count}.`,
    pairingPlaceholder: "6-значный код",
    approvePairing: "Разрешить сопряжение",
    revokePairing: "Отозвать сопряжение",
    refresh: "Обновить",
    invalidCode: "Введите шестизначный код сопряжения.",
    pairingFailed: "Сопряжение не выполнено.",
    pairingApproved: "Сопряжение разрешено. Повторное подключение...",
    approvalFailed: "Не удалось сохранить решение."
  }
};

const elements = {
  bridge: document.getElementById("bridge"),
  extension: document.getElementById("extension"),
  details: document.getElementById("details"),
  code: document.getElementById("code"),
  pair: document.getElementById("pair"),
  revoke: document.getElementById("revoke"),
  refresh: document.getElementById("refresh"),
  language: document.getElementById("language"),
  allowExistingTabs: document.getElementById("allow-existing-tabs"),
  separateWindow: document.getElementById("separate-window"),
  trustedUploadSites: document.getElementById("trusted-upload-sites"),
  saveTrustedUploadSites: document.getElementById("save-trusted-upload-sites"),
  settingsNotice: document.getElementById("settings-notice"),
  approval: document.getElementById("approval"),
  approvalRisk: document.getElementById("approval-risk"),
  approvalCategory: document.getElementById("approval-category"),
  approvalMethod: document.getElementById("approval-method"),
  approvalSession: document.getElementById("approval-session"),
  approvalOrigin: document.getElementById("approval-origin"),
  approvalFiles: document.getElementById("approval-files"),
  approvalExpires: document.getElementById("approval-expires"),
  approvalApprove: document.getElementById("approval-approve"),
  approvalTrust: document.getElementById("approval-trust"),
  approvalDeny: document.getElementById("approval-deny")
};

let language = "en";
let latestStatus = null;
let currentApproval = null;

function chromeLanguage() {
  const value = String(chrome.i18n.getUILanguage?.() || navigator.language || "en");
  return value.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function t(key, ...args) {
  const value = translations[language]?.[key] ?? translations.en[key] ?? key;
  return typeof value === "function" ? value(...args) : value;
}

function applyLanguage(nextLanguage) {
  language = nextLanguage === "ru" ? "ru" : "en";
  document.documentElement.lang = language;
  elements.language.value = language;
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
  render(latestStatus);
  renderApproval(currentApproval);
}

async function initializeLanguage() {
  const state = await chrome.storage.local.get({ [LANGUAGE_KEY]: null });
  const saved = state[LANGUAGE_KEY];
  applyLanguage(saved === "en" || saved === "ru" ? saved : chromeLanguage());
}

function setStatus(element, value, kind) {
  element.textContent = value;
  element.className = `status ${kind}`;
}

function render(status) {
  latestStatus = status;
  if (!status) {
    setStatus(elements.bridge, t("checking"), "warn");
    setStatus(elements.extension, t("checking"), "warn");
    return;
  }
  const connected = status.state === "connected";
  const pairing = status.state === "pairing_required";
  setStatus(
    elements.bridge,
    connected ? t("connected") : pairing ? t("pairingRequired") : t("notRunning"),
    connected ? "ok" : pairing ? "warn" : "bad"
  );
  setStatus(elements.extension, t("loaded"), "ok");

  elements.pair.hidden = !pairing;
  elements.code.hidden = !pairing;
  elements.revoke.hidden = !connected;

  if (connected) {
    elements.details.textContent = t("readyDetails");
  } else if (pairing) {
    elements.details.textContent = t("pairingDetails");
  } else if (status.state === "version_mismatch") {
    elements.details.textContent = t("mismatchDetails");
  } else {
    elements.details.textContent = t("startDetails");
  }
}

function renderApproval(approval) {
  currentApproval = approval || null;
  elements.approval.hidden = !currentApproval;
  if (!currentApproval) return;
  const statusMessages = {
    expired: "approvalExpired",
    approved: "approvalApproved",
    denied: "approvalDenied",
    cancelled: "approvalCancelled"
  };
  const statusMessage = statusMessages[currentApproval.status]
    ? t(statusMessages[currentApproval.status])
    : "";
  elements.approvalRisk.textContent = [
    currentApproval.riskText || "",
    statusMessage
  ].filter(Boolean).join(" ");
  elements.approvalCategory.textContent = currentApproval.riskCategory || "";
  elements.approvalMethod.textContent =
    currentApproval.method || t("notApplicable");
  elements.approvalSession.textContent = currentApproval.sessionLabel || "";
  elements.approvalOrigin.textContent = currentApproval.origin || currentApproval.host || "";
  elements.approvalFiles.textContent = currentApproval.basenames?.length
    ? currentApproval.basenames.join(", ")
    : t("notApplicable");
  elements.approvalExpires.textContent = new Date(currentApproval.expiresAt).toLocaleTimeString();
  elements.approvalTrust.hidden =
    currentApproval.actionable !== true
    || currentApproval.kind !== "upload"
    || !currentApproval.host;
  elements.approvalApprove.disabled = currentApproval.actionable !== true;
  elements.approvalDeny.disabled = currentApproval.actionable !== true;
}

async function refreshApprovals() {
  const result = await chrome.runtime.sendMessage({ type: "TABWARD_APPROVALS_GET" });
  if (result?.ok !== true) return;
  renderApproval(result.approvals?.find((approval) => approval.actionable === true) || null);
}

function localizedError(error, fallbackKey) {
  const message = String(error?.message || "");
  if (/six-digit pairing code/i.test(message)) return t("invalidCode");
  if (/pairing failed/i.test(message)) return t("pairingFailed");
  if (/read TabWard settings/i.test(message)) return t("readSettingsError");
  if (/save TabWard settings|save settings/i.test(message)) return t("saveSettingsError");
  return message || t(fallbackKey);
}

async function refresh() {
  elements.refresh.disabled = true;
  try {
    const [status, settingsResult, approvalsResult] = await Promise.all([
      chrome.runtime.sendMessage({ type: "TABWARD_STATUS" }),
      chrome.runtime.sendMessage({ type: "TABWARD_SETTINGS_GET" }),
      chrome.runtime.sendMessage({ type: "TABWARD_APPROVALS_GET" })
    ]);
    render(status);
    if (settingsResult?.ok !== true) {
      throw new Error(settingsResult?.error?.message || t("readSettingsError"));
    }
    elements.allowExistingTabs.checked =
      settingsResult.settings?.existingTabAccess === true;
    elements.separateWindow.checked =
      settingsResult.settings?.openInSeparateWindow === true;
    elements.trustedUploadSites.value =
      (settingsResult.settings?.trustedUploadSites || []).join("\n");
    renderApproval(
      approvalsResult?.approvals?.find((approval) => approval.actionable === true)
      || null
    );
  } catch (error) {
    setStatus(elements.bridge, t("unavailable"), "bad");
    setStatus(elements.extension, t("loaded"), "ok");
    elements.details.textContent = localizedError(error, "readStatusError");
  } finally {
    elements.refresh.disabled = false;
  }
}

async function saveSettings(patch) {
  elements.allowExistingTabs.disabled = true;
  elements.separateWindow.disabled = true;
  elements.trustedUploadSites.disabled = true;
  elements.saveTrustedUploadSites.disabled = true;
  elements.settingsNotice.textContent = t("saving");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "TABWARD_SETTINGS_UPDATE",
      settings: patch
    });
    if (result?.ok !== true) {
      throw new Error(result?.error?.message || t("saveSettingsError"));
    }
    elements.allowExistingTabs.checked =
      result.settings?.existingTabAccess === true;
    elements.separateWindow.checked =
      result.settings?.openInSeparateWindow === true;
    elements.trustedUploadSites.value =
      (result.settings?.trustedUploadSites || []).join("\n");
    const released = result.releasedAdoptedTabIds?.length || 0;
    elements.settingsNotice.textContent = released > 0
      ? t("releasedTabs", released)
      : t("saved");
  } catch (error) {
    elements.settingsNotice.textContent = localizedError(error, "saveSettingsError");
    await refresh();
  } finally {
    elements.allowExistingTabs.disabled = false;
    elements.separateWindow.disabled = false;
    elements.trustedUploadSites.disabled = false;
    elements.saveTrustedUploadSites.disabled = false;
  }
}

elements.language.addEventListener("change", async () => {
  const nextLanguage = elements.language.value === "ru" ? "ru" : "en";
  await chrome.storage.local.set({ [LANGUAGE_KEY]: nextLanguage });
  applyLanguage(nextLanguage);
});

elements.allowExistingTabs.addEventListener("change", () => {
  saveSettings({ existingTabAccess: elements.allowExistingTabs.checked });
});

elements.separateWindow.addEventListener("change", () => {
  saveSettings({ openInSeparateWindow: elements.separateWindow.checked });
});

elements.saveTrustedUploadSites.addEventListener("click", () => {
  const trustedUploadSites = elements.trustedUploadSites.value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  saveSettings({ trustedUploadSites });
});

async function decideApproval(decision) {
  if (!currentApproval) return;
  for (const button of [
    elements.approvalApprove,
    elements.approvalTrust,
    elements.approvalDeny
  ]) {
    button.disabled = true;
  }
  try {
    const result = await chrome.runtime.sendMessage({
      type: "TABWARD_APPROVAL_DECIDE",
      approvalId: currentApproval.approvalId,
      decision
    });
    if (result?.ok !== true) {
      throw new Error(result?.error?.message || t("approvalFailed"));
    }
    await refreshApprovals();
  } catch (error) {
    elements.settingsNotice.textContent = localizedError(error, "approvalFailed");
  } finally {
    for (const button of [
      elements.approvalApprove,
      elements.approvalTrust,
      elements.approvalDeny
    ]) {
      button.disabled = false;
    }
  }
}

elements.approvalApprove.addEventListener("click", () => decideApproval("approve_once"));
elements.approvalTrust.addEventListener("click", () => decideApproval("trust_host"));
elements.approvalDeny.addEventListener("click", () => decideApproval("deny"));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "session"
    && Object.prototype.hasOwnProperty.call(changes, PENDING_APPROVALS_KEY)
  ) {
    refreshApprovals();
  }
});

elements.pair.addEventListener("click", async () => {
  const code = elements.code.value.trim();
  if (!/^\d{6}$/.test(code)) {
    elements.details.textContent = t("invalidCode");
    return;
  }
  const result = await chrome.runtime.sendMessage({
    type: "TABWARD_PAIR_APPROVE",
    code
  });
  if (result?.ok !== true) {
    elements.details.textContent = localizedError(result?.error, "pairingFailed");
    return;
  }
  elements.details.textContent = t("pairingApproved");
  setTimeout(refresh, 750);
});

elements.revoke.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "TABWARD_PAIR_REVOKE" });
  setTimeout(refresh, 250);
});

elements.refresh.addEventListener("click", refresh);

render(null);
initializeLanguage()
  .then(refresh)
  .catch((error) => {
    applyLanguage(chromeLanguage());
    elements.details.textContent = localizedError(error, "readStatusError");
  });

setInterval(() => {
  refreshApprovals().catch(() => {});
}, 500);
