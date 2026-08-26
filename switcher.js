const appState = {
  windows: [],
  sourceTabId: null,
  selectedTabId: null,
  query: ""
};

const TAB_CARD_WIDTH = 152;
const TAB_CARD_GAP = 10;
const MERGED_WINDOW_GAP = 32;
const CARDS_HORIZONTAL_PADDING = 6;
const SMALL_WINDOW_TAB_LIMIT = 5;
const MERGED_ROW_TAB_LIMIT = 10;

// The full pinyinjs phrase dictionary is large. Keep only a small set of
// common ambiguous words that are likely to appear in browser tab titles.
const COMMON_PINYIN_PHRASES = new Map([
  ["音乐", { full: "yinyue", initials: "yy" }],
  ["银行", { full: "yinhang", initials: "yh" }],
  ["重庆", { full: "chongqing", initials: "cq" }],
  ["重复", { full: "chongfu", initials: "cf" }],
  ["重新", { full: "chongxin", initials: "cx" }],
  ["行业", { full: "hangye", initials: "hy" }],
  ["长安", { full: "changan", initials: "ca" }]
]);
const COMMON_PINYIN_PHRASES_BY_LENGTH = [...COMMON_PINYIN_PHRASES.keys()]
  .sort((first, second) => second.length - first.length);

function normalizeSearchText(text = "") {
  return text.toLocaleLowerCase().replace(/\s+/g, "");
}

function splitPinyinSegments(text = "") {
  const segments = [];
  let segmentStart = 0;
  let index = 0;

  while (index < text.length) {
    const phrase = COMMON_PINYIN_PHRASES_BY_LENGTH.find((candidate) =>
      text.startsWith(candidate, index)
    );
    if (!phrase) {
      index += 1;
      continue;
    }

    if (segmentStart < index) {
      segments.push({ text: text.slice(segmentStart, index) });
    }
    segments.push({ phrase });
    index += phrase.length;
    segmentStart = index;
  }

  if (segmentStart < text.length) {
    segments.push({ text: text.slice(segmentStart) });
  }
  return segments;
}

function toPinyin(text = "", initials = false) {
  if (!window.pinyinUtil) return text;

  return splitPinyinSegments(text).map((segment) => {
    if (segment.phrase) {
      return COMMON_PINYIN_PHRASES.get(segment.phrase)[initials ? "initials" : "full"];
    }

    const pinyin = window.pinyinUtil.getPinyin(
      segment.text,
      initials ? " " : "",
      false,
      false
    );
    if (!initials) return pinyin;
    return pinyin
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("");
  }).join("");
}

function indexTab(tab) {
  const searchableFields = [
    tab.title,
    tab.url,
    tab.host,
    tab.windowLabel,
    toPinyin(tab.title),
    toPinyin(tab.title, true)
  ];
  return {
    ...tab,
    searchText: searchableFields.map(normalizeSearchText).join("\u0000")
  };
}

const elements = {
  shell: document.querySelector(".switcher-shell"),
  search: document.querySelector("#search"),
  content: document.querySelector("#content"),
  empty: document.querySelector("#empty"),
  windowGroups: document.querySelector("#window-groups")
};

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function matchesQuery(tab) {
  const query = normalizeSearchText(appState.query);
  if (!query) return true;
  return (tab.searchText || indexTab(tab).searchText).includes(query);
}

function visibleWindowGroups() {
  return appState.windows
    .map((window) => ({
      window,
      tabs: window.tabs.filter(matchesQuery)
    }))
    .filter((group) => group.tabs.length > 0);
}

function visibleTabs() {
  return visibleWindowGroups().flatMap((group) => group.tabs);
}

function isSmallWindowGroup(group) {
  return group.tabs.length < SMALL_WINDOW_TAB_LIMIT;
}

