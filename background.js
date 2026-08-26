const SWITCHER_URL = chrome.runtime.getURL("switcher.html");
const SWITCHER_MIN_WIDTH = 760;
const SWITCHER_MAX_WIDTH = 1800;
const SWITCHER_MAX_HEIGHT = 1200;
const FALLBACK_WINDOW_FRAME_HEIGHT = 78;
const TAB_ITEM_WIDTH = 152;
const TAB_ITEM_GAP = 10;
const SHELL_VERTICAL_PADDING = 20;
const SEARCH_HEIGHT = 42;
const CONTENT_TOP_PADDING = 12;
const WINDOW_ROW_HEIGHT = 130;
const WINDOW_ROW_GAP = 7;
const FOOTER_MARGIN_TOP = 4;
const FOOTER_HEIGHT = 19;
const DEFAULT_VISIBLE_WINDOWS = 7;
const SWITCHER_MIN_HEIGHT = 260;
const SMALL_WINDOW_TAB_LIMIT = 5;
const MERGED_ROW_TAB_LIMIT = 10;
const RECENT_TAB_LIMIT = 4;
const VISIBLE_WINDOW_TYPES = new Set(["normal", "popup", "app", "panel"]);
const SWITCHER_SESSION_STATE_KEYS = [
  "switcherWindowId",
  "sourceWindowId",
  "sourceTabId"
];
const SESSION_STATE_KEYS = [
  ...SWITCHER_SESSION_STATE_KEYS,
  "recentTabIds"
];
const TABS_CHANGED_DEBOUNCE_MS = 100;

let switcherWindowId = null;
let sourceWindowId = null;
let sourceTabId = null;
let recentTabIds = [];
let sessionStateLoaded = false;
let sessionStateLoadPromise = null;
let sessionStateWritePromise = Promise.resolve();
let switcherWindowStateResolved = false;
let openSwitcherPromise = null;
let tabsChangedTimer = null;
let resizeRequest = null;
let resizeInFlight = false;

function localizedMessage(name, substitutions = [], fallback = "") {
  const message = chrome.i18n?.getMessage?.(name, substitutions);
  return message || fallback;
}

async function loadSessionState() {
  if (sessionStateLoaded) return;
  if (!sessionStateLoadPromise) {
    sessionStateLoadPromise = (async () => {
      if (!chrome.storage?.session) return;
      const state = await chrome.storage.session.get(SESSION_STATE_KEYS)
        .catch(() => null);
      if (!state) return;

      if (Number.isInteger(state.switcherWindowId)) {
        switcherWindowId = state.switcherWindowId;
      }
      if (Number.isInteger(state.sourceWindowId)) {
        sourceWindowId = state.sourceWindowId;
      }
      if (Number.isInteger(state.sourceTabId)) {
        sourceTabId = state.sourceTabId;
      }
      if (Array.isArray(state.recentTabIds)) {
        recentTabIds = state.recentTabIds
          .filter((tabId) => Number.isInteger(tabId))
          .filter((tabId, index, tabIds) => tabIds.indexOf(tabId) === index)
          .slice(0, RECENT_TAB_LIMIT);
      }
    })().finally(() => {
      sessionStateLoaded = true;
      sessionStateLoadPromise = null;
    });
  }
  await sessionStateLoadPromise;
}

async function saveSessionState() {
  if (!chrome.storage?.session) return;
  const state = {
    switcherWindowId,
    sourceWindowId,
    sourceTabId,
    recentTabIds
  };
  sessionStateWritePromise = sessionStateWritePromise
    .catch(() => {})
    .then(() => chrome.storage.session.set(state));
  await sessionStateWritePromise.catch(() => {});
}

async function clearSessionState() {
  if (!chrome.storage?.session) return;
  sessionStateWritePromise = sessionStateWritePromise
    .catch(() => {})
    .then(() => chrome.storage.session.remove(SWITCHER_SESSION_STATE_KEYS));
  await sessionStateWritePromise.catch(() => {});
}

function tabUrl(tab) {
  return tab?.url || tab?.pendingUrl || "";
}

function isExtensionPage(url = "") {
  return url.startsWith(chrome.runtime.getURL(""));
}

