/* ==== НАСТРОЙКИ ==== */
const VK_APP_ID = 7100465;
const VK_API_VERSION = "5.131";
// Право app_widget: VK спрашивает у администратора, можно ли приложению обновлять виджет.
const WIDGET_PERMISSION = 64;

const STORAGE_KEY = "vk_widget_editor_v2";
// Прежний формат хранил копию кода на каждое нажатие клавиши. Берём из него последнюю
// версию, а сам ключ не трогаем: там вся история, ранние скрипты могут жить только в ней.
const LEGACY_STORAGE_KEY = "vk_widget_editor_state";

// preserve-inline оставляет однострочные объекты в строку: иначе список сообщений
// из шаблона veoomsk разъезжается с 112 строк до 250.
const BEAUTIFY_OPTIONS = { indent_size: 2, brace_style: "collapse,preserve-inline" };
const LOG_PREVIEW_LENGTH = 80;

/* ==== ШАБЛОНЫ ==== */
// Тип виджета -> подпись и пример кода. Список типов на странице строится отсюда.
const WIDGET_TYPES = {
  text: { label: "Text", template: { title: "Цитата дня", text: "«Нам нужно гордиться»" } },
  list: { label: "List", template: { title: "Рестораны", rows: [{ title: "Корюшка", button: "Забронировать", button_url: "#", descr: "Вид на стрелку" }] } },
  table: { label: "Table", template: { title: "Таблица", head: [{ text: "Колонка 1" }], body: [[{ text: "Ячейка" }]] } },
  tiles: { label: "Tiles", template: { title: "Фильмы", tiles: [{ title: "Доктор Стрэндж", descr: "Фэнтези", url: "#", link: "Купить", link_url: "#" }] } },
  compact_list: { label: "Compact list", template: { title: "Компактный список", rows: [{ title: "Элемент", button: "Подробнее", button_url: "#", descr: "Описание" }] } },
  cover_list: { label: "Cover list", template: { title: "Рестораны", rows: [{ title: "Корюшка", button: "Забронировать", cover_id: "12345_6789", url: "#", button_url: "#", descr: "Описание" }] } },
  match: { label: "Match", template: { title: "Матч", match: { state: "Идёт первый тайм", team_a: { name: "Зенит" }, team_b: { name: "Спартак" }, score: { team_a: 2, team_b: 0 } } } },
  matches: { label: "Matches", template: { title: "Список матчей", matches: [{ team_a: { name: "Зенит" }, team_b: { name: "Спартак" }, score: { team_a: 2, team_b: 0 }, icon_id: "123_456" }] } },
  donation: { label: "Donation", template: { title: "Поддержать", text: "На помощь животным", button_url: "#", goal: 80000, funded: 7000, backers: 20, currency: "RUB", date: { start: 1700000000, end: 1701000000 } } },
};

const RANDOM_SNIPPET = `// Случайные числа в VKScript: Math.random здесь нет, поэтому берём случайных друзей
// донорского профиля. Разбор подхода: https://gist.github.com/Vovanda/b47f75287542eb1f62704d5881b3d1d8
var count_of_randoms = 1;
var resp = API.friends.get({ user_id: 3972090, order: "random", count: count_of_randoms });
var rnd_ids = resp.items;

var rnd_values = [];
var i = 0;
while (i < count_of_randoms) {
    var id = parseInt(rnd_ids[i]) % 1000000;  // сводим к 32-бит числу
    var h = (id * 1664525 + 1013904223) % 1000000;
    rnd_values.push(h / 1000000);
    i = i + 1;
}`;

/* ==== ЭЛЕМЕНТЫ ==== */
const byId = id => document.getElementById(id);
const typeSelect = byId("widgetType");
const undoBtn = byId("undoBtn");
const redoBtn = byId("redoBtn");
const templateBtn = byId("templateBtn");
const randomBtn = byId("randomBtn");
const formatBtn = byId("formatBtn");
const permissionBtn = byId("permissionBtn");
const previewBtn = byId("previewBtn");
const vkStatus = byId("vkStatus");
const logBox = byId("log");
const logList = byId("logList");
const clearLogBtn = byId("clearLogBtn");

/* ==== ХРАНЕНИЕ ==== */
// localStorage в iframe VK бывает закрыт: приватный режим, запрет сторонних данных.
// Тогда редактор работает как обычно, просто не помнит код между открытиями.
function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function migrateLegacyState() {
  const legacy = readStorage(LEGACY_STORAGE_KEY);
  const code = {};
  for (const [type, versions] of Object.entries(legacy?.history ?? {})) {
    if (versions.length) code[type] = versions[versions.length - 1];
  }
  return { widgetType: legacy?.widgetType, code };
}

function loadState() {
  const state = readStorage(STORAGE_KEY) ?? migrateLegacyState();
  if (!(state.widgetType in WIDGET_TYPES)) state.widgetType = "list";
  state.code ??= {};
  return state;
}

const state = loadState();
const saveState = () => writeStorage(STORAGE_KEY, state);