function mergeSmallWindowRows(groups) {
  const rows = [];
  const remaining = [...groups];

  while (remaining.length) {
    const currentRow = [remaining.shift()];
    let currentTabCount = currentRow[0].tabs.length;

    while (true) {
      let candidateIndex = -1;
      let candidateTabCount = Number.POSITIVE_INFINITY;

      remaining.forEach((group, index) => {
        if (
          currentTabCount + group.tabs.length < MERGED_ROW_TAB_LIMIT
          && group.tabs.length < candidateTabCount
        ) {
          candidateIndex = index;
          candidateTabCount = group.tabs.length;
        }
      });

      if (candidateIndex < 0) break;
      const [candidate] = remaining.splice(candidateIndex, 1);
      currentRow.push(candidate);
      currentTabCount += candidate.tabs.length;
    }

    rows.push(currentRow);
  }

  return rows;
}

function getVisualCardCapacity() {
  const availableWidth = elements.windowGroups.clientWidth
    || elements.content.clientWidth
    || window.innerWidth
    || 760;
  return Math.max(
    1,
    Math.floor(
      (availableWidth - CARDS_HORIZONTAL_PADDING + TAB_CARD_GAP)
      / (TAB_CARD_WIDTH + TAB_CARD_GAP)
    )
  );
}

function getMergedRowWidth(rowGroups) {
  const cardsWidth = rowGroups.reduce((total, group) => total
    + group.tabs.length * TAB_CARD_WIDTH
    + Math.max(0, group.tabs.length - 1) * TAB_CARD_GAP, 0);
  const windowGaps = Math.max(0, rowGroups.length - 1) * MERGED_WINDOW_GAP;
  return CARDS_HORIZONTAL_PADDING + cardsWidth + windowGaps;
}

function displayWindowRows(groups) {
  const cardCapacity = getVisualCardCapacity();
  const rows = [];
  const smallGroups = [];

  for (const group of groups) {
    if (isSmallWindowGroup(group)) {
      smallGroups.push(group);
      continue;
    }

    for (let start = 0; start < group.tabs.length; start += cardCapacity) {
      const tabs = group.tabs.slice(start, start + cardCapacity);
      rows.push({
        groups: [{ window: group.window, tabs }],
        canMergeSmallGroups: start + tabs.length === group.tabs.length
          && tabs.length < cardCapacity,
        smallTabCount: 0
      });
    }
  }

  const availableWidth = elements.windowGroups.clientWidth
    || elements.content.clientWidth
    || window.innerWidth
    || 760;

  for (const row of rows) {
    if (!row.canMergeSmallGroups) continue;

    while (smallGroups.length && row.smallTabCount < MERGED_ROW_TAB_LIMIT - 1) {
      let candidateIndex = -1;
      let candidateTabCount = Number.POSITIVE_INFINITY;
      let candidateRemainingSpace = Number.POSITIVE_INFINITY;

      smallGroups.forEach((group, index) => {
        if (
          row.smallTabCount + group.tabs.length >= MERGED_ROW_TAB_LIMIT
          || getMergedRowWidth([...row.groups, group]) > availableWidth
        ) {
          return;
        }

        const remainingSpace = availableWidth - getMergedRowWidth([
          ...row.groups,
          group
        ]);
        if (
          group.tabs.length < candidateTabCount
          || (
            group.tabs.length === candidateTabCount
            && remainingSpace < candidateRemainingSpace
          )
        ) {
          candidateIndex = index;
          candidateTabCount = group.tabs.length;
          candidateRemainingSpace = remainingSpace;
        }
      });

      if (candidateIndex < 0) break;
      const [candidate] = smallGroups.splice(candidateIndex, 1);
      row.groups.push(candidate);
      row.smallTabCount += candidate.tabs.length;
    }
  }

  const smallRows = mergeSmallWindowRows(smallGroups);
  return [
    ...rows.map((row) => row.groups),
    ...smallRows
  ];
}

