/* Смок редактора: открывает страницу настоящим браузером и проверяет то, что
   руками проверяется долго, — скрипт не упал, типы переключаются, отмена и
   форматирование работают, код переживает перезагрузку, вёрстка не уезжает вбок.

   Настоящий iframe VK здесь не поднять, поэтому страница открывается дважды:
   как есть (вне VK — кнопки VK выключены и это сказано) и с поддельным объектом
   VK, который записывает вызовы. Так видно, что предпросмотр и права уходят в VK
   с правильными аргументами. Как VK их покажет, смотрят уже в самом приложении.

   Запуск (playwright ставится разово, в репозиторий не уезжает):

       npm i --no-save playwright && npx playwright install chromium
       python -m http.server 8743 &
       node tools/smoke.mjs

   SMOKE_CHROME — путь к уже установленному Chromium, если ставить свой не хочется. */

import { chromium } from "playwright";

const URL = process.env.SMOKE_URL || "http://localhost:8743/index.htm";
const SHOTS = process.env.SMOKE_SHOTS;   // папка для скриншотов по ширинам, по желанию
const WIDTHS = [390, 768, 1200];

const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok; };

const browser = await chromium.launch(process.env.SMOKE_CHROME ? { executablePath: process.env.SMOKE_CHROME } : {});

async function openPage({ fakeVk, before } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", e => problems.push("ошибка скрипта: " + e.message));
  if (fakeVk) {
    // Скрипты VK подменяются заглушкой: init сразу успешен, вызовы копятся в __vkCalls.
    await page.route(/vk\.com\/js\/api\//, route => route.fulfill({
      contentType: "text/javascript",
      body: `window.__vkCalls = []; window.__vkCallbacks = {};
             window.VK = { init(ok) { ok(); },
                           callMethod(...args) { __vkCalls.push(args); },
                           addCallback(name, fn) { __vkCallbacks[name] = fn; } };`,
    }));
  }
  if (before) await page.addInitScript(before);
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForSelector(".CodeMirror");
  return page;
}

// Init-скрипт выполняется при каждой загрузке, включая reload: чистим хранилище
// один раз на вкладку, иначе проверка «код пережил перезагрузку» стирает сам код.
const clearStorageOnce = () => {
  if (sessionStorage.getItem("smokeCleared")) return;
  sessionStorage.setItem("smokeCleared", "1");
  localStorage.clear();
};

const code = page => page.evaluate(() => document.querySelector(".CodeMirror").CodeMirror.getValue());
const setCode = (page, value) => page.evaluate(v => document.querySelector(".CodeMirror").CodeMirror.setValue(v), value);

/* ==== ВНЕ VK ==== */
let page = await openPage({ before: clearStorageOnce });
const outside = await page.evaluate(() => ({
  status: document.getElementById("vkStatus").textContent,
  preview: document.getElementById("previewBtn").disabled,
  permission: document.getElementById("permissionBtn").disabled,
  logHidden: document.getElementById("log").hidden,
  types: document.getElementById("widgetType").options.length,
}));
console.log("вне VK:", JSON.stringify(outside));
check(/вне VK/.test(outside.status), "статус не говорит, что страница открыта вне VK: " + outside.status);
check(outside.preview && outside.permission, "кнопки VK включены вне VK");
check(outside.logHidden, "журнал сообщений виден, хотя сообщений нет");
check(outside.types === 9, "типов виджета не 9: " + outside.types);
check((await code(page)).includes("Цитата дня"), "при первом запуске нет шаблона текста");

/* ==== ТИПЫ И ОТМЕНА ==== */
await setCode(page, 'return {"title":"мой текст"};');
await page.selectOption("#widgetType", "list");
check((await code(page)).includes('"rows"'), "у списка не подставился шаблон");
check(await page.isDisabled("#undoBtn"), "«Отменить» в свежем типе активна: история чужого типа");
await page.selectOption("#widgetType", "text");
check((await code(page)).includes("мой текст"), "код текста потерялся при переключении типа");

await page.click("#templateBtn");
check((await code(page)).includes("Цитата дня"), "«Шаблон» не заменил код");
await page.click("#undoBtn");
check((await code(page)).includes("мой текст"), "«Отменить» не вернула код после шаблона");
await page.click("#redoBtn");
check((await code(page)).includes("Цитата дня"), "«Повторить» не сработала");

await page.click("#randomBtn");
check((await code(page)).startsWith("// Случайные числа"), "генератор не вставился в начало");
await page.click("#undoBtn");

/* ==== ФОРМАТИРОВАНИЕ ==== */
await setCode(page, 'var ids=API.friends.get({"user_id":1}).items@.id;\nreturn {"title":"x","rows":[ids]};');
await page.click("#formatBtn");
const formatted = await code(page);
console.log("после форматирования:\n" + formatted);
check(formatted.includes("items@.id"), "форматирование разорвало «@.»");
check(formatted.includes("var ids = API"), "форматирование не расставило пробелы");
await page.click("#formatBtn");
check(await code(page) === formatted, "повторное форматирование меняет код");

/* ==== ПАМЯТЬ ==== */
await setCode(page, "return {\"title\":\"после перезагрузки\"};");
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".CodeMirror");
check((await code(page)).includes("после перезагрузки"), "код не пережил перезагрузку");
await page.context().close();

// Старый формат хранил массив версий на тип; берём последнюю, старый ключ удаляем.
page = await openPage({ before: () => {
  if (sessionStorage.getItem("seeded")) return;
  sessionStorage.setItem("seeded", "1");
  localStorage.clear();
  localStorage.setItem("vk_widget_editor_state", JSON.stringify({
    widgetType: "list", history: { list: ["return 1;", "return 2;"], text: [] } }));
} });
check(await page.inputValue("#widgetType") === "list", "после миграции открыт не прежний тип");
check(await code(page) === "return 2;", "миграция взяла не последнюю версию кода");
check(await page.evaluate(() => localStorage.getItem("vk_widget_editor_state")) === null, "старый ключ не удалён");
await page.context().close();

/* ==== ВНУТРИ VK (подделка) ==== */
page = await openPage({ fakeVk: true, before: clearStorageOnce });
check(!(await page.isDisabled("#previewBtn")), "в VK кнопка предпросмотра выключена");
await page.click("#previewBtn");
await page.click(".CodeMirror");
await page.keyboard.press("Control+Enter");
await page.click("#permissionBtn");
const calls = await page.evaluate(() => window.__vkCalls);
console.log("вызовы VK:", JSON.stringify(calls).slice(0, 200));
check(calls[0]?.[0] === "showAppWidgetPreviewBox" && calls[0][1] === "text" && calls[0][2].includes("Цитата дня"),
  "предпросмотр ушёл в VK не с теми аргументами");
check(calls[1]?.[0] === "showAppWidgetPreviewBox", "Ctrl+Enter не открыл предпросмотр");
check(calls[2]?.[0] === "showGroupSettingsBox" && calls[2][1] === 64, "права запрошены не с тем битом");
await page.evaluate(() => window.__vkCallbacks.onAppWidgetPreviewFail({ error_msg: "тест" }));
check(!(await page.evaluate(() => document.getElementById("log").hidden)), "ошибка VK не показана в журнале");

/* ==== ШИРИНЫ ==== */
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log("ширина " + width + ": вылет " + overflow + "px");
  check(overflow <= 1, "на " + width + "px страница уезжает вбок на " + overflow + "px");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/width-${width}.png`, fullPage: true });
}

await browser.close();
if (problems.length) {
  console.error("\nсломано:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("\nвсё на месте");
