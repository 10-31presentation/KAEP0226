const STORAGE_KEY = "oboeru-dana-data-v1";
const DATABASE_NAME = "oboeru-dana-database";
const DATABASE_VERSION = 1;
const DATABASE_STORE = "app-data";
const DATABASE_RECORD_KEY = "current";
const FIRST_VISIT_KEY = "oboeru-desk-guide-seen-v1";
const DAY = 86400000;
const AUTO_SAVE_DELAY = 3 * 60 * 1000;
const DEMO_CARD_IDS = new Set(["apple", "library", "discover", "daika"]);
const initialData = {
  folders: [],
  cards: [],
  trash: { folders: [], cards: [] },
  settings: { desktopWidth: 100, desktopHeight: 230 },
};
let data = createEmptyData();
let selectedFolder = "all";
let reviewQueue = [];
let reviewIndex = 0;
let answerVisible = false;
let reviewDirection = "word-to-meaning";
let isDirty = false;
let desktopDrag = null;
let folderWindowAction = null;
let ignoreDesktopClickId = null;
let editingCardId = null;
let editingFolderId = null;
let activeFolderWindowId = null;
let trashOpen = false;
const trashWindowLayout = {};
let database = null;
let isSaving = false;
let saveError = false;
let changeRevision = 0;
let autoSaveTimer = null;
let contextMenuParentId = null;
let desktopSelection = null;
let selectedDesktopItemIds = new Set();

function daysAgo(days) { return Date.now() - days * DAY; }
function createEmptyData() {
  return { ...JSON.parse(JSON.stringify(initialData)), folders: positionFolders(initialData.folders), cards: [], trash: { folders: [], cards: [] } };
}
function showDialog(dialog) {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.classList.add("dialog-fallback-modal");
  document.body.classList.add("dialog-fallback-open");
  dialog.setAttribute("open", "");
}
function closeDialog(dialog) {
  if (dialog.classList.contains("dialog-fallback-modal")) {
    dialog.removeAttribute("open");
    dialog.classList.remove("dialog-fallback-modal");
    if (!document.querySelector("dialog.dialog-fallback-modal[open]")) document.body.classList.remove("dialog-fallback-open");
    return;
  }
  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
  dialog.classList.remove("dialog-fallback-modal");
  if (!document.querySelector("dialog.dialog-fallback-modal[open]")) document.body.classList.remove("dialog-fallback-open");
}
function prepareData(saved) {
  if (!saved || typeof saved !== "object") return createEmptyData();
  // 以前の見本カードだけを取り除き、利用者が作ったカードは残す。
  const cards = (saved.cards || []).filter(card => !DEMO_CARD_IDS.has(card.id));
  return {
    ...saved,
    folders: positionFolders(saved.folders || []),
    cards: positionDesktopCards(cards),
    trash: {
      folders: positionFolders(saved.trash?.folders || []),
      cards: positionDesktopCards(saved.trash?.cards || []),
    },
    settings: normalizeSettings(saved.settings),
  };
}
function loadLegacyData() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? prepareData(saved) : null;
  } catch { return null; }
}
function openDatabase() {
  if (database) return Promise.resolve(database);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DATABASE_STORE)) request.result.createObjectStore(DATABASE_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => { database = request.result; resolve(database); };
    request.onerror = () => reject(request.error);
  });
}
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
async function writeDatabase(value) {
  const db = await openDatabase();
  const transaction = db.transaction(DATABASE_STORE, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(DATABASE_STORE).put({ key: DATABASE_RECORD_KEY, value });
  await complete;
}
async function loadData() {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(DATABASE_STORE, "readonly");
    const complete = transactionComplete(transaction);
    const stored = await requestResult(transaction.objectStore(DATABASE_STORE).get(DATABASE_RECORD_KEY));
    await complete;
    if (stored?.value) return prepareData(stored.value);

    const legacyData = loadLegacyData();
    if (legacyData) {
      await writeDatabase(legacyData);
      return legacyData;
    }
    return createEmptyData();
  } catch {
    // IndexedDBを使えない環境では、既存の保存データをそのまま利用する。
    return loadLegacyData() || createEmptyData();
  }
}
function normalizeSettings(settings = {}) {
  return {
    desktopWidth: 100,
    desktopHeight: Number.isFinite(settings.desktopHeight) ? settings.desktopHeight : 230,
  };
}
function positionFolders(folders) {
  return folders.map((folder, index) => ({
    ...folder,
    x: Number.isFinite(folder.x) ? folder.x : 20 + (index % 5) * 140,
    y: Number.isFinite(folder.y) ? folder.y : 16 + Math.floor(index / 5) * 140,
  }));
}
function positionDesktopCards(cards) {
  const groupIndexes = new Map();
  return cards.map(card => {
    const group = card.folderId || "root";
    const groupIndex = groupIndexes.get(group) || 0;
    const positioned = { ...card, x: Number.isFinite(card.x) ? card.x : 20 + (groupIndex % 5) * 145, y: Number.isFinite(card.y) ? card.y : 152 + Math.floor(groupIndex / 5) * 130 };
    groupIndexes.set(group, groupIndex + 1);
    return positioned;
  });
}
async function saveData() {
  try {
    await writeDatabase(data);
  } catch {
    // IndexedDBが利用できない環境だけ、従来の保存先に戻す。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
}
function clearAutoSaveTimer() {
  if (autoSaveTimer !== null) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}
function scheduleAutoSave() {
  clearAutoSaveTimer();
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    if (isDirty && !isSaving) saveCurrentData();
  }, AUTO_SAVE_DELAY);
}
function markDirty() {
  isDirty = true;
  saveError = false;
  changeRevision++;
  scheduleAutoSave();
  updateSaveStatus();
}
async function saveCurrentData() {
  if (isSaving) return;
  clearAutoSaveTimer();
  isSaving = true;
  saveError = false;
  const savedRevision = changeRevision;
  updateSaveStatus();
  try {
    await saveData();
    isDirty = changeRevision !== savedRevision;
  } catch {
    isDirty = true;
    saveError = true;
  } finally {
    isSaving = false;
    if (isDirty) scheduleAutoSave();
    updateSaveStatus();
  }
}
function updateSaveStatus() {
  const status = document.getElementById("save-status");
  const button = document.getElementById("save-data");
  if (!status || !button) return;
  if (isSaving) {
    status.textContent = "保存中…";
    button.textContent = "保存中…";
  } else if (saveError) {
    status.textContent = "保存できませんでした。もう一度お試しください";
    button.textContent = "もう一度保存";
  } else {
    status.textContent = isDirty ? "変更はまだ保存されていません" : "保存済み";
    button.textContent = isDirty ? "変更を保存する" : "保存する";
  }
  button.disabled = isSaving;
  status.classList.toggle("unsaved", isDirty || saveError);
}
function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function twoLineLabel(value, charactersPerLine) {
  const characters = Array.from(String(value).replace(/\s+/g, " ").trim());
  const maximum = charactersPerLine * 2;
  return characters.length > maximum ? `${characters.slice(0, maximum - 3).join("")}...` : characters.join("");
}
function daysSince(timestamp) { return timestamp ? Math.floor((Date.now() - timestamp) / DAY) : null; }
function cardIsDue(card) { const days = daysSince(card.lastPracticed); return card.needsReview || days === null || days >= card.interval; }
function cardIsNeglected(card) { const days = daysSince(card.lastPracticed); return days === null || days >= 4; }
function practiceAgeClass(card) {
  if (card.needsReview) return "practice-unsure";
  const days = daysSince(card.lastPracticed);
  if (days === null || days < 5) return "";
  if (days >= 30) return "practice-month";
  if (days >= 7) return "practice-week";
  return "practice-five-days";
}
function cardsForPracticeRange(range) {
  return data.cards.filter(card => {
    const ageClass = practiceAgeClass(card);
    if (range === "under-five") return ageClass === "";
    if (range === "five-days") return ageClass === "practice-five-days";
    if (range === "week") return ageClass === "practice-week";
    return ageClass === "practice-month" || ageClass === "practice-unsure";
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  data = await loadData();
  document.getElementById("today-label").textContent = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
  document.getElementById("add-card").addEventListener("click", () => openCardDialog());
  document.getElementById("add-folder").addEventListener("click", () => openFolderDialog());
  document.getElementById("show-guide").addEventListener("click", () => showDialog(document.getElementById("guide-dialog")));
  document.getElementById("reset-app").addEventListener("click", resetApplication);
  document.getElementById("save-data").addEventListener("click", saveCurrentData);
  document.getElementById("edit-folder").addEventListener("click", () => openFolderDialog(data.folders.find(folder => folder.id === selectedFolder)));
  document.getElementById("delete-folder").addEventListener("click", deleteSelectedFolder);
  document.getElementById("start-review").addEventListener("click", () => startReview(data.cards));
  document.getElementById("start-folder-practice").addEventListener("click", () => startReview(getSelectedFolderCards()));
  document.getElementById("header-warning").addEventListener("click", () => startReview(data.cards.filter(cardIsNeglected)));
  document.querySelectorAll("[data-practice-range]").forEach(button => button.addEventListener("click", () => startReview(cardsForPracticeRange(button.dataset.practiceRange))));
  document.getElementById("card-form").addEventListener("submit", saveCard);
  document.getElementById("folder-form").addEventListener("submit", saveFolder);
  document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => closeDialog(document.getElementById(button.dataset.closeDialog))));
  document.querySelectorAll("[data-review-direction]").forEach(button => button.addEventListener("click", () => beginReview(button.dataset.reviewDirection)));
  window.addEventListener("pointerup", finishStrayPointerActions);
  window.addEventListener("pointercancel", cancelAllPointerActions);
  window.addEventListener("blur", cancelAllPointerActions);
  document.addEventListener("pointerdown", cancelStalePointerActions, true);
  setupDesktopContextMenu();
  setupDesktopSelection();
  setupDeskSearch();
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelAllPointerActions(); });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    cancelAllPointerActions();
    closeDesktopContextMenu();
    clearDesktopSelection();
    const fallbackDialog = document.querySelector("dialog.dialog-fallback-modal[open]");
    if (fallbackDialog) closeDialog(fallbackDialog);
  });
  setupDesktopSizeControls();
  updateSaveStatus();
  render();
  showGuideOnFirstVisit();
});

