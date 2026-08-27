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
const BOOKMARK_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const BOOKMARK_VISIT_DEBOUNCE_MS = 5000;
const BOOKMARK_VISIT_STATS_KEY = "bookmarkVisitStats";
const NATIVE_HOST_NAME = "com.local.chrometabswitcher.v2";
const NATIVE_REQUEST_TIMEOUT_MS = 10000;
const MAC_WINDOW_CACHE_TTL_MS = 2000;
const MAC_WINDOW_FAILURE_RETRY_MS = 5000;
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
let bookmarkVisitStats = new Map();
let bookmarkVisitStatsLoaded = false;
let bookmarkVisitStatsLoadPromise = null;
let bookmarkVisitStatsWritePromise = Promise.resolve();
let bookmarkUrlIndex = new Map();
let bookmarkUrlIndexReady = false;
let bookmarkUrlIndexLoadPromise = null;
let bookmarkVisitPromise = Promise.resolve();
const pendingBookmarkRemovals = new Set();
let switcherWindowStateResolved = false;
let openSwitcherPromise = null;
let tabsChangedTimer = null;
let resizeRequest = null;
let resizeInFlight = false;
const bookmarkFaviconCache = new Map();
const bookmarkFaviconRequests = new Map();
let nativePort = null;
let nativeRequestSequence = 0;
const nativeRequests = new Map();
let macWindowCache = null;
let macWindowRefreshPromise = null;

function localizedMessage(name, substitutions = [], fallback = "") {
  const message = chrome.i18n?.getMessage?.(name, substitutions);
  return message || fallback;
}

function isMacOS() {
  return /Macintosh|Mac OS X/u.test(navigator.userAgent || "");
}

function rejectNativeRequests(error) {
  nativeRequests.forEach(({ reject, timer }) => {
    clearTimeout(timer);
    reject(error);
  });
  nativeRequests.clear();
}

function resetNativePort(port, error = new Error("macOS native helper unavailable")) {
  if (port && nativePort !== port) {
    try {
      port.disconnect();
    } catch {
      // The port may already be disconnected.
    }
    return;
  }
  nativePort = null;
  rejectNativeRequests(error);
  if (port) {
    try {
      port.disconnect();
    } catch {
      // The port may already be disconnected.
    }
  }
}

function getNativePort() {
  if (nativePort) return nativePort;
  if (typeof chrome.runtime.connectNative !== "function") return null;

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener((message) => {
      const request = nativeRequests.get(message?.requestId);
      if (!request) return;
      nativeRequests.delete(message.requestId);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message);
      else request.reject(new Error(message.error || "macOS native helper failed"));
    });
    port.onDisconnect.addListener(() => {
      const errorMessage = chrome.runtime.lastError?.message
        || "macOS native helper disconnected";
      resetNativePort(port, new Error(errorMessage));
    });
    nativePort = port;
    return port;
  } catch {
    return null;
  }
}

