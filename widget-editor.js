/* ==== НАСТРОЙКИ ==== */
const VK_APP_ID = 7100465;
const VK_API_VERSION = "5.131";
// Право app_widget: VK спрашивает у администратора, можно ли приложению обновлять виджет.
const WIDGET_PERMISSION = 64;

// Код хранится по сообществу: у каждой группы свой виджет, а общий слот на тип
// подсовывал в одну группу скрипт другой. id группы VK передаёт в адресе фрейма:
// group_id у iframe-приложений, vk_group_id у мини-приложений; 0 — открыто не из группы.
function readGroupId() {
  const params = new URLSearchParams(location.search);
  const id = params.get("group_id") ?? params.get("vk_group_id");
  return id && id !== "0" ? id : null;
}
const GROUP_ID = readGroupId();
const SHARED_STORAGE_KEY = "vk_widget_editor_v2";
const STORAGE_KEY = GROUP_ID ? `${SHARED_STORAGE_KEY}:group:${GROUP_ID}` : SHARED_STORAGE_KEY;
// Прежний формат хранил копию кода на каждое нажатие клавиши. Берём из него последнюю
// версию, а сам ключ не трогаем: там вся история, ранние скрипты могут жить только в ней.
const LEGACY_STORAGE_KEY = "vk_widget_editor_state";

// preserve-inline оставляет однострочные объекты в строку: иначе список сообщений
// из шаблона veoomsk разъезжается с 112 строк до 250.
const BEAUTIFY_OPTIONS = { indent_size: 2, brace_style: "collapse,preserve-inline" };
const LOG_PREVIEW_LENGTH = 80;
const LOG_LIMIT = 10;

/* ==== СНИППЕТ СЛУЧАЙНОСТИ ==== */
// Типы виджетов, их схемы и шаблоны живут в widget-types.js, форма — в widget-form.js.
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
const formTab = byId("formTab");
const codeTab = byId("codeTab");
const formView = byId("formView");

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

// У группы ещё нет своего кода: берём общий слот, а без него — старую историю.
// Там мог лежать скрипт другой группы, поэтому запуск об этом предупредит.
let inheritedCode = false;
function inheritState() {
  const inherited = (GROUP_ID && readStorage(SHARED_STORAGE_KEY)) ?? migrateLegacyState();
  inheritedCode = Boolean(GROUP_ID) && Object.keys(inherited.code ?? {}).length > 0;
  return inherited;
}

function loadState() {
  const state = readStorage(STORAGE_KEY) ?? inheritState();
  if (!(state.widgetType in WIDGET_TYPES)) state.widgetType = "list";
  if (state.view !== "form") state.view = "code";
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
  return widgetToCode(WIDGET_TYPES[type].template);
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

// «Шаблон» затирал бы готовый код одним нажатием, поэтому он предлагается только
// пустому редактору. Сбросить к шаблону нарочно — очистить код, кнопка оживёт.
function updateTemplateButton() {
  templateBtn.disabled = editor.getValue().trim() !== "";
}

function onCodeChanged() {
  state.code[state.widgetType] = editor.getValue();
  saveState();
  updateHistoryButtons();
  updateTemplateButton();
  // Код поменялся не из формы — отмена, шаблон, правка во вкладке «Код»: форма вычитывает его заново.
  if (state.view === "form" && !formWriting) refreshForm();
}

function switchType(type) {
  state.widgetType = type;
  editor.swapDoc(docFor(type));
  saveState();
  updateHistoryButtons();
  updateTemplateButton();
  if (state.view === "form") refreshForm();
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

/* ==== ВИДЫ ==== */
// Форма и код — два вида одного документа. Форма пишет в документ с origin "+form":
// CodeMirror склеивает такие правки, и «Отменить» откатывает ввод словами, а не по букве.
let formWriting = false;

// origin без «+» CodeMirror не склеивает с соседними правками: так форма пишет шаги,
// которые должны отменяться отдельно, — например, вставку шаблона.
function writeCodeFromForm(code, origin = "+form") {
  const doc = editor.getDoc();
  formWriting = true;
  doc.replaceRange(code, doc.posFromIndex(0), doc.posFromIndex(doc.getValue().length), origin);
  formWriting = false;
}

// Иконка нового элемента — главное фото текущего сообщества (формат club<id> из доки VK),
// а не пользователя: виджет висит в сообществе.
const FORM_DEFAULTS = { icon_id: GROUP_ID ? "club" + GROUP_ID : "" };

function refreshForm() {
  renderForm(formView, state.widgetType, editor.getValue(), writeCodeFromForm, FORM_DEFAULTS);
}

function showView(view) {
  state.view = view;
  saveState();
  const inForm = view === "form";
  formTab.setAttribute("aria-selected", String(inForm));
  codeTab.setAttribute("aria-selected", String(!inForm));
  editor.getWrapperElement().hidden = inForm;
  formView.hidden = !inForm;
  // Сниппет и форматирование работают с текстом кода — в форме им нечего делать.
  randomBtn.disabled = inForm;
  formatBtn.disabled = inForm;
  if (inForm) {
    refreshForm();
  } else {
    editor.refresh();
  }
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
  // VK повторяет одну и ту же ошибку на каждый предпросмотр: подряд это один факт,
  // а не новые строки, поэтому растёт счётчик у верхней записи.
  const top = logList.firstElementChild;
  if (top?.dataset.text === text) {
    top.dataset.count = Number(top.dataset.count) + 1;
    top.querySelector(".log-count").textContent = "×" + top.dataset.count;
    return;
  }
  const item = document.createElement("li");
  item.dataset.text = text;
  item.dataset.count = "1";
  const count = document.createElement("span");
  count.className = "log-count";
  const line = new Date().toLocaleTimeString("ru-RU") + " " + text;
  if (line.length <= LOG_PREVIEW_LENGTH) {
    item.append(line, count);
  } else {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const full = document.createElement("pre");
    summary.append(line.slice(0, LOG_PREVIEW_LENGTH) + "…", count);
    full.textContent = line;
    details.append(summary, full);
    item.append(details);
  }
  logList.prepend(item);
  // Старые ошибки уже не про текущий код: держим только последние.
  while (logList.children.length > LOG_LIMIT) logList.lastElementChild.remove();
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
  vkStatus.textContent = GROUP_ID ? "Подключено к VK, сообщество " + GROUP_ID : "Подключено к VK";
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
  formTab.addEventListener("click", () => showView("form"));
  codeTab.addEventListener("click", () => showView("code"));
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
showView(state.view);
updateHistoryButtons();
updateTemplateButton();
if (inheritedCode) {
  logMessage("У этого сообщества ещё не было своего кода: взят общий, сохранённый до разделения по группам. Он мог быть от другой группы, проверь перед установкой.");
}
connectVk();