function showGuideOnFirstVisit() {
  try {
    if (localStorage.getItem(FIRST_VISIT_KEY)) return;
    localStorage.setItem(FIRST_VISIT_KEY, "seen");
  } catch {}
  showDialog(document.getElementById("guide-dialog"));
}
async function resetApplication() {
  if (!window.confirm("初期化しますか？この操作は取り消せません")) return;
  if (!window.confirm("本当に初期化しますか？")) return;
  if (!window.confirm("本当の本当に初期化しますか？")) return;
  cancelAllPointerActions();
  closeDesktopContextMenu();
  data = createEmptyData();
  selectedFolder = "all";
  reviewQueue = [];
  reviewIndex = 0;
  answerVisible = false;
  editingCardId = null;
  editingFolderId = null;
  activeFolderWindowId = null;
  trashOpen = false;
  selectedDesktopItemIds.clear();
  Object.keys(trashWindowLayout).forEach(key => delete trashWindowLayout[key]);
  document.getElementById("desktop-height").value = data.settings.desktopHeight;
  applyDesktopSize();
  markDirty();
  render();
  await saveCurrentData();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(FIRST_VISIT_KEY);
  } catch {}
  showGuideOnFirstVisit();
}

function setupDesktopContextMenu() {
  const desktop = document.getElementById("folder-desktop");
  const menu = document.getElementById("desktop-context-menu");
  desktop.addEventListener("contextmenu", event => {
    const surface = event.target.closest(".folder-window-content, #folder-desktop");
    if (!surface || surface.classList.contains("trash-window-content")) return;
    event.preventDefault();
    cancelAllPointerActions();
    contextMenuParentId = surface.dataset.parentId || null;
    menu.hidden = false;
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
    menu.querySelector("button")?.focus();
  });
  menu.addEventListener("click", event => {
    const button = event.target.closest("[data-desktop-action]");
    if (!button) return;
    const parentId = contextMenuParentId;
    closeDesktopContextMenu();
    if (button.dataset.desktopAction === "organize") organizeDesktopSurface(parentId, button.dataset.sortOrder);
    if (button.dataset.desktopAction === "add-card") openCardDialog(null, parentId);
    if (button.dataset.desktopAction === "add-folder") openFolderDialog(null, parentId);
  });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !event.target.closest("#desktop-context-menu")) closeDesktopContextMenu();
  });
  window.addEventListener("resize", closeDesktopContextMenu);
  window.addEventListener("scroll", closeDesktopContextMenu, true);
}
function closeDesktopContextMenu() {
  const menu = document.getElementById("desktop-context-menu");
  if (!menu) return;
  menu.hidden = true;
  contextMenuParentId = null;
}

function setupDesktopSelection() {
  const desktop = document.getElementById("folder-desktop");
  desktop.addEventListener("pointerdown", beginDesktopSelection);
  desktop.addEventListener("pointermove", moveDesktopSelection);
  desktop.addEventListener("pointerup", finishDesktopSelectionFromEvent);
  desktop.addEventListener("pointercancel", cancelDesktopSelectionFromEvent);
}
function beginDesktopSelection(event) {
  if (event.button !== 0 || event.target.closest(".desktop-item, .desktop-trash, .folder-window-bar, .folder-window-resize")) return;
  const surface = event.target.closest(".folder-window-content, #folder-desktop");
  if (!surface || surface.classList.contains("trash-window-content")) return;
  cancelAllPointerActions();
  closeDesktopContextMenu();
  const bounds = surface.getBoundingClientRect();
  const startX = Math.max(0, Math.min(surface.clientWidth, event.clientX - bounds.left));
  const startY = Math.max(0, Math.min(surface.clientHeight, event.clientY - bounds.top));
  const selectionBox = document.createElement("div");
  selectionBox.className = "desktop-selection-box";
  selectionBox.setAttribute("aria-hidden", "true");
  selectionBox.style.left = `${startX}px`;
  selectionBox.style.top = `${startY}px`;
  surface.append(selectionBox);
  desktopSelection = {
    surface,
    selectionBox,
    pointerId: event.pointerId,
    startX,
    startY,
    moved: false,
    initialIds: event.shiftKey ? new Set(selectedDesktopItemIds) : new Set(),
  };
  if (!event.shiftKey) {
    selectedDesktopItemIds.clear();
    updateDesktopSelectionVisuals();
  }
  event.preventDefault();
  try { surface.setPointerCapture(event.pointerId); } catch {}
}
function moveDesktopSelection(event) {
  if (!desktopSelection || event.pointerId !== desktopSelection.pointerId) return;
  const action = desktopSelection;
  const bounds = action.surface.getBoundingClientRect();
  const currentX = Math.max(0, Math.min(action.surface.clientWidth, event.clientX - bounds.left));
  const currentY = Math.max(0, Math.min(action.surface.clientHeight, event.clientY - bounds.top));
  const left = Math.min(action.startX, currentX);
  const top = Math.min(action.startY, currentY);
  const width = Math.abs(currentX - action.startX);
  const height = Math.abs(currentY - action.startY);
  if (width + height > 4) action.moved = true;
  action.selectionBox.style.left = `${left}px`;
  action.selectionBox.style.top = `${top}px`;
  action.selectionBox.style.width = `${width}px`;
  action.selectionBox.style.height = `${height}px`;
  const ids = new Set(action.initialIds);
  if (action.moved) {
    [...action.surface.children].filter(element => element.classList.contains("desktop-item")).forEach(element => {
      const intersects = left <= element.offsetLeft + element.offsetWidth
        && left + width >= element.offsetLeft
        && top <= element.offsetTop + element.offsetHeight
        && top + height >= element.offsetTop;
      if (intersects && element.dataset.itemId) ids.add(element.dataset.itemId);
    });
  }
  selectedDesktopItemIds = ids;
  updateDesktopSelectionVisuals();
}
function finishDesktopSelectionFromEvent(event) {
  if (!desktopSelection || event.pointerId !== desktopSelection.pointerId) return;
  finishDesktopSelection();
}
function finishDesktopSelection() {
  if (!desktopSelection) return;
  const { surface, selectionBox, pointerId } = desktopSelection;
  desktopSelection = null;
  selectionBox.remove();
  try { if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId); } catch {}
}
function cancelDesktopSelectionFromEvent(event) {
  if (!desktopSelection || event.pointerId !== desktopSelection.pointerId) return;
  cancelDesktopSelection();
}
function cancelDesktopSelection() {
  if (!desktopSelection) return;
  desktopSelection.selectionBox.remove();
  desktopSelection = null;
}
function clearDesktopSelection() {
  cancelDesktopSelection();
  selectedDesktopItemIds.clear();
  updateDesktopSelectionVisuals();
}
function updateDesktopSelectionVisuals() {
  document.querySelectorAll(".desktop-item[data-item-id]").forEach(element => {
    const selected = selectedDesktopItemIds.has(element.dataset.itemId);
    element.classList.toggle("desktop-selected", selected);
    element.setAttribute("aria-pressed", String(selected));
  });
}
function setupDeskSearch() {
  const input = document.getElementById("desk-search-input");
  const results = document.getElementById("desk-search-results");
  input.addEventListener("input", renderDeskSearchResults);
  input.addEventListener("focus", renderDeskSearchResults);
  input.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    input.value = "";
    results.hidden = true;
    input.blur();
  });
  results.addEventListener("click", event => {
    const button = event.target.closest("[data-search-type][data-search-id]");
    if (!button) return;
    if (button.dataset.searchType === "folder") {
      selectedDesktopItemIds = new Set([button.dataset.searchId]);
      openFolder(button.dataset.searchId);
    } else {
      const card = data.cards.find(item => item.id === button.dataset.searchId);
      if (!card) return;
      selectedDesktopItemIds = new Set([card.id]);
      selectedFolder = card.folderId || "all";
      activeFolderWindowId = card.folderId || null;
      render();
    }
    results.hidden = true;
    input.blur();
  });
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest(".desk-search")) results.hidden = true;
  });
}
function renderDeskSearchResults() {
  const input = document.getElementById("desk-search-input");
  const results = document.getElementById("desk-search-results");
  if (!input || !results) return;
  const query = input.value.trim().toLocaleLowerCase("ja");
  if (!query) {
    results.hidden = true;
    results.replaceChildren();
    return;
  }
  const matches = [
    ...data.folders
      .filter(folder => folder.name.toLocaleLowerCase("ja").includes(query))
      .map(folder => ({ type: "folder", id: folder.id, title: folder.name, detail: `${getFolderName(folder.parentId)} の中` })),
    ...data.cards
      .filter(card => [card.front, card.back, card.memo || "", getFolderName(card.folderId)].some(value => value.toLocaleLowerCase("ja").includes(query)))
      .map(card => ({ type: "card", id: card.id, title: card.front, detail: `${card.back} · ${getFolderName(card.folderId)}` })),
  ].slice(0, 10);
  results.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "desk-search-empty";
    empty.textContent = "見つかりませんでした";
    results.append(empty);
  } else {
    matches.forEach(match => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.searchType = match.type;
      button.dataset.searchId = match.id;
      button.innerHTML = `<span class="desk-search-type">${match.type === "folder" ? "FOLDER" : "CARD"}</span><strong>${escapeHtml(match.title)}</strong><small>${escapeHtml(match.detail)}</small>`;
      results.append(button);
    });
  }
  results.hidden = false;
}
function itemCreatedAt(item) {
  return item.createdAt || Number(item.id?.split("-")[1]) || 0;
}
function itemColorRank(item) {
  if (!("front" in item)) return 3;
  const color = practiceAgeClass(item);
  if (color === "practice-five-days") return 0;
  if (color === "practice-week") return 1;
  if (color === "practice-month" || color === "practice-unsure") return 2;
  return 3;
}
function organizeDesktopSurface(parentId, sortOrder) {
  const surface = parentId
    ? document.querySelector(`.folder-window-content[data-parent-id="${CSS.escape(parentId)}"]`)
    : document.getElementById("folder-desktop");
  if (!surface) return;
  const items = [
    ...data.folders.filter(folder => folder.parentId === parentId),
    ...data.cards.filter(card => card.folderId === parentId),
  ].sort((a, b) => {
    if (sortOrder === "recent") return itemCreatedAt(b) - itemCreatedAt(a) || String(a.id).localeCompare(String(b.id));
    const nameOrder = String(a.name || a.front).localeCompare(String(b.name || b.front), "ja");
    if (sortOrder === "color") return itemColorRank(a) - itemColorRank(b) || nameOrder;
    return nameOrder;
  });
  if (!items.length) return;
  const renderedItems = [...surface.children].filter(element => element.classList.contains("desktop-item"));
  const margin = 16;
  const gap = 16;
  const itemWidth = Math.max(132, ...renderedItems.map(element => element.offsetWidth));
  const itemHeight = Math.max(130, ...renderedItems.map(element => element.offsetHeight));
  const cellWidth = itemWidth + gap;
  const cellHeight = itemHeight + gap;
  const reservedWidth = parentId ? 0 : 64;
  const usableWidth = surface.clientWidth - reservedWidth - margin * 2;
  const columns = Math.max(1, Math.floor((usableWidth + gap) / cellWidth));
  items.forEach((item, index) => {
    item.x = margin + (index % columns) * cellWidth;
    item.y = margin + Math.floor(index / columns) * cellHeight;
  });
  const rows = Math.ceil(items.length / columns);
  const requiredHeight = margin * 2 + rows * itemHeight + Math.max(0, rows - 1) * gap;
  if (!parentId) {
    if (requiredHeight > data.settings.desktopHeight) {
      data.settings.desktopHeight = Math.min(2400, Math.ceil(requiredHeight / 10) * 10);
      document.getElementById("desktop-height").value = data.settings.desktopHeight;
      applyDesktopSize();
    }
  } else if (requiredHeight > surface.clientHeight) {
    const desktop = document.getElementById("folder-desktop");
    const folderWindow = surface.closest(".folder-window");
    const folder = data.folders.find(item => item.id === parentId);
    if (folderWindow && folder) {
      const requiredWindowHeight = requiredHeight + 42;
      const requiredDesktopHeight = folderWindow.offsetTop + requiredWindowHeight + 4;
      if (requiredDesktopHeight > data.settings.desktopHeight) {
        data.settings.desktopHeight = Math.min(2400, Math.ceil(requiredDesktopHeight / 10) * 10);
        document.getElementById("desktop-height").value = data.settings.desktopHeight;
        applyDesktopSize();
      }
      folder.windowHeight = Math.min(requiredWindowHeight, desktop.clientHeight - folderWindow.offsetTop - 4);
    }
  }
  markDirty();
  renderDesktop();
}

