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
// 650 — ширина колонки, в которой VK показывает приложение на компьютере.
const VK_FRAME_WIDTH = 650;
const WIDTHS = [390, VK_FRAME_WIDTH, 768, 1200];

const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok; };

const browser = await chromium.launch(process.env.SMOKE_CHROME ? { executablePath: process.env.SMOKE_CHROME } : {});

// before и его аргумент уходят в addInitScript: он выполняется до скриптов страницы
// при каждой загрузке, включая reload.
async function openPage({ fakeVk, before, beforeArg, colorScheme = "light" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme });
  const page = await context.newPage();
  page.on("pageerror", e => problems.push("ошибка скрипта: " + e.message));
  // cdnjs — это Cloudflare, в РФ его режут: всё стороннее обязано приезжать из vendor/.
  await page.route(/cdnjs.cloudflare.com/, route => route.abort());
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
check(outside.types === 8, "типов виджета не 8: " + outside.types);
const typeValues = await page.evaluate(() => [...document.getElementById("widgetType").options].map(o => o.value));
check(typeValues[0] === "list", "первым в списке не List: " + typeValues[0]);
check(!typeValues.includes("text"), "в списке остался Text");
check(outside.type === "list", "первый запуск открыл не List: " + outside.type);
check((await code(page)).includes("Рестораны"), "при первом запуске нет шаблона списка");
const iconFont = await page.evaluate(async () => {
  await document.fonts.ready;
  return document.fonts.check('900 16px "Font Awesome 6 Free"');
});
check(iconFont, "шрифт иконок не загрузился: вместо иконок будут квадраты");

/* ==== ТИПЫ И ОТМЕНА ==== */
await setCode(page, 'return {"title":"мой список","rows":[]};');
await page.selectOption("#widgetType", "table");
check((await code(page)).includes('"head"'), "у таблицы не подставился шаблон");
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

// Журнал не копит мусор: повтор одной ошибки — одна строка со счётчиком, всего не больше 10.
const failPreview = message => page.evaluate(m => window.__vkCallbacks.onAppWidgetPreviewFail({ error_msg: m }), message);
for (let i = 0; i < 9; i++) await failPreview("тест");
const repeated = await page.evaluate(() => ({
  rows: document.querySelectorAll("#logList li").length,
  count: document.querySelector("#logList .log-count").textContent,
}));
check(repeated.rows === 1 && repeated.count === "×10", "повтор ошибки не схлопнулся: " + JSON.stringify(repeated));
for (let i = 0; i < 15; i++) await failPreview("разная " + i);
const logRows = await page.evaluate(() => document.querySelectorAll("#logList li").length);
check(logRows === 10, "в журнале не 10 строк, а " + logRows);

/* ==== ШИРИНЫ ==== */
// Подпись живёт в самой кнопке: без неё пусто и при наведении, и для экранного диктора.
// Всплывающих подсказок (title) владелец не хочет.
const unlabeled = await page.evaluate(() => [...document.querySelectorAll(".toolbar button")]
  .filter(button => !button.querySelector(".btn-label")?.textContent.trim()).map(button => button.id));
check(!unlabeled.length, "кнопки панели без подписи: " + unlabeled.join(", "));
const tooltips = await page.evaluate(() => document.querySelectorAll(".toolbar [title]").length);
check(tooltips === 0, "на панели остались всплывающие подсказки title: " + tooltips);

// Сколько рядов занимает панель: элементы с верхом ближе 8px считаются одним рядом,
// иначе разная высота кнопки и списка дала бы лишний «ряд».
const toolbarRows = () => page.evaluate(() => {
  const tops = [...document.querySelectorAll(".toolbar button, .toolbar select")]
    .map(el => el.getBoundingClientRect().top).sort((a, b) => a - b);
  return tops.filter((top, i) => i === 0 || top - tops[i - 1] > 8).length;
});

for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const rows = await toolbarRows();
  console.log("ширина " + width + ": вылет " + overflow + "px, рядов панели " + rows);
  check(overflow <= 1, "на " + width + "px страница уезжает вбок на " + overflow + "px");
  if (width >= VK_FRAME_WIDTH) check(rows === 1, "на " + width + "px панель в " + rows + " ряда");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/width-${width}.png`, fullPage: true });
}

// Наведение раскрывает подпись в кнопке; на ширине фрейма VK панель не должна уйти
// во второй ряд даже от самой длинной подписи.
await page.setViewportSize({ width: VK_FRAME_WIDTH, height: 900 });
await page.hover("#permissionBtn");
await page.waitForTimeout(300);
const hoverRows = await toolbarRows();
console.log("наведение на «Права на виджет» при " + VK_FRAME_WIDTH + ": рядов " + hoverRows);
check(hoverRows === 1, "подпись при наведении уводит панель во второй ряд");
if (SHOTS) await page.screenshot({ path: `${SHOTS}/hover-${VK_FRAME_WIDTH}.png` });
await page.mouse.move(0, 0);
await page.focus("#widgetType");
await page.keyboard.press("Tab");
await page.waitForTimeout(300);
const focusedLabel = await page.evaluate(() => {
  const label = document.activeElement.querySelector?.(".btn-label");
  return label ? getComputedStyle(label).opacity : null;
});
check(focusedLabel === "1", "подпись не видна при фокусе с клавиатуры: " + focusedLabel);

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
  for (const width of [390, VK_FRAME_WIDTH, 1200]) {
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