/* ==== РЕДАКТОР ==== */
let editor;
// У каждого типа свой документ CodeMirror: переключение типа не смешивает
// истории отмены, и «Отменить» не перескакивает в код другого виджета.
const docs = {};

function templateCode(type) {
  return "return " + JSON.stringify(WIDGET_TYPES[type].template, null, 2) + ";";
}

function docFor(type) {
  docs[type] ??= new CodeMirror.Doc(state.code[type] ?? templateCode(type), "javascript");
  return docs[type];
}

function updateHistoryButtons() {
  const { undo, redo } = editor.historySize();
  undoBtn.disabled = !undo;
  redoBtn.disabled = !redo;
}

function onCodeChanged() {
  state.code[state.widgetType] = editor.getValue();
  saveState();
  updateHistoryButtons();
}

function switchType(type) {
  state.widgetType = type;
  editor.swapDoc(docFor(type));
  saveState();
  updateHistoryButtons();
}

function createEditor() {
  editor = CodeMirror.fromTextArea(byId("editor"), {
    mode: "javascript",
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    extraKeys: { "Ctrl-Enter": showPreview, "Cmd-Enter": showPreview },
  });
  editor.swapDoc(docFor(state.widgetType));
  editor.on("changes", onCodeChanged);
}

/* ==== ДЕЙСТВИЯ С КОДОМ ==== */
// Все замены идут через CodeMirror, поэтому любую из них отменяет «Отменить».
function applyTemplate() {
  editor.setValue(templateCode(state.widgetType));
}

function insertRandomSnippet() {
  editor.replaceRange(RANDOM_SNIPPET + "\n\n", { line: 0, ch: 0 });
}

function formatCode() {
  const source = editor.getValue();
  // js-beautify разносит «items@.id» в «items @.id». В JS такого оператора нет,
  // а примет ли VKScript пробел, не проверено, поэтому склеиваем как было.
  const formatted = js_beautify(source, BEAUTIFY_OPTIONS).replace(/([\w\])])\s+@\./g, "$1@.");
  if (formatted === source) return;
  const { line } = editor.getCursor();
  editor.setValue(formatted);
  editor.setCursor(Math.min(line, editor.lineCount() - 1));
}

/* ==== ЖУРНАЛ ==== */
function logMessage(text) {
  const item = document.createElement("li");
  const line = new Date().toLocaleTimeString("ru-RU") + " " + text;
  if (line.length <= LOG_PREVIEW_LENGTH) {
    item.textContent = line;
  } else {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const full = document.createElement("pre");
    summary.textContent = line.slice(0, LOG_PREVIEW_LENGTH) + "…";
    full.textContent = line;
    details.append(summary, full);
    item.append(details);
  }
  logList.prepend(item);
  logBox.hidden = false;
}

function clearLog() {
  logList.replaceChildren();
  logBox.hidden = true;
}

/* ==== VK ==== */
function showPreview() {
  if (previewBtn.disabled) return;
  try {
    VK.callMethod("showAppWidgetPreviewBox", state.widgetType, editor.getValue());
  } catch (error) {
    logMessage("Предпросмотр не открылся: " + error.message);
  }
}

function requestPermission() {
  VK.callMethod("showGroupSettingsBox", WIDGET_PERMISSION);
}

function onVkReady() {
  VK.addCallback("onAppWidgetPreviewFail", event =>
    logMessage("VK не показал предпросмотр: " + JSON.stringify(event)));
  previewBtn.disabled = false;
  permissionBtn.disabled = false;
  vkStatus.textContent = "Подключено к VK";
}

function connectVk() {
  if (!window.VK?.init) {
    vkStatus.textContent = "Скрипты VK не загрузились: предпросмотр недоступен";
    return;
  }
  try {
    VK.init(onVkReady, () => {
      vkStatus.textContent = "VK отказал в подключении: предпросмотр недоступен";
    }, VK_API_VERSION, { apiId: VK_APP_ID });
  } catch {
    // Вне iframe приложения VK.init падает сразу с «Wrong window.name property».
    vkStatus.textContent = "Открыто вне VK: предпросмотр и права работают только в приложении";
  }
}

/* ==== ЗАПУСК ==== */
function fillTypeSelect() {
  for (const [type, { label }] of Object.entries(WIDGET_TYPES)) {
    typeSelect.add(new Option(label, type));
  }
  typeSelect.value = state.widgetType;
}

function bindControls() {
  typeSelect.addEventListener("change", () => switchType(typeSelect.value));
  undoBtn.addEventListener("click", () => editor.undo());
  redoBtn.addEventListener("click", () => editor.redo());
  templateBtn.addEventListener("click", applyTemplate);
  randomBtn.addEventListener("click", insertRandomSnippet);
  formatBtn.addEventListener("click", formatCode);
  previewBtn.addEventListener("click", showPreview);
  permissionBtn.addEventListener("click", requestPermission);
  clearLogBtn.addEventListener("click", clearLog);
}

fillTypeSelect();
createEditor();
bindControls();
updateHistoryButtons();
connectVk();