function setupDesktopSizeControls() {
  const heightInput = document.getElementById("desktop-height");
  data.settings.desktopWidth = 100;
  heightInput.value = data.settings.desktopHeight;
  const updateSize = () => {
    data.settings.desktopHeight = Number(heightInput.value);
    applyDesktopSize();
    constrainDesktopItems();
    renderDesktop();
    markDirty();
  };
  heightInput.addEventListener("input", updateSize);
  applyDesktopSize();
  constrainDesktopItems();
}
function applyDesktopSize() {
  const desktop = document.getElementById("folder-desktop");
  desktop.style.width = "100%";
  desktop.style.height = `${data.settings.desktopHeight}px`;
  document.getElementById("desktop-height-value").textContent = `${data.settings.desktopHeight}px`;
}
function constrainDesktopItems() {
  const desktop = document.getElementById("folder-desktop");
  const clampItem = (item, itemWidth, itemHeight) => {
    item.x = Math.max(4, Math.min(desktop.clientWidth - itemWidth - 4, item.x ?? 4));
    item.y = Math.max(4, Math.min(desktop.clientHeight - itemHeight - 4, item.y ?? 4));
  };
  data.folders.forEach(folder => clampItem(folder, 104, 112));
  data.cards.forEach(card => clampItem(card, 112, 88));
}