function createWindowSection(group) {
  const section = document.createElement("section");
  section.className = "window-section";
  section.dataset.windowId = String(group.window.id);
  section.setAttribute("aria-label", group.window.windowLabel);

  const cards = document.createElement("div");
  cards.className = "cards";
  group.tabs.forEach((tab) => cards.append(createCard(tab)));
  section.append(cards);
  return section;
}

function shortInitial(title = "?") {
  return [...title.trim()][0]?.toUpperCase() || "?";
}

function getDisplayTitle(title = "") {
  let displayTitle = title.trim();

  // Remove notification counts such as “(99+ 封私信 / 80 条消息)”.
  displayTitle = displayTitle.replace(
    /^\s*(?:(?:[（(【][^（）()【】]*[）)】])|(?:\[[^\[\]]*\]))\s*/u,
    ""
  );

  // Remove the common site suffix, such as “ - 知乎” or “ | YouTube”.
  displayTitle = displayTitle.replace(
    /\s+(?:[-–—|｜])\s*[^-–—|｜]+$/u,
    ""
  );

  // Keep the meaningful middle text and make it easier to scan at a glance.
  displayTitle = displayTitle
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return displayTitle || "未命名标签页";
}

function createFavicon(tab) {
  const slot = document.createElement("span");
  slot.className = "favicon-slot";

  if (tab.favIconUrl) {
    const favicon = document.createElement("img");
    favicon.className = "favicon";
    favicon.alt = "";
    favicon.src = tab.favIconUrl;
    favicon.addEventListener("error", () => {
      slot.replaceChildren(createFallbackFavicon(tab));
    });
    slot.append(favicon);
    return slot;
  }
  slot.append(createFallbackFavicon(tab));
  return slot;
}

function createFallbackFavicon(tab) {
  const fallback = document.createElement("span");
  fallback.className = "favicon-fallback";
  fallback.textContent = shortInitial(tab.title);
  return fallback;
}

function createCard(tab) {
  const card = document.createElement("div");
  card.className = "tab-card";
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.dataset.tabId = String(tab.id);
  card.dataset.windowId = String(tab.windowId);
  const displayTitle = getDisplayTitle(tab.title);
  const statusLabels = [
    tab.recentRank ? `最近切换第 ${tab.recentRank}` : "",
    tab.videoCompleted ? "最近播放结束的视频页面" : ""
  ].filter(Boolean);
  card.setAttribute(
    "aria-label",
    `${displayTitle}，${tab.host || "未知网站"}${tab.pinned ? "，已固定" : ""}${tab.audible ? "，正在播放媒体" : ""}${statusLabels.length ? `，${statusLabels.join("，")}` : ""}`
  );
  card.title = displayTitle;

  const indicators = document.createElement("span");
  indicators.className = "tab-indicators";
  indicators.setAttribute("aria-hidden", "true");
  if (tab.recentRank) {
    const recentIndicator = document.createElement("span");
    recentIndicator.className = "tab-indicator is-recent";
    recentIndicator.title = `最近切换第 ${tab.recentRank}`;
    indicators.append(recentIndicator);
  }
  if (tab.videoCompleted) {
    const videoIndicator = document.createElement("span");
    videoIndicator.className = "tab-indicator is-video";
    videoIndicator.title = "最近播放结束的视频页面";
    indicators.append(videoIndicator);
  }

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "close-tab";
  closeButton.setAttribute("aria-label", `关闭标签页：${displayTitle}`);
  closeButton.title = "关闭标签页";
  closeButton.textContent = "×";
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(tab);
  });
  closeButton.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });

  const favicon = createFavicon(tab);
  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = displayTitle;

  const flags = document.createElement("span");
  flags.className = "tab-flags";
  if (tab.pinned) flags.textContent = "📌";

  let playingIndicator = null;
  if (tab.audible) {
    playingIndicator = document.createElement("span");
    playingIndicator.className = "tab-playing-indicator";
    playingIndicator.setAttribute("aria-hidden", "true");
    playingIndicator.title = "此标签页正在播放音频或视频";
  }

  card.append(
    indicators,
    closeButton,
    favicon,
    title,
    ...(tab.pinned ? [flags] : []),
    ...(playingIndicator ? [playingIndicator] : [])
  );
  card.addEventListener("click", () => activate(tab));
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    activate(tab);
  });

  if (tab.id === appState.selectedTabId) card.classList.add("selected");
  return card;
}