function requestNative(action, payload = {}) {
  const port = getNativePort();
  if (!port) return Promise.reject(new Error("macOS native helper unavailable"));

  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${++nativeRequestSequence}`;
    const timer = setTimeout(() => {
      nativeRequests.delete(requestId);
      reject(new Error("macOS native helper timed out"));
      resetNativePort(port, new Error("macOS native helper timed out"));
    }, NATIVE_REQUEST_TIMEOUT_MS);
    nativeRequests.set(requestId, { resolve, reject, timer });

    try {
      port.postMessage({ action, requestId, ...payload });
    } catch (error) {
      clearTimeout(timer);
      nativeRequests.delete(requestId);
      resetNativePort(
        port,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  });
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

async function loadBookmarkVisitStats() {
  if (bookmarkVisitStatsLoaded) return;
  if (!bookmarkVisitStatsLoadPromise) {
    bookmarkVisitStatsLoadPromise = (async () => {
      const state = chrome.storage?.local
        ? await chrome.storage.local.get(BOOKMARK_VISIT_STATS_KEY).catch(() => null)
        : null;
      const stats = state?.[BOOKMARK_VISIT_STATS_KEY];
      if (!stats || typeof stats !== "object") return;

      bookmarkVisitStats = new Map(
        Object.entries(stats)
          .map(([bookmarkId, value]) => {
            const lastVisitedAt = Number(value?.lastVisitedAt);
            const visitCount = Number(value?.visitCount);
            if (!Number.isFinite(lastVisitedAt) || lastVisitedAt <= 0
              || !Number.isInteger(visitCount) || visitCount <= 0) {
              return null;
            }
            return [bookmarkId, { lastVisitedAt, visitCount }];
          })
          .filter(Boolean)
      );
    })().finally(() => {
      bookmarkVisitStatsLoaded = true;
      bookmarkVisitStatsLoadPromise = null;
    });
  }
  await bookmarkVisitStatsLoadPromise;
}

async function saveBookmarkVisitStats() {
  if (!chrome.storage?.local) return;
  const serialized = Object.fromEntries(bookmarkVisitStats);
  bookmarkVisitStatsWritePromise = bookmarkVisitStatsWritePromise
    .catch(() => {})
    .then(() => chrome.storage.local.set({
      [BOOKMARK_VISIT_STATS_KEY]: serialized
    }));
  await bookmarkVisitStatsWritePromise.catch(() => {});
}

function invalidateBookmarkUrlIndex() {
  bookmarkUrlIndex = new Map();
  bookmarkUrlIndexReady = false;
}

async function loadBookmarkUrlIndex() {
  if (bookmarkUrlIndexReady) return bookmarkUrlIndex;
  if (!bookmarkUrlIndexLoadPromise) {
    bookmarkUrlIndexLoadPromise = chrome.bookmarks.getTree()
      .catch(() => [])
      .then((bookmarkTree) => {
        const nextIndex = new Map();
        const visit = (node) => {
          if (node.url) {
            const bookmarkIds = nextIndex.get(node.url) || [];
            bookmarkIds.push(node.id);
            nextIndex.set(node.url, bookmarkIds);
            return;
          }
          (node.children || []).forEach(visit);
        };
        bookmarkTree.forEach(visit);
        bookmarkUrlIndex = nextIndex;
        bookmarkUrlIndexReady = true;
        return bookmarkUrlIndex;
      })
      .finally(() => {
        bookmarkUrlIndexLoadPromise = null;
      });
  }
  return bookmarkUrlIndexLoadPromise;
}

async function rememberBookmarkVisitInternal(url) {
  if (!url) return;

  const bookmarkIds = (await loadBookmarkUrlIndex()).get(url) || [];
  if (!bookmarkIds.length) return;

  await loadBookmarkVisitStats();
  const now = Date.now();
  let changed = false;
  bookmarkIds.forEach((bookmarkId) => {
    const previous = bookmarkVisitStats.get(bookmarkId);
    if (previous && now - previous.lastVisitedAt < BOOKMARK_VISIT_DEBOUNCE_MS) {
      return;
    }
    bookmarkVisitStats.set(bookmarkId, {
      lastVisitedAt: now,
      visitCount: (previous?.visitCount || 0) + 1
    });
    changed = true;
  });

  if (!changed) return;
  await saveBookmarkVisitStats();
  notifyTabsChanged();
}

function rememberBookmarkVisit(url) {
  bookmarkVisitPromise = bookmarkVisitPromise
    .catch(() => {})
    .then(() => rememberBookmarkVisitInternal(url));
  return bookmarkVisitPromise.catch(() => {});
}

async function rememberBookmarkVisitForTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || isExtensionPage(tabUrl(tab))) return;
  await rememberBookmarkVisit(tabUrl(tab));
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

function switcherView(window) {
  const switcherTab = (window?.tabs || []).find((tab) =>
    isSwitcherPage(tabUrl(tab))
  );
  if (!switcherTab) return "all";

  try {
    const view = new URL(tabUrl(switcherTab)).searchParams.get("view");
    return ["favorites", "apps"].includes(view) ? view : "all";
  } catch {
    return "all";
  }
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

function getMacWindowSnapshot() {
  if (!isMacOS()) {
    return {
      windows: [],
      macWindowState: {
        available: false,
        accessibilityTrusted: false,
        error: ""
      }
    };
  }

  if (!macWindowCache) {
    return {
      windows: [],
      macWindowState: null
    };
  }

  return {
    windows: macWindowCache.windows,
    macWindowState: macWindowCache.state
  };
}

function isMacWindowCacheFresh() {
  if (!macWindowCache) return false;
  const cacheTtl = macWindowCache.state?.available
    ? MAC_WINDOW_CACHE_TTL_MS
    : MAC_WINDOW_FAILURE_RETRY_MS;
  return Date.now() - macWindowCache.updatedAt < cacheTtl;
}

function refreshMacWindows() {
  if (!isMacOS() || macWindowRefreshPromise || isMacWindowCacheFresh()) {
    return macWindowRefreshPromise || Promise.resolve();
  }

  macWindowRefreshPromise = requestNative("list_windows")
    .then((result) => ({
      windows: result.windows || [],
      state: {
        available: true,
        accessibilityTrusted: result.accessibilityTrusted !== false,
        error: ""
      }
    }))
    .catch((error) => ({
      windows: macWindowCache?.windows || [],
      state: {
        available: false,
        accessibilityTrusted: false,
        error: error.message || ""
      }
    }))
    .then((snapshot) => {
      const notificationKey = JSON.stringify({
        windows: snapshot.windows,
        state: snapshot.state
      });
      const shouldNotify = macWindowCache?.notificationKey !== notificationKey;
      macWindowCache = {
        ...snapshot,
        notificationKey,
        updatedAt: Date.now()
      };
      if (!shouldNotify) return;
      return sendToSwitcher({
        type: "MAC_WINDOWS_UPDATED",
        windows: normalizeMacWindows(snapshot.windows),
        macWindowState: snapshot.state
      });
    })
    .catch(() => {})
    .finally(() => {
      macWindowRefreshPromise = null;
    });

  return macWindowRefreshPromise;
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
      kind: "chrome",
      category: "chrome",
      appName: "Chrome",
      windowLabel,
      tabs: window.tabs.map((tab) => ({ ...tab, windowLabel }))
    };
  });
}

function normalizeMacWindows(macWindows = []) {
  const groups = new Map();

  macWindows.forEach((window) => {
    const groupKey = window.bundleIdentifier || window.appName || `pid-${window.pid}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: `mac-app-${groupKey}`,
        kind: "mac",
        category: "mac",
        appName: window.appName || "macOS",
        windowLabel: window.appName || "macOS",
        tabs: []
      });
    }

    const nativeTitle = window.title || window.appName || localizedMessage(
      "untitledMacWindow",
      [],
      "未命名窗口"
    );
    groups.get(groupKey).tabs.push({
      id: window.id,
      kind: "mac-window",
      isMacWindow: true,
      windowId: window.id,
      windowNumber: window.windowNumber,
      pid: window.pid,
      appName: window.appName || "macOS",
      bundleIdentifier: window.bundleIdentifier || "",
      iconDataUrl: window.iconDataUrl || "",
      nativeTitle,
      title: nativeTitle,
      url: "",
      host: "",
      favIconUrl: "",
      pinned: false,
      audible: false,
      recentRank: 0,
      windowLabel: window.appName || "macOS",
      bounds: window.bounds,
      isOnScreen: Boolean(window.isOnScreen),
      isActive: Boolean(window.isActive)
    });
  });

  return [...groups.values()]
    .map((group) => {
      const tabs = group.tabs
        .sort((first, second) =>
          Number(second.isActive) - Number(first.isActive)
          || Number(second.isOnScreen) - Number(first.isOnScreen)
          || first.title.localeCompare(second.title)
        );
      const titleCounts = new Map();
      tabs.forEach((tab) => {
        titleCounts.set(
          tab.nativeTitle,
          (titleCounts.get(tab.nativeTitle) || 0) + 1
        );
      });
      const titleOccurrences = new Map();
      return {
        ...group,
        tabs: tabs.map((tab) => {
          if ((titleCounts.get(tab.nativeTitle) || 0) < 2) return tab;

          const sameTitleOrdinal = (titleOccurrences.get(tab.nativeTitle) || 0) + 1;
          titleOccurrences.set(tab.nativeTitle, sameTitleOrdinal);
          const suffix = localizedMessage(
            "macWindowDuplicateSuffix",
            [String(sameTitleOrdinal)],
            `(窗口 ${sameTitleOrdinal})`
          );
          return {
            ...tab,
            title: `${tab.nativeTitle} ${suffix}`
          };
        })
      };
    })
    .sort((first, second) => {
      const firstActive = first.tabs.some((tab) => tab.isActive);
      const secondActive = second.tabs.some((tab) => tab.isActive);
      if (firstActive !== secondActive) return secondActive - firstActive;
      return first.appName.localeCompare(second.appName);
    });
}