function getFolderName(folderId) { if (!folderId) return "Desk"; return data.folders.find(folder => folder.id === folderId)?.name || "未分類"; }
function getDescendantIds(folderId) { const ids = [folderId]; data.folders.filter(folder => folder.parentId === folderId).forEach(folder => ids.push(...getDescendantIds(folder.id))); return ids; }
function getSelectedFolderCards() { if (selectedFolder === "all" || selectedFolder === "neglected") return []; const folderIds = getDescendantIds(selectedFolder); return data.cards.filter(card => folderIds.includes(card.folderId)); }
function getFolderPath(folderId) {
  const path = [];
  const visited = new Set();
  let current = data.folders.find(folder => folder.id === folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? data.folders.find(folder => folder.id === current.parentId) : null;
  }
  return path;
}
function visibleCards() { if (selectedFolder === "all") return data.cards; if (selectedFolder === "neglected") return data.cards.filter(cardIsNeglected); const ids = getDescendantIds(selectedFolder); return data.cards.filter(card => ids.includes(card.folderId)); }
function getDueCards() { return visibleCards().filter(cardIsDue); }
function shuffleCards(cards) {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled;
}
function render() {
  cancelAllPointerActions();
  document.querySelector(".header-cunecuneboy").hidden = !data.cards.some(isCunecuneCard);
  renderDesktop();
  renderFolderHeader();
  renderDashboard();
  renderFolderPractice();
  if (document.getElementById("desk-search-input")?.value.trim()) renderDeskSearchResults();
}
function renderDesktop() {
  const desktop = document.getElementById("folder-desktop");
  desktop.querySelectorAll(".desktop-item, .desktop-empty, .folder-window, .desktop-trash").forEach(item => item.remove());
  renderDesktopSurface(desktop, null);

  if (trashOpen) desktop.append(createTrashWindow());

  if (selectedFolder === "all") { activeFolderWindowId = trashOpen ? "trash" : null; return; }
  const folderPath = getFolderPath(selectedFolder);
  if (!folderPath.length) { selectedFolder = "all"; activeFolderWindowId = null; renderFolderHeader(); return; }
  if (!folderPath.some(folder => folder.id === activeFolderWindowId)) activeFolderWindowId = selectedFolder;
  folderPath.forEach((folder, index) => {
    const folderWindow = createFolderWindow(folder, index, folderPath.length, activeFolderWindowId);
    desktop.append(folderWindow);
    renderDesktopSurface(folderWindow.querySelector(".folder-window-content"), folder.id);
  });
}
function renderDesktopSurface(surface, parentId) {
  surface.dataset.parentId = parentId || "";
  const folders = data.folders.filter(folder => folder.parentId === parentId);
  const cards = data.cards.filter(card => card.folderId === parentId);
  if (surface.id === "folder-desktop") surface.append(createDesktopTrash());
  folders.forEach((folder, index) => mountDesktopItem(surface, createDesktopFolder(folder, index), folder));
  cards.forEach((card, index) => mountDesktopItem(surface, createDesktopCard(card, index), card));
  if (!folders.length && !cards.length) {
    const empty = document.createElement("p");
    empty.className = surface.id === "folder-desktop" ? "desktop-empty" : "folder-window-empty";
    empty.textContent = "ここにはまだ何もありません";
    surface.append(empty);
  }
}
function createDesktopTrash() {
  const trash = document.createElement("div");
  trash.className = "desktop-trash";
  trash.tabIndex = 0;
  trash.setAttribute("role", "button");
  const trashCount = data.trash.cards.length + data.trash.folders.length;
  trash.setAttribute("aria-label", `ゴミ箱。${trashCount}件。カードやフォルダをドラッグして入れ、ダブルクリックで開く`);
  trash.dataset.tooltip = trashCount ? `ドラッグで捨てる・開く（${trashCount}件）` : "ドラッグで捨てる・ダブルクリックで開く";
  trash.innerHTML = `<span class="trash-icon" aria-hidden="true"><i></i></span>`;
  trash.addEventListener("dblclick", openTrash);
  trash.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openTrash();
  });
  return trash;
}
function openTrash() {
  trashOpen = true;
  activeFolderWindowId = "trash";
  render();
}
function createTrashWindow() {
  const windowElement = document.createElement("section");
  windowElement.className = "folder-window trash-window active-window";
  windowElement.dataset.folderId = "trash";
  applyFolderWindowLayout(windowElement, trashWindowLayout, 1);
  windowElement.style.zIndex = "40";
  windowElement.setAttribute("aria-label", "ゴミ箱の中身");

  const bar = document.createElement("div");
  bar.className = "folder-window-bar trash-window-bar";
  bar.innerHTML = `<div class="folder-window-title trash-window-title"><span aria-hidden="true">▤</span><strong>ゴミ箱</strong><small>取り出すとDeskへ戻ります</small></div>`;
  bar.addEventListener("pointerdown", event => beginFolderWindowMove(event, trashWindowLayout, windowElement, bar));
  bar.addEventListener("pointermove", moveFolderWindow);
  bar.addEventListener("pointerup", endFolderWindowAction);
  bar.addEventListener("pointercancel", cancelFolderWindowActionFromEvent);
  bar.addEventListener("lostpointercapture", recoverFolderWindowActionAfterLostCapture);

  const actions = document.createElement("div");
  actions.className = "folder-window-actions";
  const emptyButton = document.createElement("button");
  emptyButton.type = "button";
  emptyButton.className = "trash-empty-button";
  emptyButton.textContent = "中身をすべて削除";
  emptyButton.disabled = data.trash.folders.length === 0 && data.trash.cards.length === 0;
  emptyButton.setAttribute("aria-label", emptyButton.disabled ? "ゴミ箱は空です" : "ゴミ箱の中身をすべて完全に削除");
  emptyButton.addEventListener("click", emptyTrash);
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "folder-window-close";
  closeButton.setAttribute("aria-label", "ゴミ箱を閉じる");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => { trashOpen = false; activeFolderWindowId = null; render(); });
  actions.append(emptyButton, closeButton);
  bar.append(actions);

  const contents = document.createElement("div");
  contents.className = "folder-window-content trash-window-content";
  renderTrashContents(contents);

  const resizeHandle = document.createElement("button");
  resizeHandle.type = "button";
  resizeHandle.className = "folder-window-resize";
  resizeHandle.setAttribute("aria-label", "ゴミ箱ウィンドウの大きさを変える");
  resizeHandle.addEventListener("pointerdown", event => beginFolderWindowResize(event, trashWindowLayout, windowElement, resizeHandle));
  resizeHandle.addEventListener("pointermove", resizeFolderWindow);
  resizeHandle.addEventListener("pointerup", endFolderWindowAction);
  resizeHandle.addEventListener("pointercancel", cancelFolderWindowActionFromEvent);
  resizeHandle.addEventListener("lostpointercapture", recoverFolderWindowActionAfterLostCapture);
  windowElement.append(bar, contents, resizeHandle);
  return windowElement;
}
function renderTrashContents(contents) {
  const trashedFolderIds = new Set(data.trash.folders.map(folder => folder.id));
  const rootFolders = data.trash.folders.filter(folder => !folder.parentId || !trashedFolderIds.has(folder.parentId));
  const items = [
    ...rootFolders.map(folder => ({ type: "folder", item: folder })),
    ...data.trash.cards.map(card => ({ type: "card", item: card })),
  ];
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "folder-window-empty";
    empty.textContent = "ゴミ箱は空です";
    contents.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "trash-list";
  items.forEach(({ type, item }) => {
    const row = document.createElement("div");
    row.className = `trash-item trash-${type}`;
    const folderIds = type === "folder" ? getTrashDescendantIds(item.id) : [];
    const details = type === "folder"
      ? `${folderIds.length - 1}個の子フォルダ・${data.trash.cards.filter(card => folderIds.includes(card.folderId)).length}枚のカード`
      : item.back;
    row.innerHTML = `<span class="trash-item-symbol" aria-hidden="true">${type === "folder" ? "▰" : "CARD"}</span><span class="trash-item-copy"><strong>${escapeHtml(type === "folder" ? item.name : item.front)}</strong><small>${escapeHtml(details || "説明なし")}</small></span>`;
    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "trash-restore-button";
    restoreButton.textContent = "取り出す";
    restoreButton.setAttribute("aria-label", `${type === "folder" ? item.name : item.front}をゴミ箱から取り出す`);
    restoreButton.addEventListener("click", () => restoreTrashItem(type, item.id));
    row.append(restoreButton);
    list.append(row);
  });
  contents.append(list);
}
function getTrashDescendantIds(folderId) {
  const ids = [folderId];
  data.trash.folders.filter(folder => folder.parentId === folderId).forEach(folder => ids.push(...getTrashDescendantIds(folder.id)));
  return ids;
}
function emptyTrash() {
  const folderCount = data.trash.folders.length;
  const cardCount = data.trash.cards.length;
  if (!folderCount && !cardCount) return;
  const message = `ゴミ箱のフォルダ${folderCount}個とカード${cardCount}枚をすべて完全に削除しますか？\nこの操作は取り消せません。`;
  if (!window.confirm(message)) return;
  data.trash = { folders: [], cards: [] };
  markDirty();
  render();
}
function restoreTrashItem(type, itemId) {
  if (type === "card") {
    const card = data.trash.cards.find(item => item.id === itemId);
    if (!card) return;
    data.trash.cards = data.trash.cards.filter(item => item.id !== itemId);
    card.folderId = data.folders.some(folder => folder.id === card.folderId) ? card.folderId : null;
    card.x = 20;
    card.y = 152 + data.cards.filter(item => item.folderId === card.folderId).length * 12;
    data.cards.push(card);
  } else {
    const folderIds = getTrashDescendantIds(itemId);
    const folders = data.trash.folders.filter(folder => folderIds.includes(folder.id));
    const cards = data.trash.cards.filter(card => folderIds.includes(card.folderId));
    const root = folders.find(folder => folder.id === itemId);
    if (!root) return;
    root.parentId = data.folders.some(folder => folder.id === root.parentId) ? root.parentId : null;
    root.x = 20;
    root.y = 16 + data.folders.filter(folder => folder.parentId === root.parentId).length * 12;
    data.trash.folders = data.trash.folders.filter(folder => !folderIds.includes(folder.id));
    data.trash.cards = data.trash.cards.filter(card => !folderIds.includes(card.folderId));
    data.folders.push(...folders);
    data.cards.push(...cards);
  }
  markDirty();
  render();
}
function mountDesktopItem(surface, element, item) {
  surface.append(element);
  const position = findOpenDesktopPosition(surface, element, item.x ?? 4, item.y ?? 4);
  item.x = position.x;
  item.y = position.y;
  element.style.left = `${item.x}px`;
  element.style.top = `${item.y}px`;
}
function findOpenDesktopPosition(surface, element, preferredX, preferredY) {
  const margin = 4;
  const gap = 8;
  const step = 8;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const maxX = Math.max(margin, surface.clientWidth - width - margin);
  const maxY = Math.max(margin, surface.clientHeight - height - margin);
  const desiredX = Math.max(margin, Math.min(maxX, preferredX));
  const desiredY = Math.max(margin, Math.min(maxY, preferredY));
  const others = [...surface.children].filter(item => item !== element && item.classList.contains("desktop-item"));
  const isOpen = (x, y) => !others.some(other => (
    x < other.offsetLeft + other.offsetWidth + gap
    && x + width + gap > other.offsetLeft
    && y < other.offsetTop + other.offsetHeight + gap
    && y + height + gap > other.offsetTop
  ));
  if (isOpen(desiredX, desiredY)) return { x: desiredX, y: desiredY };

  let nearest = null;
  let nearestDistance = Infinity;
  const testPosition = (x, y) => {
    if (!isOpen(x, y)) return;
    const distance = (x - desiredX) ** 2 + (y - desiredY) ** 2;
    if (distance < nearestDistance) {
      nearest = { x, y };
      nearestDistance = distance;
    }
  };
  for (let y = margin; y <= maxY; y += step) {
    for (let x = margin; x <= maxX; x += step) testPosition(x, y);
  }
  testPosition(maxX, maxY);
  testPosition(maxX, desiredY);
  testPosition(desiredX, maxY);
  return nearest || { x: desiredX, y: desiredY };
}
function settleDesktopItem(surface, element, item) {
  const position = findOpenDesktopPosition(surface, element, item.x, item.y);
  const moved = position.x !== item.x || position.y !== item.y;
  item.x = position.x;
  item.y = position.y;
  element.style.left = `${position.x}px`;
  element.style.top = `${position.y}px`;
  return moved;
}
function settleDesktopGroup(surface, members) {
  const margin = 4;
  const gap = 8;
  const step = 8;
  const memberElements = new Set(members.map(member => member.element));
  const others = [...surface.children].filter(element => element.classList.contains("desktop-item") && !memberElements.has(element));
  const minLeft = Math.min(...members.map(member => member.left));
  const minTop = Math.min(...members.map(member => member.top));
  const maxRight = Math.max(...members.map(member => member.left + member.width));
  const maxBottom = Math.max(...members.map(member => member.top + member.height));
  const minDx = margin - minLeft;
  const minDy = margin - minTop;
  const maxDx = surface.clientWidth - margin - maxRight;
  const maxDy = surface.clientHeight - margin - maxBottom;
  const desiredDx = Math.max(minDx, Math.min(maxDx, members[0].item.x - members[0].left));
  const desiredDy = Math.max(minDy, Math.min(maxDy, members[0].item.y - members[0].top));
  const isOpen = (dx, dy) => members.every(member => !others.some(other => (
    member.left + dx < other.offsetLeft + other.offsetWidth + gap
    && member.left + dx + member.width + gap > other.offsetLeft
    && member.top + dy < other.offsetTop + other.offsetHeight + gap
    && member.top + dy + member.height + gap > other.offsetTop
  )));
  let best = isOpen(desiredDx, desiredDy) ? { dx: desiredDx, dy: desiredDy } : null;
  let bestDistance = best ? 0 : Infinity;
  if (!best) {
    const testOffset = (dx, dy) => {
      if (!isOpen(dx, dy)) return;
      const distance = (dx - desiredDx) ** 2 + (dy - desiredDy) ** 2;
      if (distance < bestDistance) {
        best = { dx, dy };
        bestDistance = distance;
      }
    };
    for (let dy = minDy; dy <= maxDy; dy += step) {
      for (let dx = minDx; dx <= maxDx; dx += step) testOffset(dx, dy);
    }
    testOffset(0, 0);
  }
  const offset = best || { dx: 0, dy: 0 };
  members.forEach(member => {
    member.item.x = member.left + offset.dx;
    member.item.y = member.top + offset.dy;
    member.element.style.left = `${member.item.x}px`;
    member.element.style.top = `${member.item.y}px`;
  });
}
function createFolderWindow(folder, index, windowCount, frontFolderId) {
  const windowElement = document.createElement("section");
  const visualLevel = Math.min(index, 2);
  const isFront = folder.id === frontFolderId;
  windowElement.className = `folder-window${isFront ? " active-window" : ""}`;
  windowElement.dataset.folderId = folder.id;
  applyFolderWindowLayout(windowElement, folder, visualLevel);
  windowElement.style.zIndex = String(isFront ? 20 + windowCount : 8 + index);
  windowElement.setAttribute("aria-label", `${folder.name}フォルダの中身`);
  windowElement.addEventListener("pointerdown", () => bringFolderWindowToFront(folder.id, windowElement));

  const bar = document.createElement("div");
  bar.className = "folder-window-bar";
  bar.innerHTML = `<div class="folder-window-title"><span aria-hidden="true">▰</span><strong>${escapeHtml(folder.name)}</strong><small>ここをドラッグして移動</small></div>`;
  bar.addEventListener("pointerdown", event => beginFolderWindowMove(event, folder, windowElement, bar));
  bar.addEventListener("pointermove", moveFolderWindow);
  bar.addEventListener("pointerup", endFolderWindowAction);
  bar.addEventListener("pointercancel", cancelFolderWindowActionFromEvent);
  bar.addEventListener("lostpointercapture", recoverFolderWindowActionAfterLostCapture);

  const actions = document.createElement("div");
  actions.className = "folder-window-actions";
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "folder-window-back";
  backButton.textContent = "← もどる";
  backButton.hidden = index !== windowCount - 1;
  backButton.addEventListener("click", () => {
    selectedFolder = folder.parentId || "all";
    activeFolderWindowId = selectedFolder === "all" ? null : selectedFolder;
    render();
  });
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "folder-window-close";
  closeButton.setAttribute("aria-label", "フォルダを閉じる");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => {
    selectedFolder = folder.parentId || "all";
    activeFolderWindowId = selectedFolder === "all" ? null : selectedFolder;
    render();
  });
  actions.append(backButton, closeButton);
  bar.append(actions);

  const contents = document.createElement("div");
  contents.className = "folder-window-content";
  const dragHint = document.createElement("p");
  dragHint.className = "folder-window-drag-hint";
  dragHint.textContent = "カードやフォルダを窓の内外へドラッグして移動できます";
  contents.append(dragHint);
  const resizeHandle = document.createElement("button");
  resizeHandle.type = "button";
  resizeHandle.className = "folder-window-resize";
  resizeHandle.setAttribute("aria-label", "フォルダウィンドウの大きさを変える");
  resizeHandle.title = "ドラッグして大きさを変える";
  resizeHandle.addEventListener("pointerdown", event => beginFolderWindowResize(event, folder, windowElement, resizeHandle));
  resizeHandle.addEventListener("pointermove", resizeFolderWindow);
  resizeHandle.addEventListener("pointerup", endFolderWindowAction);
  resizeHandle.addEventListener("pointercancel", cancelFolderWindowActionFromEvent);
  resizeHandle.addEventListener("lostpointercapture", recoverFolderWindowActionAfterLostCapture);
  windowElement.append(bar, contents, resizeHandle);
  return windowElement;
}
function bringFolderWindowToFront(folderId, windowElement) {
  activeFolderWindowId = folderId;
  const windows = [...document.querySelectorAll("#folder-desktop .folder-window")];
  windows.forEach((element, index) => {
    const isFront = element === windowElement;
    element.classList.toggle("active-window", isFront);
    element.style.zIndex = String(isFront ? 20 + windows.length : 8 + index);
  });
}
function applyFolderWindowLayout(windowElement, folder, visualLevel) {
  const desktop = document.getElementById("folder-desktop");
  const desktopWidth = desktop.clientWidth;
  const desktopHeight = desktop.clientHeight;
  const minWidth = Math.min(260, Math.max(150, desktopWidth - 8));
  const minHeight = Math.min(140, Math.max(100, desktopHeight - 8));
  const defaultX = Math.round(desktopWidth * (.04 + visualLevel * .03));
  const defaultY = 10 + visualLevel * 28;
  const defaultWidth = Math.round(desktopWidth * .78);
  const defaultHeight = 180;
  if (!Number.isFinite(folder.windowHeight)) {
    folder.windowHeight = Math.max(minHeight, Math.min(desktopHeight - 8, defaultHeight));
  }
  const width = Math.max(minWidth, Math.min(desktopWidth - 8, Number.isFinite(folder.windowWidth) ? folder.windowWidth : defaultWidth));
  const height = Math.max(minHeight, Math.min(desktopHeight - 8, folder.windowHeight));
  const x = Math.max(4, Math.min(desktopWidth - width - 4, Number.isFinite(folder.windowX) ? folder.windowX : defaultX));
  const y = Math.max(4, Math.min(desktopHeight - height - 4, Number.isFinite(folder.windowY) ? folder.windowY : defaultY));
  windowElement.style.left = `${x}px`;
  windowElement.style.top = `${y}px`;
  windowElement.style.width = `${width}px`;
  windowElement.style.height = `${height}px`;
}
function beginFolderWindowMove(event, folder, windowElement, handle) {
  if (event.button !== 0 || event.target.closest("button")) return;
  event.preventDefault();
  cancelAllPointerActions();
  const desktop = document.getElementById("folder-desktop");
  folderWindowAction = {
    type: "move", folder, windowElement, handle, desktop,
    pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    left: windowElement.offsetLeft, top: windowElement.offsetTop,
    moved: false,
  };
  try { handle.setPointerCapture(event.pointerId); } catch { cancelFolderWindowAction(); return; }
  windowElement.classList.add("moving-window");
}
function moveFolderWindow(event) {
  if (!folderWindowAction || folderWindowAction.type !== "move" || event.pointerId !== folderWindowAction.pointerId || event.currentTarget !== folderWindowAction.handle) return;
  const action = folderWindowAction;
  const dx = event.clientX - action.startX;
  const dy = event.clientY - action.startY;
  if (Math.abs(dx) + Math.abs(dy) > 2) action.moved = true;
  if (!action.moved) return;
  const x = Math.max(4, Math.min(action.desktop.clientWidth - action.windowElement.offsetWidth - 4, action.left + dx));
  const y = Math.max(4, Math.min(action.desktop.clientHeight - action.windowElement.offsetHeight - 4, action.top + dy));
  action.folder.windowX = x;
  action.folder.windowY = y;
  action.windowElement.style.left = `${x}px`;
  action.windowElement.style.top = `${y}px`;
}
function beginFolderWindowResize(event, folder, windowElement, handle) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  cancelAllPointerActions();
  folderWindowAction = {
    type: "resize", folder, windowElement, handle,
    pointerId: event.pointerId,
    desktop: document.getElementById("folder-desktop"),
    startX: event.clientX, startY: event.clientY,
    width: windowElement.offsetWidth, height: windowElement.offsetHeight,
    moved: false,
  };
  try { handle.setPointerCapture(event.pointerId); } catch { cancelFolderWindowAction(); return; }
  windowElement.classList.add("resizing-window");
}
function resizeFolderWindow(event) {
  if (!folderWindowAction || folderWindowAction.type !== "resize" || event.pointerId !== folderWindowAction.pointerId || event.currentTarget !== folderWindowAction.handle) return;
  const action = folderWindowAction;
  const dx = event.clientX - action.startX;
  const dy = event.clientY - action.startY;
  if (Math.abs(dx) + Math.abs(dy) > 2) action.moved = true;
  if (!action.moved) return;
  const minWidth = Math.min(260, action.desktop.clientWidth - 8);
  const minHeight = Math.min(140, action.desktop.clientHeight - 8);
  const maxWidth = action.desktop.clientWidth - action.windowElement.offsetLeft - 4;
  const maxHeight = action.desktop.clientHeight - action.windowElement.offsetTop - 4;
  const width = Math.max(minWidth, Math.min(maxWidth, action.width + dx));
  const height = Math.max(minHeight, Math.min(maxHeight, action.height + dy));
  action.folder.windowWidth = width;
  action.folder.windowHeight = height;
  action.windowElement.style.width = `${width}px`;
  action.windowElement.style.height = `${height}px`;
}
function endFolderWindowAction(event) {
  if (!folderWindowAction || event.pointerId !== folderWindowAction.pointerId || event.currentTarget !== folderWindowAction.handle) return;
  finishFolderWindowAction();
}
function finishFolderWindowAction() {
  if (!folderWindowAction) return;
  const { windowElement, moved, type } = folderWindowAction;
  clearTimeout(folderWindowAction.recoveryTimer);
  windowElement.classList.remove("moving-window", "resizing-window");
  folderWindowAction = null;
  if (!moved) return;
  markDirty();
  if (type === "resize") render();
}
function cancelFolderWindowActionFromEvent(event) {
  if (!folderWindowAction || event.pointerId !== folderWindowAction.pointerId) return;
  cancelFolderWindowAction();
}
function recoverFolderWindowActionAfterLostCapture(event) {
  if (!folderWindowAction || event.pointerId !== folderWindowAction.pointerId) return;
  const action = folderWindowAction;
  clearTimeout(action.recoveryTimer);
  action.recoveryTimer = setTimeout(() => { if (folderWindowAction === action) cancelFolderWindowAction(); }, 120);
}
function cancelFolderWindowAction() {
  if (!folderWindowAction) return;
  const action = folderWindowAction;
  folderWindowAction = null;
  clearTimeout(action.recoveryTimer);
  action.windowElement.classList.remove("moving-window", "resizing-window");
  if (action.type === "move") {
    action.folder.windowX = action.left;
    action.folder.windowY = action.top;
    action.windowElement.style.left = `${action.left}px`;
    action.windowElement.style.top = `${action.top}px`;
  } else {
    action.folder.windowWidth = action.width;
    action.folder.windowHeight = action.height;
    action.windowElement.style.width = `${action.width}px`;
    action.windowElement.style.height = `${action.height}px`;
  }
  try { if (action.handle.hasPointerCapture(action.pointerId)) action.handle.releasePointerCapture(action.pointerId); } catch {}
}
function renderFolderHeader() {
  document.getElementById("folder-header-actions").hidden = selectedFolder === "all" || selectedFolder === "neglected";
}
function createDesktopFolder(folder, index) {
  const button = document.createElement("button");
  const count = data.cards.filter(card => getDescendantIds(folder.id).includes(card.folderId)).length;
  const displayFolderName = twoLineLabel(folder.name, 3);
  button.type = "button";
  button.dataset.folderId = folder.id;
  button.dataset.itemId = folder.id;
  button.className = `desktop-item desktop-folder${selectedFolder === folder.id ? " active" : ""}`;
  button.classList.toggle("desktop-selected", selectedDesktopItemIds.has(folder.id));
  button.setAttribute("aria-pressed", String(selectedDesktopItemIds.has(folder.id)));
  button.style.left = `${folder.x ?? 20 + (index % 5) * 140}px`;
  button.style.top = `${folder.y ?? 16 + Math.floor(index / 5) * 140}px`;
  button.title = `${folder.name}\nダブルクリックで開く`;
  button.setAttribute("aria-label", `${folder.name}フォルダ。ダブルクリックで開く`);
  button.innerHTML = `<span class="desktop-book book-back" aria-hidden="true"></span><span class="desktop-book book-middle" aria-hidden="true"></span><span class="desktop-icon" aria-hidden="true"></span><span class="desktop-name">${escapeHtml(displayFolderName)}</span><span class="desktop-count">${count} cards</span>`;
  button.addEventListener("pointerdown", event => beginDesktopDrag(event, folder, button));
  button.addEventListener("pointermove", moveDesktopItem);
  button.addEventListener("pointerup", endDesktopDrag);
  button.addEventListener("pointercancel", cancelDesktopDragFromEvent);
  button.addEventListener("lostpointercapture", recoverDesktopDragAfterLostCapture);
  button.addEventListener("click", event => {
    if (ignoreDesktopClickId === folder.id) { event.preventDefault(); return; }
    if (event.detail === 0) {
      openFolder(folder.id);
    }
  });
  button.addEventListener("dblclick", event => {
    if (ignoreDesktopClickId === folder.id) { event.preventDefault(); return; }
    openFolder(folder.id);
  });
  return button;
}
function openFolder(folderId) {
  if (!data.folders.some(folder => folder.id === folderId)) return;
  selectedFolder = folderId;
  activeFolderWindowId = folderId;
  render();
}
function createDesktopCard(card, index) {
  const item = document.createElement("article");
  const displayFront = twoLineLabel(card.front, 6);
  if (!Number.isFinite(card.x)) card.x = 20 + (index % 5) * 145;
  if (!Number.isFinite(card.y)) card.y = 152 + Math.floor(index / 5) * 130;
  item.tabIndex = 0;
  item.dataset.itemId = card.id;
  item.setAttribute("role", "button");
  item.className = `desktop-item desktop-card ${practiceAgeClass(card)}`;
  item.classList.toggle("desktop-selected", selectedDesktopItemIds.has(card.id));
  item.setAttribute("aria-pressed", String(selectedDesktopItemIds.has(card.id)));
  item.style.left = `${card.x}px`;
  item.style.top = `${card.y}px`;
  item.title = card.front;
  item.setAttribute("aria-label", `${card.front}を練習`);
  item.innerHTML = `<div class="desktop-card-actions"><button class="desktop-card-edit" type="button" aria-label="${escapeHtml(card.front)}を編集">編集</button><button class="desktop-card-delete" type="button" aria-label="${escapeHtml(card.front)}を削除">×</button></div><span class="desktop-card-icon">WORD CARD</span><span class="desktop-card-front">${escapeHtml(displayFront)}</span>`;
  if (isCunecuneCard(card)) {
    item.classList.add("desktop-card-cunecune");
    const illustration = document.createElement("img");
    illustration.className = "desktop-card-illustration";
    illustration.src = "cunecuneboy.png";
    illustration.alt = "";
    illustration.draggable = false;
    item.append(illustration);
  }
  item.addEventListener("pointerdown", event => { if (!event.target.closest(".desktop-card-actions")) beginDesktopDrag(event, card, item); });
  item.addEventListener("pointermove", moveDesktopItem);
  item.addEventListener("pointerup", endDesktopDrag);
  item.addEventListener("pointercancel", cancelDesktopDragFromEvent);
  item.addEventListener("lostpointercapture", recoverDesktopDragAfterLostCapture);
  item.addEventListener("click", event => {
    if (event.target.closest(".desktop-card-actions")) return;
    if (ignoreDesktopClickId === card.id) { event.preventDefault(); return; }
    startReview([card]);
  });
  item.addEventListener("keydown", event => { if (event.target.closest(".desktop-card-actions")) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startReview([card]); } });
  item.querySelector(".desktop-card-edit").addEventListener("click", event => { event.stopPropagation(); openCardDialog(card); });
  item.querySelector(".desktop-card-delete").addEventListener("click", event => { event.stopPropagation(); deleteCard(card); });
  return item;
}
function beginDesktopDrag(event, item, button) {
  if (event.button !== 0) return;
  cancelAllPointerActions();
  const rect = button.getBoundingClientRect();
  const surface = button.parentElement;
  const selectedElements = selectedDesktopItemIds.has(item.id)
    ? [...surface.children].filter(element => element.classList.contains("desktop-item") && selectedDesktopItemIds.has(element.dataset.itemId))
    : [button];
  const groupMembers = selectedElements.map(element => {
    const memberItem = data.folders.find(folder => folder.id === element.dataset.itemId)
      || data.cards.find(card => card.id === element.dataset.itemId);
    return memberItem ? {
      element,
      item: memberItem,
      left: memberItem.x,
      top: memberItem.y,
      width: element.offsetWidth,
      height: element.offsetHeight,
    } : null;
  }).filter(Boolean);
  desktopDrag = {
    item, button, surface,
    pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    left: item.x, top: item.y, moved: false, preview: null,
    pointerOffsetX: event.clientX - rect.left,
    pointerOffsetY: event.clientY - rect.top,
    width: rect.width, height: rect.height,
    groupMembers,
    groupMinLeft: Math.min(...groupMembers.map(member => member.left)),
    groupMinTop: Math.min(...groupMembers.map(member => member.top)),
    groupMaxRight: Math.max(...groupMembers.map(member => member.left + member.width)),
    groupMaxBottom: Math.max(...groupMembers.map(member => member.top + member.height)),
  };
  try { button.setPointerCapture(event.pointerId); } catch { cancelDesktopDrag(); }
}
function updateDesktopDragPreview(event) {
  if (!desktopDrag.preview) {
    if (desktopDrag.groupMembers.length > 1) {
      const preview = document.createElement("div");
      preview.className = "desktop-drag-preview-group";
      preview.setAttribute("aria-hidden", "true");
      preview.style.width = `${desktopDrag.groupMaxRight - desktopDrag.groupMinLeft}px`;
      preview.style.height = `${desktopDrag.groupMaxBottom - desktopDrag.groupMinTop}px`;
      desktopDrag.groupMembers.forEach(member => {
        const clone = member.element.cloneNode(true);
        clone.classList.remove("dragging", "drag-source", "desktop-selected");
        clone.tabIndex = -1;
        clone.style.left = `${member.left - desktopDrag.groupMinLeft}px`;
        clone.style.top = `${member.top - desktopDrag.groupMinTop}px`;
        preview.append(clone);
        member.element.classList.add("drag-source");
      });
      document.body.append(preview);
      desktopDrag.preview = preview;
    } else {
      const preview = desktopDrag.button.cloneNode(true);
      preview.classList.add("desktop-drag-preview");
      preview.classList.remove("dragging");
      preview.setAttribute("aria-hidden", "true");
      preview.tabIndex = -1;
      preview.style.width = `${desktopDrag.width}px`;
      preview.style.height = `${desktopDrag.height}px`;
      document.body.append(preview);
      desktopDrag.preview = preview;
      desktopDrag.button.classList.add("drag-source");
    }
  }
  if (desktopDrag.groupMembers.length > 1) {
    desktopDrag.preview.style.left = `${event.clientX - desktopDrag.pointerOffsetX - (desktopDrag.left - desktopDrag.groupMinLeft)}px`;
    desktopDrag.preview.style.top = `${event.clientY - desktopDrag.pointerOffsetY - (desktopDrag.top - desktopDrag.groupMinTop)}px`;
  } else {
    desktopDrag.preview.style.left = `${event.clientX - desktopDrag.pointerOffsetX}px`;
    desktopDrag.preview.style.top = `${event.clientY - desktopDrag.pointerOffsetY}px`;
  }
}
function moveDesktopItem(event) {
  if (!desktopDrag || event.pointerId !== desktopDrag.pointerId || event.currentTarget !== desktopDrag.button) return;
  const surface = desktopDrag.surface;
  const dx = event.clientX - desktopDrag.startX;
  const dy = event.clientY - desktopDrag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) desktopDrag.moved = true;
  if (!desktopDrag.moved) return;
  updateDesktopDragPreview(event);
  const groupDrag = desktopDrag.groupMembers.length > 1;
  const boundedDx = groupDrag
    ? Math.max(4 - desktopDrag.groupMinLeft, Math.min(surface.clientWidth - desktopDrag.groupMaxRight - 4, dx))
    : Math.max(4 - desktopDrag.left, Math.min(surface.clientWidth - desktopDrag.left - desktopDrag.button.offsetWidth - 4, dx));
  const boundedDy = groupDrag
    ? Math.max(4 - desktopDrag.groupMinTop, Math.min(surface.clientHeight - desktopDrag.groupMaxBottom - 4, dy))
    : Math.max(4 - desktopDrag.top, Math.min(surface.clientHeight - desktopDrag.top - desktopDrag.button.offsetHeight - 4, dy));
  desktopDrag.groupMembers.forEach(member => {
    member.item.x = member.left + boundedDx;
    member.item.y = member.top + boundedDy;
    member.element.style.left = `${member.item.x}px`;
    member.element.style.top = `${member.item.y}px`;
    member.element.classList.add("dragging");
  });
  clearDesktopDropTargets();
  const trashTarget = trashElementAt(event.clientX, event.clientY);
  if (trashTarget) trashTarget.classList.add("receiving-trash");
  const targetFolder = !trashTarget ? folderElementAt(event.clientX, event.clientY) : null;
  if (targetFolder) targetFolder.classList.add("receiving-card");
  const targetSurface = !trashTarget && !targetFolder ? surfaceElementAt(event.clientX, event.clientY, desktopDrag.item) : null;
  if (targetSurface) targetSurface.classList.add("receiving-item");
}
function endDesktopDrag(event) {
  if (!desktopDrag || event.pointerId !== desktopDrag.pointerId || event.currentTarget !== desktopDrag.button) return;
  finishDesktopDrag(event);
}
function finishDesktopDrag(event) {
  if (!desktopDrag) return;
  const { button, item, moved, preview, surface, groupMembers } = desktopDrag;
  const groupDrag = groupMembers.length > 1;
  clearTimeout(desktopDrag.recoveryTimer);
  groupMembers.forEach(member => member.element.classList.remove("dragging", "drag-source"));
  preview?.remove();
  const trashTarget = moved ? trashElementAt(event.clientX, event.clientY) : null;
  const targetFolder = moved && !trashTarget ? folderElementAt(event.clientX, event.clientY) : null;
  const targetSurface = moved && !trashTarget && !targetFolder ? surfaceElementAt(event.clientX, event.clientY, item) : null;
  clearDesktopDropTargets();
  let movedToAnotherFolder = false;
  let discarded = false;
  if (trashTarget) {
    discarded = groupDrag ? discardDesktopItems(groupMembers.map(member => member.item)) : discardDesktopItem(item);
  } else if (targetFolder) {
    movedToAnotherFolder = groupDrag
      ? moveDesktopGroupToParent(groupMembers, targetFolder.dataset.folderId)
      : moveItemToParent(item, targetFolder.dataset.folderId);
  } else if (targetSurface) {
    movedToAnotherFolder = groupDrag
      ? moveDesktopGroupToParent(groupMembers, targetSurface.dataset.parentId || null, targetSurface, event.clientX, event.clientY)
      : moveItemToParent(item, targetSurface.dataset.parentId || null, targetSurface, event.clientX, event.clientY);
  }
  if (moved && groupDrag && !movedToAnotherFolder && !discarded) settleDesktopGroup(surface, groupMembers);
  else if (moved && !movedToAnotherFolder && !discarded) settleDesktopItem(surface, button, item);
  if (moved) { ignoreDesktopClickId = item.id; markDirty(); setTimeout(() => { ignoreDesktopClickId = null; }, 0); }
  desktopDrag = null;
  if (movedToAnotherFolder || discarded) render();
}
function cancelDesktopDragFromEvent(event) {
  if (!desktopDrag || event.pointerId !== desktopDrag.pointerId) return;
  cancelDesktopDrag();
}
function recoverDesktopDragAfterLostCapture(event) {
  if (!desktopDrag || event.pointerId !== desktopDrag.pointerId) return;
  const action = desktopDrag;
  clearTimeout(action.recoveryTimer);
  action.recoveryTimer = setTimeout(() => { if (desktopDrag === action) cancelDesktopDrag(); }, 120);
}
function cancelDesktopDrag() {
  if (!desktopDrag) return;
  const action = desktopDrag;
  desktopDrag = null;
  clearTimeout(action.recoveryTimer);
  action.groupMembers.forEach(member => member.element.classList.remove("dragging", "drag-source"));
  action.preview?.remove();
  action.groupMembers.forEach(member => {
    member.item.x = member.left;
    member.item.y = member.top;
    member.element.style.left = `${member.left}px`;
    member.element.style.top = `${member.top}px`;
  });
  clearDesktopDropTargets();
  try { if (action.button.hasPointerCapture(action.pointerId)) action.button.releasePointerCapture(action.pointerId); } catch {}
}
function finishStrayPointerActions(event) {
  if (desktopDrag && event.pointerId === desktopDrag.pointerId) finishDesktopDrag(event);
  if (folderWindowAction && event.pointerId === folderWindowAction.pointerId) finishFolderWindowAction();
  if (desktopSelection && event.pointerId === desktopSelection.pointerId) finishDesktopSelection();
}
function cancelAllPointerActions() {
  cancelDesktopDrag();
  cancelFolderWindowAction();
  cancelDesktopSelection();
  clearDesktopDropTargets();
}
function cancelStalePointerActions() {
  if (desktopDrag || folderWindowAction || desktopSelection) cancelAllPointerActions();
}
function topmostFolderWindowAt(elements) {
  return elements.find(element => element.classList?.contains("folder-window")) || null;
}
function folderElementAt(clientX, clientY) {
  if (!desktopDrag) return null;
  const elements = document.elementsFromPoint(clientX, clientY);
  const topmostWindow = topmostFolderWindowAt(elements);
  const movingIds = new Set(desktopDrag.groupMembers.map(member => member.item.id));
  const movingFolders = desktopDrag.groupMembers.map(member => member.item).filter(item => item.front === undefined);
  return elements.find(folder => {
    if (!folder.classList?.contains("desktop-folder")) return false;
    if (folder.closest(".folder-window") !== topmostWindow) return false;
    if (movingIds.has(folder.dataset.folderId)) return false;
    if (movingFolders.some(movingFolder => getDescendantIds(movingFolder.id).includes(folder.dataset.folderId))) return false;
    const rect = folder.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }) || null;
}
function surfaceElementAt(clientX, clientY, movingItem) {
  const elements = document.elementsFromPoint(clientX, clientY);
  const topmostWindow = topmostFolderWindowAt(elements);
  const windowSurface = elements.find(element => element.classList?.contains("folder-window-content") && element.closest(".folder-window") === topmostWindow);
  let targetSurface = windowSurface;
  if (!targetSurface && !topmostWindow) {
    targetSurface = elements.find(element => element.id === "folder-desktop");
  }
  if (!targetSurface || targetSurface === desktopDrag.surface) return null;
  const targetParentId = targetSurface.dataset.parentId || null;
  const movingFolders = desktopDrag.groupMembers.map(member => member.item).filter(item => item.front === undefined);
  if (targetParentId && movingFolders.some(folder => getDescendantIds(folder.id).includes(targetParentId))) return null;
  const currentParentId = movingItem.front !== undefined ? movingItem.folderId : movingItem.parentId;
  return currentParentId === targetParentId ? null : targetSurface;
}
function moveItemToParent(item, parentId, targetSurface, clientX, clientY) {
  const currentParentId = item.front !== undefined ? item.folderId : item.parentId;
  if (currentParentId === parentId) return false;
  const movingFolder = data.folders.find(folder => folder.id === item.id);
  if (movingFolder && parentId && getDescendantIds(movingFolder.id).includes(parentId)) return false;
  if (item.front !== undefined) item.folderId = parentId;
  else item.parentId = parentId;
  if (targetSurface && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    const rect = targetSurface.getBoundingClientRect();
    const width = item.front !== undefined ? 112 : 104;
    const height = item.front !== undefined ? 88 : 112;
    item.x = Math.max(4, Math.min(targetSurface.clientWidth - width - 4, clientX - rect.left - width / 2));
    item.y = Math.max(4, Math.min(targetSurface.clientHeight - height - 4, clientY - rect.top - height / 2));
  }
  return true;
}
function moveDesktopGroupToParent(members, parentId, targetSurface, clientX, clientY) {
  const items = members.map(member => member.item);
  const currentParentId = items[0].front !== undefined ? items[0].folderId : items[0].parentId;
  if (currentParentId === parentId) return false;
  const movingFolders = items.filter(item => item.front === undefined);
  if (parentId && movingFolders.some(folder => getDescendantIds(folder.id).includes(parentId))) return false;
  const minLeft = Math.min(...members.map(member => member.left));
  const minTop = Math.min(...members.map(member => member.top));
  const maxRight = Math.max(...members.map(member => member.left + member.width));
  const maxBottom = Math.max(...members.map(member => member.top + member.height));
  const groupWidth = maxRight - minLeft;
  const groupHeight = maxBottom - minTop;
  let baseX = 16;
  let baseY = 16;
  if (targetSurface && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    const rect = targetSurface.getBoundingClientRect();
    baseX = Math.max(4, Math.min(Math.max(4, targetSurface.clientWidth - groupWidth - 4), clientX - rect.left - groupWidth / 2));
    baseY = Math.max(4, Math.min(Math.max(4, targetSurface.clientHeight - groupHeight - 4), clientY - rect.top - groupHeight / 2));
  }
  members.forEach(member => {
    if (member.item.front !== undefined) member.item.folderId = parentId;
    else member.item.parentId = parentId;
    member.item.x = baseX + member.left - minLeft;
    member.item.y = baseY + member.top - minTop;
  });
  return true;
}
function clearDesktopDropTargets() {
  document.querySelectorAll(".desktop-folder").forEach(folder => folder.classList.remove("receiving-card"));
  document.querySelectorAll(".desktop-trash").forEach(trash => trash.classList.remove("receiving-trash"));
  document.querySelectorAll(".folder-window-content, #folder-desktop").forEach(element => element.classList.remove("receiving-item"));
}
function trashElementAt(clientX, clientY) {
  const elements = document.elementsFromPoint(clientX, clientY);
  if (topmostFolderWindowAt(elements)) return null;
  return elements.find(element => element.classList?.contains("desktop-trash")) || null;
}
function discardDesktopItem(item) {
  if (item.front !== undefined) {
    if (!window.confirm(`「${item.front}」をゴミ箱に入れますか？\nこの変更は3分後に自動保存されます。`)) return false;
    data.trash.cards.push(item);
    data.cards = data.cards.filter(card => card.id !== item.id);
    return true;
  }
  const folderIds = getDescendantIds(item.id);
  const cardCount = data.cards.filter(card => folderIds.includes(card.folderId)).length;
  if (!window.confirm(`「${item.name}」と中のフォルダ、カード${cardCount}枚をゴミ箱に入れますか？\nこの変更は3分後に自動保存されます。`)) return false;
  data.trash.folders.push(...data.folders.filter(folder => folderIds.includes(folder.id)));
  data.trash.cards.push(...data.cards.filter(card => folderIds.includes(card.folderId)));
  data.folders = data.folders.filter(folder => !folderIds.includes(folder.id));
  data.cards = data.cards.filter(card => !folderIds.includes(card.folderId));
  if (selectedFolder !== "all" && !data.folders.some(folder => folder.id === selectedFolder)) selectedFolder = "all";
  return true;
}
function discardDesktopItems(items) {
  const uniqueItems = [...new Map(items.map(item => [item.id, item])).values()];
  const selectedFolders = uniqueItems.filter(item => item.front === undefined);
  const selectedCards = uniqueItems.filter(item => item.front !== undefined);
  const folderIds = new Set(selectedFolders.flatMap(folder => getDescendantIds(folder.id)));
  const cardIds = new Set(selectedCards.map(card => card.id));
  const foldersToTrash = data.folders.filter(folder => folderIds.has(folder.id));
  const cardsToTrash = data.cards.filter(card => cardIds.has(card.id) || folderIds.has(card.folderId));
  const selectedCount = selectedFolders.length + selectedCards.length;
  const contents = foldersToTrash.length > selectedFolders.length || cardsToTrash.length > selectedCards.length
    ? `（中身を含めてフォルダ${foldersToTrash.length}個・カード${cardsToTrash.length}枚）`
    : `（フォルダ${foldersToTrash.length}個・カード${cardsToTrash.length}枚）`;
  if (!window.confirm(`選択した${selectedCount}個をまとめてゴミ箱に入れますか？\n${contents}\nこの変更は3分後に自動保存されます。`)) return false;
  data.trash.folders.push(...foldersToTrash);
  data.trash.cards.push(...cardsToTrash);
  data.folders = data.folders.filter(folder => !folderIds.has(folder.id));
  data.cards = data.cards.filter(card => !cardIds.has(card.id) && !folderIds.has(card.folderId));
  selectedDesktopItemIds.clear();
  if (selectedFolder !== "all" && !data.folders.some(folder => folder.id === selectedFolder)) selectedFolder = "all";
  return true;
}
function renderDashboard() {
  const cardCount = data.cards.length; const neglected = data.cards.filter(cardIsNeglected);
  document.getElementById("due-count").textContent = cardCount;
  const startReviewButton = document.getElementById("start-review");
  startReviewButton.disabled = cardCount === 0;
  startReviewButton.setAttribute("aria-label", cardCount ? `全てのカード${cardCount}枚の練習をはじめる` : "練習するカードはありません");
  document.getElementById("header-warning-count").textContent = neglected.length;
  document.getElementById("header-warning").setAttribute("aria-label", `最近練習していないカードは${neglected.length}枚です。クリックして確認`);
  document.getElementById("header-warning").disabled = neglected.length === 0;
  document.querySelectorAll("[data-practice-range]").forEach(button => {
    const cardCount = cardsForPracticeRange(button.dataset.practiceRange).length;
    button.disabled = cardCount === 0;
    button.setAttribute("aria-label", cardCount ? `${cardCount}枚を練習する` : "練習するカードはありません");
  });
}
function renderFolderPractice() {
  const panel = document.getElementById("folder-practice");
  const isFolderOpen = selectedFolder !== "all" && selectedFolder !== "neglected" && data.folders.some(folder => folder.id === selectedFolder);
  panel.hidden = !isFolderOpen;
  if (!isFolderOpen) return;
  const cards = getSelectedFolderCards();
  const folderName = getFolderName(selectedFolder);
  const button = document.getElementById("start-folder-practice");
  document.getElementById("folder-practice-title").textContent = `「${folderName}」のカードをすべて練習`;
  document.getElementById("folder-practice-description").textContent = cards.length
    ? `このフォルダと中のフォルダにある ${cards.length} 枚を、まとめて練習します。`
    : "このフォルダには、まだ練習できるカードがありません。";
  button.disabled = cards.length === 0;
  button.innerHTML = cards.length ? `${cards.length}枚を練習する <span>→</span>` : "カードがありません";
}
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function fillFolderSelect(select, includeAll = false, excludedIds = new Set()) { select.replaceChildren(); select.add(new Option("Deskに置く", "")); data.folders.filter(folder => !excludedIds.has(folder.id)).forEach(folder => { const depth = folderDepth(folder); select.add(new Option(`${"　".repeat(depth)}${folder.name}`, folder.id)); }); }
function folderDepth(folder) { let depth = 0; let current = folder; while (current.parentId) { depth++; current = data.folders.find(item => item.id === current.parentId); if (!current) break; } return depth; }
function openCardDialog(card = null, destinationFolderId = undefined) {
  editingCardId = card?.id || null;
  fillFolderSelect(document.getElementById("card-folder"));
  document.getElementById("card-form").reset();
  document.getElementById("card-dialog-label").textContent = card ? "EDIT MEMORY" : "NEW MEMORY";
  document.getElementById("card-dialog-title").textContent = card ? "暗記カードを編集" : "暗記カードを追加";
  document.getElementById("save-card").textContent = card ? "変更を反映する" : "追加する";
  if (card) {
    document.getElementById("card-front").value = card.front;
    document.getElementById("card-back").value = card.back;
    document.getElementById("card-memo").value = card.memo || "";
    document.getElementById("card-folder").value = card.folderId || "";
  } else if (destinationFolderId !== undefined) {
    document.getElementById("card-folder").value = destinationFolderId || "";
  } else if (selectedFolder !== "all" && selectedFolder !== "neglected") {
    document.getElementById("card-folder").value = selectedFolder;
  }
  showDialog(document.getElementById("card-dialog"));
  document.getElementById("card-front").focus();
}
function openFolderDialog(folder = null, destinationFolderId = undefined) {
  editingFolderId = folder?.id || null;
  const excludedIds = folder ? new Set(getDescendantIds(folder.id)) : new Set();
  fillFolderSelect(document.getElementById("parent-folder"), true, excludedIds);
  document.getElementById("folder-form").reset();
  document.getElementById("folder-dialog-label").textContent = folder ? "EDIT FOLDER" : "NEW FOLDER";
  document.getElementById("folder-dialog-title").textContent = folder ? "フォルダを編集" : "フォルダを追加";
  document.getElementById("save-folder").textContent = folder ? "変更を反映する" : "作成する";
  if (folder) {
    document.getElementById("folder-name").value = folder.name;
    document.getElementById("parent-folder").value = folder.parentId || "";
  } else if (destinationFolderId !== undefined) {
    document.getElementById("parent-folder").value = destinationFolderId || "";
  } else if (selectedFolder !== "all" && selectedFolder !== "neglected") {
    document.getElementById("parent-folder").value = selectedFolder;
  }
  showDialog(document.getElementById("folder-dialog"));
  document.getElementById("folder-name").focus();
}
function saveCard(event) {
  event.preventDefault();
  const front = document.getElementById("card-front").value.trim();
  const back = document.getElementById("card-back").value.trim();
  const memo = document.getElementById("card-memo").value.trim();
  const folderId = document.getElementById("card-folder").value || null;
  if (!front || !back) return;
  const editingCard = data.cards.find(card => card.id === editingCardId);
  if (editingCard) {
    const moved = editingCard.folderId !== folderId;
    Object.assign(editingCard, { front, back, memo, folderId });
    if (moved) {
      const groupIndex = data.cards.filter(card => card.id !== editingCard.id && card.folderId === folderId).length;
      editingCard.x = 20 + (groupIndex % 5) * 145;
      editingCard.y = 152 + Math.floor(groupIndex / 5) * 130;
    }
  } else {
    const groupIndex = data.cards.filter(card => card.folderId === folderId).length;
    data.cards.unshift({ id: id("card"), createdAt: Date.now(), front, back, memo, folderId, lastPracticed: null, interval: 1, x: 20 + (groupIndex % 5) * 145, y: 152 + Math.floor(groupIndex / 5) * 130 });
  }
  editingCardId = null;
  markDirty();
  closeDialog(document.getElementById("card-dialog"));
  render();
}
function saveFolder(event) {
  event.preventDefault();
  const name = document.getElementById("folder-name").value.trim();
  const parentId = document.getElementById("parent-folder").value || null;
  if (!name) return;
  const editingFolder = data.folders.find(folder => folder.id === editingFolderId);
  if (editingFolder) {
    const moved = editingFolder.parentId !== parentId;
    editingFolder.name = name;
    editingFolder.parentId = parentId;
    if (moved) {
      const groupIndex = data.folders.filter(folder => folder.id !== editingFolder.id && folder.parentId === parentId).length;
      editingFolder.x = 20 + (groupIndex % 5) * 140;
      editingFolder.y = 16 + Math.floor(groupIndex / 5) * 140;
    }
  } else {
    const groupIndex = data.folders.filter(folder => folder.parentId === parentId).length;
    data.folders.push({ id: id("folder"), createdAt: Date.now(), name, parentId, x: 20 + (groupIndex % 5) * 140, y: 16 + Math.floor(groupIndex / 5) * 140 });
  }
  editingFolderId = null;
  markDirty();
  closeDialog(document.getElementById("folder-dialog"));
  render();
}
function deleteCard(card) {
  if (!discardDesktopItem(card)) return;
  markDirty();
  render();
}
function deleteSelectedFolder() {
  const folder = data.folders.find(item => item.id === selectedFolder);
  if (!folder) return;
  if (!discardDesktopItem(folder)) return;
  selectedFolder = "all";
  markDirty();
  render();
}