function isSwitcherPage(url = "") {
  return url === SWITCHER_URL
    || url.startsWith(`${SWITCHER_URL}?`)
    || url.startsWith(`${SWITCHER_URL}#`);
}

function isSwitcherWindow(window) {
  return window.type === "popup"
    && (window.tabs || []).some((tab) => isSwitcherPage(tabUrl(tab)));
}

async function findSwitcherWindowIds() {
  const allWindows = await chrome.windows.getAll({ populate: true });
  switcherWindowStateResolved = true;
  return allWindows
    .filter(isSwitcherWindow)
    .map((window) => window.id)
    .filter((windowId) => Number.isInteger(windowId));
}

async function getSwitcherWindowId() {
  await loadSessionState();

  if (Number.isInteger(switcherWindowId)) {
    const current = await chrome.windows.get(switcherWindowId, { populate: true })
      .catch(() => null);
    if (current && isSwitcherWindow(current)) return switcherWindowId;
    switcherWindowId = null;
  }

  if (switcherWindowStateResolved) return null;
  const windowIds = await findSwitcherWindowIds().catch(() => []);
  switcherWindowId = windowIds[0] ?? null;
  if (switcherWindowId === null) {
    sourceWindowId = null;
    sourceTabId = null;
    await clearSessionState();
  } else {
    await saveSessionState();
  }
  return switcherWindowId;
}