function render({ centerSelected = true, revealSelected = true } = {}) {
  const groups = visibleWindowGroups();
  elements.empty.hidden = groups.length !== 0;
  elements.content.hidden = groups.length === 0;
  if (!groups.length) {
    scheduleResize();
    return;
  }

  const scrollPositions = captureCardScrollPositions();
  elements.windowGroups.replaceChildren();
  for (const rowGroups of displayWindowRows(groups)) {
    const row = rowGroups.length > 1
      ? document.createElement("div")
      : null;
    if (row) row.className = "window-row is-merged";

    for (const group of rowGroups) {
      const section = createWindowSection(group);
      (row || elements.windowGroups).append(section);
    }

    if (row) elements.windowGroups.append(row);
  }

  updateMergedRowAlignment();
  restoreCardScrollPositions(scrollPositions);
  focusSelectedCard({ center: centerSelected, reveal: revealSelected });
  scheduleResize();
}

function captureCardScrollPositions() {
  const positions = new Map();
  document.querySelectorAll(".window-section").forEach((section) => {
    const windowId = section.dataset.windowId;
    const cards = section.querySelector(".cards");
    if (windowId && cards) positions.set(windowId, cards.scrollLeft);
  });
  return positions;
}

function restoreCardScrollPositions(positions) {
  document.querySelectorAll(".window-section").forEach((section) => {
    const windowId = section.dataset.windowId;
    const cards = section.querySelector(".cards");
    const scrollLeft = positions.get(windowId);
    if (cards && scrollLeft !== undefined) cards.scrollLeft = scrollLeft;
  });
}

function updateMergedRowAlignment() {
  document.querySelectorAll(".window-row.is-merged").forEach((row) => {
    row.classList.toggle(
      "is-overflowing",
      row.scrollWidth > row.clientWidth + 1
    );
  });
}

function scheduleResize() {
  if (scheduleResize.frame !== null) return;
  scheduleResize.frame = requestAnimationFrame(() => {
    scheduleResize.frame = null;
    const contentHeight = Math.ceil(elements.shell.getBoundingClientRect().height);
    const frameHeight = Math.max(0, window.outerHeight - window.innerHeight);
    send({ type: "RESIZE_SWITCHER", contentHeight, frameHeight });
  });
}

scheduleResize.frame = null;

function scheduleLayoutRender() {
  if (scheduleLayoutRender.frame !== null) return;
  scheduleLayoutRender.frame = requestAnimationFrame(() => {
    scheduleLayoutRender.frame = null;
    if (appState.windows.length) {
      render({ centerSelected: false, revealSelected: false });
    }
  });
}

scheduleLayoutRender.frame = null;

function updateSearchShortcut() {
  const shortcut = document.querySelector("#search-shortcut");
  if (!shortcut) return;
  shortcut.textContent = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    ? "⌘ K"
    : "Ctrl K";
}

