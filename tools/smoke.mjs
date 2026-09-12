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

// before и его аргумент уходят в addInitScript: он выполняется до скриптов страницы
// при каждой загрузке, включая reload.
async function openPage({ fakeVk, before, beforeArg, colorScheme = "light" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme });
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
  if (before) await page.addInitScript(before, beforeArg);
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForSelector(".CodeMirror");
  return page;
}

// Хранилище чистится один раз на вкладку, иначе проверка «код пережил
// перезагрузку» стирает сам код.
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
  type: document.getElementById("widgetType").value,
}));
console.log("вне VK:", JSON.stringify(outside));
check(/вне VK/.test(outside.status), "статус не говорит, что страница открыта вне VK: " + outside.status);
check(outside.preview && outside.permission, "кнопки VK включены вне VK");
check(outside.logHidden, "журнал сообщений виден, хотя сообщений нет");
check(outside.types === 9, "типов виджета не 9: " + outside.types);
check(outside.type === "list", "первый запуск открыл не List: " + outside.type);
check((await code(page)).includes("Рестораны"), "при первом запуске нет шаблона списка");

/* ==== ТИПЫ И ОТМЕНА ==== */
await setCode(page, 'return {"title":"мой список","rows":[]};');
await page.selectOption("#widgetType", "text");
check((await code(page)).includes("Цитата дня"), "у текста не подставился шаблон");
check(await page.isDisabled("#undoBtn"), "«Отменить» в свежем типе активна: история чужого типа");
await page.selectOption("#widgetType", "list");
check((await code(page)).includes("мой список"), "код списка потерялся при переключении типа");

await page.click("#templateBtn");
check((await code(page)).includes("Рестораны"), "«Шаблон» не заменил код");
await page.click("#undoBtn");
check((await code(page)).includes("мой список"), "«Отменить» не вернула код после шаблона");
await page.click("#redoBtn");
check((await code(page)).includes("Рестораны"), "«Повторить» не сработала");

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

// Старый формат хранил массив версий на тип. Берём последнюю, а сам ключ не трогаем:
// в нём вся история, и ранние скрипты владельца могут жить только там.
const LEGACY = JSON.stringify({ widgetType: "list", history: { list: ["return 1;", "return 2;"], text: [] } });
page = await openPage({
  before: legacy => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("vk_widget_editor_state", legacy);
  },
  beforeArg: LEGACY,
});
check(await page.inputValue("#widgetType") === "list", "после миграции открыт не прежний тип");
check(await code(page) === "return 2;", "миграция взяла не последнюю версию кода");
check(await page.evaluate(() => localStorage.getItem("vk_widget_editor_state")) === LEGACY,
  "старая история изменена или удалена");
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
check(calls[0]?.[0] === "showAppWidgetPreviewBox" && calls[0][1] === "list" && calls[0][2].includes("Рестораны"),
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

/* ==== ТЕМЫ ==== */
// Тёмная тема берётся из настройки системы: фон обязан смениться целиком, иначе
// в тёмном VK останется белая карточка.
const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
console.log("светлая тема:", lightBg);
check(lightBg === "rgb(235, 237, 240)", "светлая тема не покрасила фон: " + lightBg);
await page.context().close();

page = await openPage({ fakeVk: true, colorScheme: "dark", before: clearStorageOnce });
const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
console.log("тёмная тема:", darkBg);
check(darkBg === "rgb(10, 10, 10)", "тёмная тема не покрасила фон: " + darkBg);
if (SHOTS) {
  for (const width of [390, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${SHOTS}/dark-width-${width}.png`, fullPage: true });
  }
}

await browser.close();
if (problems.length) {
  console.error("\nсломано:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("\nвсё на месте");