async function sendToSwitcher(message) {
  const windowId = await getSwitcherWindowId();
  if (windowId === null) return;
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function closeSwitcherWindow() {
  const windowIds = new Set();
  if (Number.isInteger(switcherWindowId)) windowIds.add(switcherWindowId);
  switcherWindowId = null;
  switcherWindowStateResolved = true;

  const discoveredWindowIds = await findSwitcherWindowIds().catch(() => []);
  discoveredWindowIds.forEach((windowId) => windowIds.add(windowId));

  await Promise.all([...windowIds].map((windowId) =>
    chrome.windows.remove(windowId).catch(() => {})
  ));

  sourceWindowId = null;
  sourceTabId = null;
  await clearSessionState();
}

function tabHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeTab(tab, windowLabel, windowId) {
  const url = tabUrl(tab);
  const recentIndex = recentTabIds.indexOf(tab.id);
  return {
    id: tab.id,
    windowId,
    index: tab.index,
    title: tab.title || url || localizedMessage("untitledTab", [], "未命名标签页"),
    url,
    host: tabHost(url),
    favIconUrl: tab.favIconUrl || "",
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    recentRank: recentIndex >= 0 ? recentIndex + 1 : 0,
    windowLabel
  };
}

function isBlankTab(tab) {
  const url = tabUrl(tab).toLowerCase();
  return [
    "",
    "about:blank",
    "chrome://newtab",
    "chrome://newtab/",
    "chrome://new-tab-page",
    "chrome://new-tab-page/"
  ].includes(url);
}

function usableWindows(allWindows) {
  return allWindows
    .filter((window) =>
      window.id !== switcherWindowId && VISIBLE_WINDOW_TYPES.has(window.type)
    )
    .filter((window) => (window.tabs || []).some((tab) =>
      tab.id !== undefined && !isExtensionPage(tabUrl(tab))
    ));
}

function tabDisplayPriority(tab) {
  if (tab.audible) return 2;
  if (recentTabIds.includes(tab.id)) return 1;
  return 0;
}

function compareTabs(first, second) {
  const priorityDifference = tabDisplayPriority(second)
    - tabDisplayPriority(first);
  if (priorityDifference !== 0) return priorityDifference;

  const firstRecentIndex = recentTabIds.indexOf(first.id);
  const secondRecentIndex = recentTabIds.indexOf(second.id);
  if (firstRecentIndex >= 0 || secondRecentIndex >= 0) {
    const recentIndexDifference = (firstRecentIndex < 0 ? Number.MAX_SAFE_INTEGER : firstRecentIndex)
      - (secondRecentIndex < 0 ? Number.MAX_SAFE_INTEGER : secondRecentIndex);
    if (recentIndexDifference !== 0) return recentIndexDifference;
  }

  return first.index - second.index;
}

function windowDisplayPriority(window) {
  return Math.max(
    0,
    ...(window.tabs || []).map(tabDisplayPriority)
  );
}

function sortWindows(allWindows) {
  return [...allWindows].sort((first, second) => {
    const displayPriorityDifference = windowDisplayPriority(second)
      - windowDisplayPriority(first);
    if (displayPriorityDifference !== 0) return displayPriorityDifference;

    const tabCountDifference = (second.tabs || []).length - (first.tabs || []).length;
    if (tabCountDifference !== 0) return tabCountDifference;
    if (first.id === sourceWindowId) return -1;
    if (second.id === sourceWindowId) return 1;
    return first.id - second.id;
  });
}

function normalizeWindows(allWindows) {
  let blankWindowIncluded = false;
  const windows = sortWindows(usableWindows(allWindows)).map((window) => {
    const rawTabs = (window.tabs || [])
      .filter((tab) => tab.id !== undefined && !isExtensionPage(tabUrl(tab)))
      .sort(compareTabs)
    const tabs = rawTabs.map((tab) => normalizeTab(tab, "", window.id));

    return {
      id: window.id,
      type: window.type,
      incognito: Boolean(window.incognito),
      tabs
    };
  }).filter((window) => {
    const isBlankOnly = window.tabs.length > 0
      && window.tabs.every((tab) => isBlankTab(tab));
    if (!isBlankOnly) return true;
    if (blankWindowIncluded) return false;
    blankWindowIncluded = true;
    return true;
  }).map((window) => {
    const isBlankOnly = window.tabs.length > 0
      && window.tabs.every((tab) => isBlankTab(tab));
    return isBlankOnly
      ? { ...window, tabs: window.tabs.slice(0, 1) }
      : window;
  });

  return windows.map((window, index) => {
    const windowLabel = localizedMessage(
      "windowLabel",
      [String(index + 1)],
      `窗口 ${index + 1}`
    );
    return {
      ...window,
      windowLabel,
      tabs: window.tabs.map((tab) => ({ ...tab, windowLabel }))
    };
  });
}

function getContentHeight(windowCount) {
  const groupGaps = Math.max(0, windowCount - 1) * WINDOW_ROW_GAP;
  const windowRows = windowCount * WINDOW_ROW_HEIGHT;
  return SHELL_VERTICAL_PADDING + SEARCH_HEIGHT + CONTENT_TOP_PADDING
    + windowRows + groupGaps + FOOTER_MARGIN_TOP + FOOTER_HEIGHT;
}

function getDisplayRowStats(windows) {
  let rowCount = 0;
  let maxTabs = 0;
  const smallWindowTabCounts = [];

  for (const window of windows) {
    if (window.tabs.length < SMALL_WINDOW_TAB_LIMIT) {
      smallWindowTabCounts.push(window.tabs.length);
      continue;
    }

    rowCount += 1;
    maxTabs = Math.max(maxTabs, window.tabs.length);
  }

  while (smallWindowTabCounts.length) {
    const firstTabCount = smallWindowTabCounts.shift();
    let rowTabCount = firstTabCount;

    while (true) {
      let candidateIndex = -1;
      let candidateTabCount = Number.POSITIVE_INFINITY;

      smallWindowTabCounts.forEach((tabCount, index) => {
        if (
          rowTabCount + tabCount < MERGED_ROW_TAB_LIMIT
          && tabCount < candidateTabCount
        ) {
          candidateIndex = index;
          candidateTabCount = tabCount;
        }
      });

      if (candidateIndex < 0) break;
      rowTabCount += smallWindowTabCounts.splice(candidateIndex, 1)[0];
    }

    rowCount += 1;
    maxTabs = Math.max(maxTabs, rowTabCount);
  }

  return {
    rowCount,
    maxTabs: Math.max(1, maxTabs)
  };
}

async function getState() {
  await getSwitcherWindowId();
  const allWindows = await chrome.windows.getAll({ populate: true });
  return {
    windows: normalizeWindows(allWindows),
    sourceWindowId,
    sourceTabId
  };
}

function getPopupSize(windows, currentWindow) {
  const displayRows = getDisplayRowStats(windows);
  const maxTabs = displayRows.maxTabs;
  const desiredWidth = Math.max(
    SWITCHER_MIN_WIDTH,
    Math.min(
      SWITCHER_MAX_WIDTH,
      100 + maxTabs * TAB_ITEM_WIDTH + Math.max(0, maxTabs - 1) * TAB_ITEM_GAP
    )
  );
  const contentHeight = getContentHeight(
    Math.min(displayRows.rowCount, DEFAULT_VISIBLE_WINDOWS)
  );
  const desiredHeight = Math.max(
    SWITCHER_MIN_HEIGHT,
    Math.min(
      SWITCHER_MAX_HEIGHT,
      contentHeight + FALLBACK_WINDOW_FRAME_HEIGHT
    )
  );

  const availableWidth = Number.isFinite(currentWindow.width)
    ? Math.max(SWITCHER_MIN_WIDTH, currentWindow.width - 40)
    : SWITCHER_MAX_WIDTH;
  return {
    width: Math.min(desiredWidth, availableWidth),
    height: desiredHeight
  };
}

async function resizeSwitcherNow(contentHeight, frameHeight) {
  if (!Number.isFinite(contentHeight)) return;

  const windowId = await getSwitcherWindowId();
  if (windowId === null) return;

  const current = await chrome.windows.get(windowId).catch(() => null);
  if (!current) return;

  const frame = Number.isFinite(frameHeight) && frameHeight > 0
    ? frameHeight
    : FALLBACK_WINDOW_FRAME_HEIGHT;
  const desiredHeight = Math.max(
    SWITCHER_MIN_HEIGHT,
    Math.min(SWITCHER_MAX_HEIGHT, Math.ceil(contentHeight + frame))
  );
  if (Math.abs((current.height || 0) - desiredHeight) < 2) return;

  const nextTop = Number.isFinite(current.top)
    ? Math.round(current.top + ((current.height || desiredHeight) - desiredHeight) / 2)
    : undefined;
  await chrome.windows.update(windowId, {
    height: desiredHeight,
    ...(nextTop === undefined ? {} : { top: nextTop })
  }).catch(() => {});
}

function requestSwitcherResize(contentHeight, frameHeight) {
  resizeRequest = { contentHeight, frameHeight };
  if (resizeInFlight) return;

  resizeInFlight = true;
  (async () => {
    try {
      while (resizeRequest) {
        const request = resizeRequest;
        resizeRequest = null;
        await resizeSwitcherNow(request.contentHeight, request.frameHeight);
      }
    } finally {
      resizeInFlight = false;
      if (resizeRequest) {
        const request = resizeRequest;
        resizeRequest = null;
        requestSwitcherResize(request.contentHeight, request.frameHeight);
      }
    }
  })().catch(() => {});
}

async function toggleSwitcherInternal() {
  const existingWindowIds = await findSwitcherWindowIds();
  if (existingWindowIds.length > 0) {
    switcherWindowId = existingWindowIds[0];
    await closeSwitcherWindow();
    return;
  }

  const currentWindow = await chrome.windows.getCurrent();
  sourceWindowId = currentWindow.id ?? null;

  const activeTabs = sourceWindowId === null
    ? []
    : await chrome.tabs.query({ active: true, windowId: sourceWindowId });
  sourceTabId = activeTabs[0]?.id ?? null;
  await rememberRecentTab(sourceTabId, sourceWindowId);

  const allWindows = await chrome.windows.getAll({ populate: true });
  const windows = normalizeWindows(allWindows);
  const size = getPopupSize(windows, currentWindow);
  const createOptions = {
    url: SWITCHER_URL,
    type: "popup",
    focused: true,
    width: size.width,
    height: size.height
  };

  if (
    Number.isFinite(currentWindow.left) &&
    Number.isFinite(currentWindow.top) &&
    Number.isFinite(currentWindow.width) &&
    Number.isFinite(currentWindow.height)
  ) {
    createOptions.left = Math.round(
      currentWindow.left + (currentWindow.width - size.width) / 2
    );
    createOptions.top = Math.round(
      currentWindow.top + (currentWindow.height - size.height) / 2
    );
  }

  const created = await chrome.windows.create(createOptions);
  switcherWindowId = created.id ?? null;
  switcherWindowStateResolved = true;
  await saveSessionState();
}

function toggleSwitcher() {
  if (openSwitcherPromise) return openSwitcherPromise;
  openSwitcherPromise = toggleSwitcherInternal()
    .catch(() => {})
    .finally(() => {
      openSwitcherPromise = null;
    });
  return openSwitcherPromise;
}

async function activateTab(tabId, windowId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return;

  try {
    const targetWindow = await chrome.windows.get(windowId);
    const update = { focused: true };
    if (targetWindow.state === "minimized") update.state = "normal";
    await chrome.windows.update(windowId, update);
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    return;
  }

  await closeSwitcherWindow();
}

async function closeTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await chrome.tabs.remove(tabId).catch(() => {});
}