function focusSelectedCard({ center = true, reveal = true } = {}) {
  const card = document.querySelector(
    `.window-section .tab-card[data-tab-id="${appState.selectedTabId}"]`
  );
  if (!card) return;

  const cards = card.closest(".cards");
  if (cards && center) {
    const cardsRect = cards.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardCenter = cards.scrollLeft
      + cardRect.left - cardsRect.left
      + cardRect.width / 2;
    const centeredLeft = cardCenter - cards.clientWidth / 2;
    const maxScrollLeft = Math.max(0, cards.scrollWidth - cards.clientWidth);
    const nextScrollLeft = Math.min(
      maxScrollLeft,
      Math.max(0, centeredLeft)
    );
    cards.scrollTo({ left: nextScrollLeft, behavior: "auto" });
  } else if (cards) {
    const cardsRect = cards.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    if (cardRect.left < cardsRect.left) {
      cards.scrollLeft += cardRect.left - cardsRect.left;
    } else if (cardRect.right > cardsRect.right) {
      cards.scrollLeft += cardRect.right - cardsRect.right;
    }
  }

  const mergedRow = card.closest(".window-row.is-merged");
  if (mergedRow) {
    const rowRect = mergedRow.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    if (center) {
      const cardCenter = mergedRow.scrollLeft
        + cardRect.left - rowRect.left
        + cardRect.width / 2;
      const centeredLeft = cardCenter - mergedRow.clientWidth / 2;
      const maxScrollLeft = Math.max(
        0,
        mergedRow.scrollWidth - mergedRow.clientWidth
      );
      mergedRow.scrollTo({
        left: Math.min(maxScrollLeft, Math.max(0, centeredLeft)),
        behavior: "auto"
      });
    } else if (cardRect.left < rowRect.left) {
      mergedRow.scrollLeft += cardRect.left - rowRect.left;
    } else if (cardRect.right > rowRect.right) {
      mergedRow.scrollLeft += cardRect.right - rowRect.right;
    }
  }

  if (card && reveal) {
    const contentRect = elements.content.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    if (cardRect.top < contentRect.top) {
      elements.content.scrollTop -= contentRect.top - cardRect.top;
    } else if (cardRect.bottom > contentRect.bottom) {
      elements.content.scrollTop += cardRect.bottom - contentRect.bottom;
    }
  }

  if (document.activeElement !== elements.search) {
    card.focus({ preventScroll: true });
  }
}

if (typeof ResizeObserver !== "undefined") {
  const layoutObserver = new ResizeObserver(scheduleLayoutRender);
  layoutObserver.observe(elements.windowGroups);
}
window.addEventListener("resize", scheduleLayoutRender);

function updateState(data) {
  if (!data?.ok) {
    elements.content.hidden = true;
    elements.empty.hidden = false;
    elements.empty.querySelector("h2").textContent = "读取标签页失败";
    elements.empty.querySelector("p").textContent = "请关闭面板后重新打开，或检查扩展权限。";
    return;
  }

  const isInitialState = appState.selectedTabId === null;
  appState.windows = (data.windows || []).map((window) => ({
    ...window,
    tabs: window.tabs.map(indexTab)
  }));
  appState.sourceTabId = data.sourceTabId;

  const visible = visibleTabs();
  if (!visible.some((tab) => tab.id === appState.selectedTabId)) {
    appState.selectedTabId = visible.some((tab) => tab.id === data.sourceTabId)
      ? data.sourceTabId
      : visible[0]?.id ?? null;
  }
  render({ revealSelected: !isInitialState });
}

let refreshSequence = 0;
let refreshTimer = null;

async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const data = await send({ type: "GET_STATE" });
    if (sequence === refreshSequence) updateState(data);
  } catch (error) {
    if (sequence === refreshSequence) throw error;
  }
}

function scheduleRefresh() {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch(showLoadError);
  }, 50);
}

function activate(tab) {
  send({
    type: "ACTIVATE_TAB",
    tabId: tab.id,
    windowId: tab.windowId
  }).catch(() => {});
}

function closeTab(tab) {
  send({
    type: "CLOSE_TAB",
    tabId: tab.id
  }).catch(() => {});
}

function activateSelected() {
  const tab = visibleTabs().find((item) => item.id === appState.selectedTabId);
  if (tab) activate(tab);
}

function showLoadError() {
  elements.content.hidden = true;
  elements.empty.hidden = false;
  elements.empty.querySelector("h2").textContent = "读取标签页失败";
  elements.empty.querySelector("p").textContent = "请关闭面板后重新打开，或检查扩展权限。";
}