function isCunecuneCard(card) {
  return card.front.trim().toLowerCase() === "crazy";
}
function updateReviewCharacter(container, visible) {
  container.querySelector(".review-character")?.remove();
  container.classList.toggle("has-review-character", visible);
  if (!visible) return;
  const character = document.createElement("img");
  character.className = "review-character";
  character.src = "cunecuneboy.png";
  character.alt = "";
  character.draggable = false;
  container.append(character);
}
function startReview(queue) {
  // 複数枚をまとめて練習する場合は、入口にかかわらず毎回ランダム順にする。
  reviewQueue = queue.length > 1 ? shuffleCards(queue) : [...queue];
  reviewIndex = 0;
  answerVisible = false;
  updateReviewCharacter(document.querySelector(".direction-dialog-content"), reviewQueue.some(isCunecuneCard));
  if (!reviewQueue.length) { openReviewDialog(); return; }
  showDialog(document.getElementById("review-direction-dialog"));
}
function beginReview(direction) {
  reviewDirection = direction;
  closeDialog(document.getElementById("review-direction-dialog"));
  openReviewDialog();
}
function openReviewDialog() {
  showDialog(document.getElementById("review-dialog"));
  renderReview();
}
function renderReview() {
  const root = document.getElementById("review-content");
  if (!reviewQueue.length || reviewIndex >= reviewQueue.length) { root.innerHTML = `<div class="review-finished"><div><div class="check">✓</div><h2>復習、おつかれさま！</h2><p>少しずつ続けることが、いちばんの近道です。</p><button id="close-review" class="primary-button" type="button">Deskに戻す</button></div></div>`; root.querySelector("button").onclick = () => { closeDialog(document.getElementById("review-dialog")); render(); }; return; }
  const card = reviewQueue[reviewIndex];
  const meaningToWord = reviewDirection === "meaning-to-word";
  const question = meaningToWord ? card.back : card.front;
  const answer = meaningToWord ? card.front : card.back;
  const directionLabel = meaningToWord ? "説明を見て、単語を答える" : "単語を見て、説明を答える";
  const memo = answerVisible && card.memo ? `<div class="review-memo"><strong>メモ</strong><p>${escapeHtml(card.memo)}</p></div>` : "";
  root.innerHTML = `<div class="review-box"><p class="review-progress">${reviewIndex + 1} / ${reviewQueue.length}</p><div class="flashcard"><small>${escapeHtml(getFolderName(card.folderId))} · ${directionLabel}</small><h2 class="${meaningToWord && answerVisible ? "review-question-secondary" : ""}">${escapeHtml(question)}</h2>${answerVisible ? `<p class="answer-large${meaningToWord ? " answer-large-word" : ""}">${escapeHtml(answer)}</p>${memo}` : ""}</div>${answerVisible ? `<div class="answer-actions"><button id="again" class="again-button" type="button">まだあやしい</button><button id="remember" class="remember-button" type="button">思い出せた！</button></div>` : `<button id="reveal" class="dark-button reveal-button" type="button">答えを見る</button>`}<button id="finish" class="text-button finish-review" type="button">復習をやめる</button></div>`;
  const reveal = document.getElementById("reveal"); if (reveal) reveal.onclick = () => { answerVisible = true; renderReview(); };
  updateReviewCharacter(root.querySelector(".review-box"), isCunecuneCard(card));
  const remember = document.getElementById("remember"); if (remember) remember.onclick = () => recordReview(card, true);
  const again = document.getElementById("again"); if (again) again.onclick = () => recordReview(card, false);
  document.getElementById("finish").onclick = () => { closeDialog(document.getElementById("review-dialog")); render(); };
}
function recordReview(card, remembered) { card.lastPracticed = Date.now(); card.interval = remembered ? Math.min(card.interval * 2 + 1, 30) : 1; card.needsReview = !remembered; markDirty(); reviewIndex++; answerVisible = false; renderDashboard(); renderReview(); }

// p5.js draws the slow, calm movement behind the review summary.
if (typeof p5 === "function") {
  new p5((p) => {
    let host;
    p.setup = () => { host = document.getElementById("p5-accent"); const canvas = p.createCanvas(host.clientWidth || 400, host.clientHeight || 211); canvas.parent(host); p.noStroke(); };
    p.draw = () => { p.clear(); const t = p.frameCount * .009; p.fill(206, 224, 126, 24); p.circle(p.width * (.8 + Math.sin(t) * .06), p.height * (.28 + Math.cos(t) * .08), 190); p.fill(232, 108, 72, 17); p.circle(p.width * (.93 + Math.cos(t * .8) * .05), p.height * (.88 + Math.sin(t) * .1), 170); p.fill(255, 255, 255, 8); p.circle(p.width * .55, p.height * (.15 + Math.cos(t * 1.4) * .05), 110); };
    p.windowResized = () => { if (host) p.resizeCanvas(host.clientWidth, host.clientHeight); };
  });
}