async function rememberRecentTab(tabId, windowId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return;

  await loadSessionState();
  if (windowId === switcherWindowId) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || isExtensionPage(tabUrl(tab))) return;

  const nextRecentTabIds = [
    tabId,
    ...recentTabIds.filter((recentTabId) => recentTabId !== tabId)
  ].slice(0, RECENT_TAB_LIMIT);
  if (nextRecentTabIds.every((recentTabId, index) =>
    recentTabId === recentTabIds[index]
  )) {
    return;
  }

  recentTabIds = nextRecentTabIds;
  await saveSessionState();
  notifyTabsChanged();
}

async function removeTabFromRecent(tabId) {
  if (!Number.isInteger(tabId)) return;

  await loadSessionState();
  const nextRecentTabIds = recentTabIds.filter((recentTabId) =>
    recentTabId !== tabId
  );
  const recentChanged = nextRecentTabIds.length !== recentTabIds.length;
  if (!recentChanged) return;

  recentTabIds = nextRecentTabIds;
  await saveSessionState();
  notifyTabsChanged();
}

function notifyTabsChanged() {
  if (tabsChangedTimer !== null) return;
  tabsChangedTimer = setTimeout(() => {
    tabsChangedTimer = null;
    sendToSwitcher({ type: "TABS_CHANGED" });
  }, TABS_CHANGED_DEBOUNCE_MS);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-tab-switcher") toggleSwitcher();
});

