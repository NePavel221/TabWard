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
    pairingApproved: "Pairing approved. Reconnecting..."
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
    pairingApproved: "Сопряжение разрешено. Повторное подключение..."
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
  settingsNotice: document.getElementById("settings-notice")
};

let language = "en";
let latestStatus = null;

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
    const [status, settingsResult] = await Promise.all([
      chrome.runtime.sendMessage({ type: "TABWARD_STATUS" }),
      chrome.runtime.sendMessage({ type: "TABWARD_SETTINGS_GET" })
    ]);
    render(status);
    if (settingsResult?.ok !== true) {
      throw new Error(settingsResult?.error?.message || t("readSettingsError"));
    }
    elements.allowExistingTabs.checked =
      settingsResult.settings?.allowExistingTabs === true;
    elements.separateWindow.checked =
      settingsResult.settings?.openInSeparateWindow === true;
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
      result.settings?.allowExistingTabs === true;
    elements.separateWindow.checked =
      result.settings?.openInSeparateWindow === true;
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
  }
}

elements.language.addEventListener("change", async () => {
  const nextLanguage = elements.language.value === "ru" ? "ru" : "en";
  await chrome.storage.local.set({ [LANGUAGE_KEY]: nextLanguage });
  applyLanguage(nextLanguage);
});

elements.allowExistingTabs.addEventListener("change", () => {
  saveSettings({ allowExistingTabs: elements.allowExistingTabs.checked });
});

elements.separateWindow.addEventListener("change", () => {
  saveSettings({ openInSeparateWindow: elements.separateWindow.checked });
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