function isGarbledBookmarkName(name = "") {
  const text = String(name).trim();
  if (!text) return true;

  // Replacement/control characters and repeated Latin-1 markers are common
  // signs of a bookmark title decoded with the wrong character encoding.
  if (/[\u0000-\u001F\u007F-\u009F\uFFFD?？]/u.test(text)) return true;
  const mojibakeMarkers = text.match(/[ÃÂâäæåçèéïð]/gu) || [];
  return mojibakeMarkers.length >= 2 || /(?:Ã.|Â.)/u.test(text);
}

function bookmarkFolderLabel(folderNames) {
  const lastName = folderNames.at(-1) || "";
  return isGarbledBookmarkName(lastName) ? "" : lastName.trim();
}

function compareBookmarkTabs(first, second) {
  const lastVisitedDifference = (second.bookmarkLastVisitedAt || 0)
    - (first.bookmarkLastVisitedAt || 0);
  if (lastVisitedDifference !== 0) return lastVisitedDifference;

  const visitCountDifference = (second.bookmarkVisitCount || 0)
    - (first.bookmarkVisitCount || 0);
  if (visitCountDifference !== 0) return visitCountDifference;
  return first.index - second.index;
}

function normalizeBookmarkGroups(bookmarkTree, faviconByUrl = new Map()) {
  const groups = new Map();

  function visit(node, folderNames = [], folderIds = []) {
    if (node.url) {
      const groupKey = folderIds.join("/") || "uncategorized";
      const label = bookmarkFolderLabel(folderNames)
        || (folderNames.length === 0
          ? localizedMessage("uncategorizedBookmarks", [], "未分类")
          : "");
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          id: `bookmark-folder-${groupKey}`,
          label,
          tabs: []
        });
      }

      const url = tabUrl(node);
      const visitStats = bookmarkVisitStats.get(node.id);
      groups.get(groupKey).tabs.push({
        id: `bookmark-${node.id}`,
        bookmarkId: node.id,
        isBookmark: true,
        windowId: null,
        index: groups.get(groupKey).tabs.length,
        title: node.title || url || localizedMessage(
          "untitledTab",
          [],
          "未命名标签页"
        ),
        url,
        host: tabHost(url),
        // Bookmarks do not include favicon data. Reuse a favicon from an
        // already-open tab when the URL is currently available.
        favIconUrl: faviconByUrl.get(url) || "",
        pinned: false,
        audible: false,
        recentRank: 0,
        bookmarkRecentRank: 0,
        bookmarkLastVisitedAt: visitStats?.lastVisitedAt || 0,
        bookmarkVisitCount: visitStats?.visitCount || 0,
        windowLabel: label
      });
      return;
    }

    const nextFolderNames = node.id === "0"
      ? folderNames
      : [...folderNames, node.title || localizedMessage(
        "untitledBookmarkFolder",
        [],
        "未命名文件夹"
      )];
    const nextFolderIds = node.id === "0"
      ? folderIds
      : [...folderIds, node.id];
    (node.children || []).forEach((child) =>
      visit(child, nextFolderNames, nextFolderIds)
    );
  }

  (bookmarkTree || []).forEach((root) => visit(root));
  const recentBookmarkTabs = [...groups.values()]
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.bookmarkLastVisitedAt
      && Date.now() - tab.bookmarkLastVisitedAt <= BOOKMARK_RECENT_WINDOW_MS)
    .sort(compareBookmarkTabs);
  const recentRankByBookmarkId = new Map(
    recentBookmarkTabs.map((tab, index) => [tab.bookmarkId, index + 1])
  );

  return [...groups.values()].map((group) => ({
    ...group,
    tabs: [...group.tabs]
      .sort(compareBookmarkTabs)
      .map((tab) => ({
        ...tab,
        bookmarkRecentRank: recentRankByBookmarkId.get(tab.bookmarkId) || 0
      }))
  }));
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
  const [allWindows, bookmarkTree] = await Promise.all([
    chrome.windows.getAll({ populate: true }),
    chrome.bookmarks.getTree().catch(() => [])
  ]);
  await loadBookmarkVisitStats();
  const {
    windows: macWindows,
    macWindowState
  } = getMacWindowSnapshot();
  const faviconByUrl = new Map();
  allWindows.flatMap((window) => window.tabs || []).forEach((tab) => {
    const url = tabUrl(tab);
    if (url && tab.favIconUrl && !faviconByUrl.has(url)) {
      faviconByUrl.set(url, tab.favIconUrl);
    }
  });
  return {
    windows: [
      ...normalizeWindows(allWindows),
      ...normalizeMacWindows(macWindows)
    ],
    bookmarkGroups: normalizeBookmarkGroups(bookmarkTree, faviconByUrl),
    sourceWindowId,
    sourceTabId,
    macWindowState
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

async function toggleSwitcherInternal({
  favoritesOnly = false,
  nativeAppsOnly = false,
  view = ""
} = {}) {
  const requestedView = view || (nativeAppsOnly
    ? "apps"
    : (favoritesOnly ? "favorites" : "all"));
  const existingWindowIds = await findSwitcherWindowIds();
  if (existingWindowIds.length > 0) {
    switcherWindowId = existingWindowIds[0];
    const existingWindow = await chrome.windows.get(switcherWindowId, {
      populate: true
    }).catch(() => null);
    const currentView = switcherView(existingWindow);
    if (requestedView !== "all" || currentView !== "all") {
      await chrome.windows.update(switcherWindowId, { focused: true })
        .catch(() => {});
      chrome.runtime.sendMessage({
        type: "SET_VIEW",
        view: requestedView
      }).catch(() => {});
      return;
    }
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
    url: requestedView === "all"
      ? SWITCHER_URL
      : `${SWITCHER_URL}?view=${requestedView}`,
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

function toggleSwitcher(options = {}) {
  if (openSwitcherPromise) return openSwitcherPromise;
  openSwitcherPromise = toggleSwitcherInternal(options)
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

function bookmarkFaviconUrl(url = "") {
  try {
    const parsedUrl = new URL(url);
    if (!/^https?:$/.test(parsedUrl.protocol)) return "";
    return new URL("/favicon.ico", parsedUrl.origin).toString();
  } catch {
    return "";
  }
}

async function fetchBookmarkFavicon(url) {
  const faviconUrl = bookmarkFaviconUrl(url);
  if (!faviconUrl) return "";

  try {
    const response = await fetch(faviconUrl, {
      credentials: "omit",
      cache: "force-cache",
      redirect: "follow"
    });
    if (!response.ok) return "";

    const blob = await response.blob();
    if (!blob.size) return "";
    const contentType = response.headers.get("content-type") || blob.type;
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      return "";
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) {
      binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    }
    const mimeType = contentType || "image/x-icon";
    return `data:${mimeType};base64,${btoa(binary)}`;
  } catch {
    return "";
  }
}

function getBookmarkFavicon(url) {
  if (bookmarkFaviconCache.has(url)) {
    return Promise.resolve(bookmarkFaviconCache.get(url));
  }
  if (bookmarkFaviconRequests.has(url)) {
    return bookmarkFaviconRequests.get(url);
  }

  const request = fetchBookmarkFavicon(url)
    .then((faviconUrl) => {
      bookmarkFaviconCache.set(url, faviconUrl);
      return faviconUrl;
    })
    .finally(() => {
      bookmarkFaviconRequests.delete(url);
    });
  bookmarkFaviconRequests.set(url, request);
  return request;
}

async function openBookmark(url) {
  if (!url) return;

  // The click itself is a visit, even when the page is already open or the
  // target has to be opened in a new tab.
  rememberBookmarkVisit(url);

  const allWindows = await chrome.windows.getAll({ populate: true });
  const matchingTab = allWindows
    .filter((window) => window.id !== switcherWindowId)
    .flatMap((window) => window.tabs || [])
    .find((tab) => tabUrl(tab) === url && !isExtensionPage(tabUrl(tab)));

  if (matchingTab) {
    await activateTab(matchingTab.id, matchingTab.windowId);
    return;
  }

  const targetWindow = allWindows.find((window) =>
    window.id === sourceWindowId
    && window.id !== switcherWindowId
    && VISIBLE_WINDOW_TYPES.has(window.type)
  ) || allWindows.find((window) =>
    window.id !== switcherWindowId
    && VISIBLE_WINDOW_TYPES.has(window.type)
  );

  let opened = false;
  if (targetWindow?.id !== undefined) {
    const createdTab = await chrome.tabs.create({
      windowId: targetWindow.id,
      url,
      active: true
    }).catch(() => null);
    if (createdTab) {
      opened = true;
      await chrome.windows.update(targetWindow.id, { focused: true })
        .catch(() => {});
    }
  }
  if (!opened) {
    await chrome.windows.create({ url, focused: true }).catch(() => {});
  }

  await closeSwitcherWindow();
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
  if (command === "open-favorites") toggleSwitcher({ favoritesOnly: true });
  if (command === "open-native-apps") toggleSwitcher({ nativeAppsOnly: true });
});

chrome.action.onClicked.addListener(() => toggleSwitcher());

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  rememberRecentTab(tabId, windowId);
  rememberBookmarkVisitForTab(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    getState()
      .then((state) => {
        sendResponse({ ok: true, ...state });
        refreshMacWindows();
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REFRESH_MAC_WINDOWS") {
    refreshMacWindows();
    return false;
  }

  if (message?.type === "ACTIVATE_TAB") {
    activateTab(message.tabId, message.windowId);
    return false;
  }

  if (message?.type === "ACTIVATE_MAC_WINDOW") {
    requestNative("activate_window", {
      pid: message.pid,
      windowNumber: message.windowNumber,
      title: message.title || "",
      bundleIdentifier: message.bundleIdentifier || "",
      bounds: message.bounds || null
    })
      .then((result) => {
        if (result.ok) closeSwitcherWindow();
      })
      .catch(() => {});
    return false;
  }

  if (message?.type === "CLOSE_TAB") {
    closeTab(message.tabId);
    return false;
  }

  if (message?.type === "OPEN_BOOKMARK") {
    openBookmark(message.url);
    return false;
  }

  if (message?.type === "REMOVE_BOOKMARK") {
    const bookmarkId = String(message.bookmarkId);
    pendingBookmarkRemovals.add(bookmarkId);
    chrome.bookmarks.remove(bookmarkId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        pendingBookmarkRemovals.delete(bookmarkId);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "GET_BOOKMARK_FAVICON") {
    getBookmarkFavicon(message.url)
      .then((faviconUrl) => sendResponse({ ok: true, faviconUrl }))
      .catch(() => sendResponse({ ok: true, faviconUrl: "" }));
    return true;
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
  if ("url" in changeInfo) rememberBookmarkVisitForTab(tabId);
  if (["title", "url", "favIconUrl", "audible", "pinned"].some((key) =>
    key in changeInfo
  )) {
    notifyTabsChanged();
  }
});

function notifyBookmarksChanged() {
  invalidateBookmarkUrlIndex();
  notifyTabsChanged();
}

chrome.bookmarks.onCreated.addListener(notifyBookmarksChanged);
chrome.bookmarks.onRemoved.addListener((bookmarkId) => {
  if (pendingBookmarkRemovals.delete(String(bookmarkId))) return;
  notifyBookmarksChanged();
});
chrome.bookmarks.onChanged.addListener(notifyBookmarksChanged);
chrome.bookmarks.onMoved.addListener(notifyBookmarksChanged);
chrome.bookmarks.onChildrenReordered.addListener(notifyBookmarksChanged);

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