chrome.action.onClicked.addListener(() => toggleSwitcher());

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  rememberRecentTab(tabId, windowId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    getState()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ACTIVATE_TAB") {
    activateTab(message.tabId, message.windowId);
    return false;
  }

  if (message?.type === "CLOSE_TAB") {
    closeTab(message.tabId);
    return false;
  }

  if (message?.type === "CLOSE_SWITCHER") {
    closeSwitcherWindow();
    return false;
  }

  if (message?.type === "RESIZE_SWITCHER") {
    requestSwitcherResize(message.contentHeight, message.frameHeight);
    return false;
  }

  return false;
});

chrome.tabs.onCreated.addListener(notifyTabsChanged);
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabFromRecent(tabId);
  notifyTabsChanged();
});
chrome.tabs.onMoved.addListener(notifyTabsChanged);
chrome.tabs.onAttached.addListener(notifyTabsChanged);
chrome.tabs.onDetached.addListener(notifyTabsChanged);
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  removeTabFromRecent(removedTabId);
  notifyTabsChanged();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (["title", "url", "favIconUrl", "audible", "pinned"].some((key) =>
    key in changeInfo
  )) {
    notifyTabsChanged();
  }
});

chrome.windows.onCreated.addListener(notifyTabsChanged);

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === switcherWindowId) {
    switcherWindowId = null;
    switcherWindowStateResolved = true;
    sourceWindowId = null;
    sourceTabId = null;
    clearSessionState();
  }
  notifyTabsChanged();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const activeSwitcherWindowId = switcherWindowId === null
    && !switcherWindowStateResolved
    ? await getSwitcherWindowId()
    : switcherWindowId;

  if (activeSwitcherWindowId !== null && windowId !== activeSwitcherWindowId) {
    closeSwitcherWindow();
  }
});