elements.search.addEventListener("input", () => {
  appState.query = elements.search.value;
  const visible = visibleTabs();
  if (!visible.some((tab) => tab.id === appState.selectedTabId)) {
    appState.selectedTabId = visible[0]?.id ?? null;
  }
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;

  if (event.key === "Escape") {
    event.preventDefault();
    send({ type: "CLOSE_SWITCHER" }).catch(() => {});
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    elements.search.focus();
    elements.search.select();
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    moveWithinRow(1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveWithinRow(-1);
  } else if (event.key === "Tab") {
    event.preventDefault();
    moveWithTab(event.shiftKey ? -1 : 1);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    moveBetweenRows(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveBetweenRows(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    activateSelected();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TABS_CHANGED") scheduleRefresh();
});

function visualCardRows() {
  const rows = [];
  document.querySelectorAll(".tab-card").forEach((card) => {
    const rect = card.getBoundingClientRect();
    let row = rows.find((item) => Math.abs(item.top - rect.top) <= 2);
    if (!row) {
      row = { top: rect.top, cards: [] };
      rows.push(row);
    }
    row.cards.push({ card, rect });
  });

  return rows
    .sort((first, second) => first.top - second.top)
    .map((row) => row.cards.sort((first, second) =>
      first.rect.left - second.rect.left
    ));
}

function moveWithinRow(delta) {
  const rows = visualCardRows();
  const row = rows.find((cards) => cards.some(({ card }) =>
    card.dataset.tabId === String(appState.selectedTabId)
  ));
  if (!row) return;

  const currentIndex = row.findIndex(({ card }) =>
    card.dataset.tabId === String(appState.selectedTabId)
  );
  const nextIndex = (Math.max(currentIndex, 0) + delta + row.length) % row.length;
  const nextTab = visibleTabs().find((tab) =>
    String(tab.id) === row[nextIndex].card.dataset.tabId
  );
  if (!nextTab) return;
  appState.selectedTabId = nextTab.id;
  render();
}

function renderedTabs() {
  const tabsById = new Map(
    visibleTabs().map((tab) => [String(tab.id), tab])
  );
  return [...document.querySelectorAll(".tab-card")]
    .map((card) => tabsById.get(card.dataset.tabId))
    .filter(Boolean);
}

function moveWithTab(delta) {
  // Small windows can be merged after the final chunk of a long window, so
  // the rendered card order is not always the same as the window data order.
  const tabs = renderedTabs();
  if (!tabs.length) return;

  const currentIndex = tabs.findIndex((tab) => tab.id === appState.selectedTabId);
  const nextIndex = (Math.max(currentIndex, 0) + delta + tabs.length) % tabs.length;
  appState.selectedTabId = tabs[nextIndex].id;
  render();
}

function moveBetweenRows(delta) {
  const rows = visualCardRows();
  if (rows.length < 2) return;

  const currentRowIndex = rows.findIndex((cards) => cards.some(({ card }) =>
    card.dataset.tabId === String(appState.selectedTabId)
  ));
  const rowIndex = currentRowIndex < 0
    ? 0
    : (currentRowIndex + delta + rows.length) % rows.length;
  const targetRow = rows[rowIndex];
  const currentCard = [...document.querySelectorAll(".tab-card")]
    .find((card) => card.dataset.tabId === String(appState.selectedTabId));
  const currentCenter = currentCard
    ? currentCard.getBoundingClientRect().left + currentCard.getBoundingClientRect().width / 2
    : null;

  let targetCard = targetRow[0]?.card;

  if (currentCenter !== null) {
    let nearestDistance = Number.POSITIVE_INFINITY;
    targetRow.forEach(({ card, rect }) => {
      const distance = Math.abs(currentCenter - (rect.left + rect.width / 2));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        targetCard = card;
      }
    });
  }

  const targetTab = visibleTabs().find((tab) =>
    String(tab.id) === targetCard?.dataset.tabId
  );
  if (!targetTab) return;
  appState.selectedTabId = targetTab.id;
  render({ centerSelected: false });
}

updateSearchShortcut();
refresh().catch(showLoadError);
