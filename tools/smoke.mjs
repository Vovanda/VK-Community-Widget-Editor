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
// Поддельный VK открывается как из сообщества: без id сообщества вместо редактора заглушка.
const FAKE_GROUP_ID = 1;

const HOUR_MS = 60 * 60 * 1000;

const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok; };

const browser = await chromium.launch(process.env.SMOKE_CHROME ? { executablePath: process.env.SMOKE_CHROME } : {});

// before и его аргумент уходят в addInitScript: он выполняется до скриптов страницы
// при каждой загрузке, включая reload.
// mobile — телефон по-настоящему: узкий экран, касания, без наведения (hover: none).
async function openPage({ fakeVk, before, beforeArg, colorScheme = "light", url, mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 },
    colorScheme, isMobile: mobile, hasTouch: mobile,
  });
  const page = await context.newPage();
  page.on("pageerror", e => problems.push("ошибка скрипта: " + e.message));
  // cdnjs — это Cloudflare, в РФ его режут: всё стороннее обязано приезжать из vendor/.
  await page.route(/cdnjs\.cloudflare\.com/, route => route.abort());
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
  await page.goto(url ?? (fakeVk ? URL + "?group_id=" + FAKE_GROUP_ID : URL), { waitUntil: "load" });
  await page.waitForSelector(".CodeMirror", { state: "attached" });
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
const typeValues = await page.evaluate(() => [...document.getElementById("widgetType").options].map(o => o.value));
check(typeValues[0] === "list", "первым в списке не List: " + typeValues[0]);
check(typeValues.at(-1) === "text", "Text не последним в списке: " + typeValues.join(", "));
// Форма Text собирается в отдельном контейнере, чтобы не трогать состояние страницы.
// Шаблон Text начинается с совета про List; форма обязана его прочесть и не стереть правкой.
const textForm = await page.evaluate(() => {
  const box = document.createElement("div");
  const writes = [];
  const template = templateToCode("text");
  renderForm(box, "text", template, code => writes.push(code), {});
  const input = box.querySelector("input");
  input.value = "Правка";
  input.dispatchEvent(new Event("input"));
  return {
    template, listTemplate: templateToCode("list"),
    labels: [...box.querySelectorAll("label")].map(label => label.textContent.trim()),
    written: writes.at(-1) ?? "",
  };
});
check(textForm.template.startsWith("// Совет: List"), "шаблон Text без совета про List: " + textForm.template.split("\n")[0]);
check(!textForm.listTemplate.startsWith("//"), "совет попал в шаблон List");
check(["Заголовок", "Текст", "Описание"].every(label => textForm.labels.some(t => t.startsWith(label))),
  "форма Text без полей заголовка, текста или описания: " + textForm.labels.join(", "));
check(textForm.written.startsWith("// Совет: List") && textForm.written.includes("Правка"),
  "правка в форме Text стёрла совет или не записалась: " + textForm.written.slice(0, 80));

// Шаблон каждого типа обязан проходить схему из доки VK: иначе «Шаблон» подсовывает виджет, который VK не примет.
const templateProblems = await page.evaluate(() => Object.keys(WIDGET_TYPES)
  .flatMap(type => validateWidget(type, WIDGET_TYPES[type].template).map(problem => type + ": " + problem)));
check(!templateProblems.length, "шаблоны не проходят схему: " + templateProblems.join("; "));
// И проверка не пустышка: кнопка без адреса и кнопка не у всех строк обязаны ловиться.
const caught = await page.evaluate(() => validateWidget("list", { title: "x", rows: [{ title: "a", button: "b" }, { title: "c" }] }));
check(caught.length >= 2, "проверка схемы не ловит нарушения: " + JSON.stringify(caught));
// VK отклоняет адреса не на своих доменах, "#" в том числе — так упал предпросмотр Donation.
const badUrl = await page.evaluate(() => validateWidget("donation", { title: "x", button_url: "#" }));
check(badUrl.some(problem => problem.includes("домены VK")), "адрес # не пойман: " + JSON.stringify(badUrl));
const goodUrl = await page.evaluate(() => validateWidget("donation", { title: "x", button_url: "vk.com/club1" }));
check(!goodUrl.length, "адрес vk.com/club1 из примера доки забракован: " + JSON.stringify(goodUrl));
check(outside.type === "list", "первый запуск открыл не List: " + outside.type);
check((await code(page)).includes("Рестораны"), "при первом запуске нет шаблона списка");
const iconFont = await page.evaluate(async () => {
  await document.fonts.ready;
  return document.fonts.check('900 16px "Font Awesome 6 Free"');
});
check(iconFont, "шрифт иконок не загрузился: вместо иконок будут квадраты");
// Подсказка про VK CC говорит, зачем он нужен и где подводит.
const vkccHint = await page.textContent("#vkccHint");
check(vkccHint.includes("статистик") && vkccHint.includes("редирект"), "подсказка про VK CC без статистики или без риска: " + vkccHint);
// Код живёт только в localStorage: предупреждение говорит где, чем грозит и что делать.
const storageNote = await page.textContent("#storageNote");
check(["браузере", "другого компьютера", "копию в файле"].every(part => storageNote.includes(part)),
  "предупреждение о хранении не говорит про браузер, другой компьютер или копию: " + storageNote);
// Вне VK редактор остаётся: заглушка только для VK без сообщества.
check(await page.isHidden("#installPlaceholder"), "вне VK видна заглушка «Добавить в сообщество»");

/* ==== ТИПЫ И ОТМЕНА ==== */
await setCode(page, 'return {"title":"мой список","rows":[]};');
await page.selectOption("#widgetType", "table");
check((await code(page)).includes('"head"'), "у таблицы не подставился шаблон");
check(await page.isDisabled("#undoBtn"), "«Отменить» в свежем типе активна: история чужого типа");
await page.selectOption("#widgetType", "list");
check((await code(page)).includes("мой список"), "код списка потерялся при переключении типа");

// «Шаблон» затирал бы готовый код, поэтому работает только на пустом.
check(await page.isDisabled("#templateBtn"), "«Шаблон» активен при непустом коде");
await setCode(page, "");
check(!(await page.isDisabled("#templateBtn")), "«Шаблон» выключен при пустом коде");
await page.click("#templateBtn");
check((await code(page)).includes("Рестораны"), "«Шаблон» не поставил код в пустой редактор");
await page.click("#undoBtn");
check(await code(page) === "", "«Отменить» не вернула пустой код после шаблона");
await page.click("#redoBtn");
check((await code(page)).includes("Рестораны"), "«Повторить» не сработала");

// Меню «Сниппеты» строится из таблицы SNIPPETS; оба сниппета встают в начало кода.
await page.click("#snippetsBtn");
const snippetItems = await page.locator("#snippetsMenu [role=menuitem]").allTextContents();
check(snippetItems.length === 2, "в меню сниппетов не 2 пункта: " + snippetItems.join(", "));
await page.click('#snippetsMenu [data-snippet="random"]');
check((await code(page)).startsWith("// Случайные числа"), "сниппет случайности не вставился в начало");
check(await page.isHidden("#snippetsMenu"), "меню не закрылось после выбора");
await page.click("#undoBtn");
await page.click("#snippetsBtn");
await page.click('#snippetsMenu [data-snippet="greeting"]');
check((await code(page)).startsWith("// Приветствие по времени суток"), "сниппет приветствия не вставился в начало");
await page.click("#undoBtn");
await page.click("#snippetsBtn");
await page.keyboard.press("Escape");
check(await page.isHidden("#snippetsMenu"), "Esc не закрыл меню сниппетов");

/* ==== ФОРМА ==== */
// Форма — второй вид того же кода: правка в форме меняет код, «Отменить» откатывает её.
// Пустой код форма не показывает пустотой: предлагает начать с шаблона.
await setCode(page, "");
await page.click("#formTab");
check(await page.isHidden(".CodeMirror"), "в форме виден редактор кода");
check(await page.isVisible("#formView .form-start"), "в пустой форме нет «Начать с шаблона»");
await page.click("#formView .form-start");
check((await code(page)).includes("Рестораны"), "«Начать с шаблона» не поставила шаблон");
const titleInput = page.locator('#formView [data-path="title"]');
check(await titleInput.inputValue() === "Рестораны", "форма не подхватила заголовок из кода");
await titleInput.fill("Кафе");
check((await code(page)).includes('"title": "Кафе"'), "правка в форме не попала в код");
await page.click("#undoBtn");
check(!(await code(page)).includes('"title": "Кафе"'), "«Отменить» не откатила правку формы");
check(await titleInput.inputValue() === "Рестораны", "после отмены форма показывает старое значение");
await page.click('#formView .form-add[data-path="rows"]');
const rowsAfterAdd = await page.evaluate(() => readSimpleWidget(document.querySelector(".CodeMirror").CodeMirror.getValue()).rows.length);
check(rowsAfterAdd === 2, "«Добавить» не добавил строку в код: строк " + rowsAfterAdd);

// Шаблон каждого типа открывается в форме без отказа и без нарушений схемы.
for (const type of typeValues) {
  await page.selectOption("#widgetType", type);
  await setCode(page, "");
  await page.click("#templateBtn");
  const formState = await page.evaluate(() => ({
    refusal: Boolean(document.querySelector("#formView .form-refusal")),
    fields: document.querySelectorAll("#formView [data-path]").length,
    problems: [...document.querySelectorAll("#formView .form-problems li")].map(li => li.textContent),
  }));
  check(!formState.refusal && formState.fields > 0, "форма не открыла шаблон " + type);
  check(!formState.problems.length, "форма " + type + " показывает нарушения на шаблоне: " + formState.problems.join("; "));
}

// Скрипт с переменными форма не трогает: отказ и код без изменений.
await page.selectOption("#widgetType", "list");
const script = 'var x = 1;\nreturn {"title":"x","rows":[]};';
await setCode(page, script);
check(await page.isVisible("#formView .form-refusal"), "на скрипте с переменными нет отказа формы");
check(await code(page) === script, "форма изменила скрипт, который не понимает");
await page.click("#codeTab");
check(await page.isVisible(".CodeMirror"), "вкладка «Код» не вернула редактор");

/* ==== БЛОКИ СКРИПТА ==== */
// Настоящий скрипт владельца: данные в var, логика вокруг. Форма показывает блоки
// с сигнатурой строки List и меняет только их литералы.
const { readFileSync } = await import("node:fs");
// Константа URL выше — адрес страницы и перекрывает класс, поэтому класс берётся явно.
const veoomsk = readFileSync(new globalThis.URL("../templates/veoomsk/RandomTextInWidget.vks", import.meta.url), "utf8");
await page.click("#formTab");
await setCode(page, veoomsk);
const areas = await page.evaluate(() => [...document.querySelectorAll("#formView .form-block")].map(area => ({
  name: area.dataset.name,
  title: area.querySelector(".form-block-title").textContent,
  adds: area.querySelectorAll(".form-add").length,
})));
console.log("блоки veoomsk:", areas.map(a => a.name + (a.adds ? "+" : "")).join(" "));
check(areas.map(a => a.name).join() === "engagement,sales,group_invite,info,stub_item",
  "блоки скрипта не те: " + areas.map(a => a.name).join());
check(areas[0]?.title.startsWith("Действия для повышения"), "заголовок блока не из комментария: " + areas[0]?.title);
check(areas[4]?.title === "stub_item", "блок без комментария назван не по имени: " + areas[4]?.title);
check(areas.map(a => a.adds).join() === "1,1,1,1,0", "«Добавить» не только у массивов: " + areas.map(a => a.adds).join());

const blockRange = (source, name) => page.evaluate(([s, n]) => {
  const block = findBlocks(s, "list").find(b => b.name === n);
  return [block.start, block.end, Array.isArray(block.value) ? block.value.length : 1];
}, [source, name]);
// Карточки длинных списков свёрнуты: разворачиваем все, чтобы добраться до полей.
await page.click("#formView .form-expand-all");
const beforeEdit = await code(page);
const [engStart, engEnd] = await blockRange(beforeEdit, "engagement");
await page.locator('#formView [data-path="engagement.0.title"]').fill("Лайкните пост!");
const afterEdit = await code(page);
const [engStart2, engEnd2] = await blockRange(afterEdit, "engagement");
check(afterEdit.includes('"title":"Лайкните пост!"'), "правка блока не попала в код");
check(beforeEdit.slice(0, engStart) === afterEdit.slice(0, engStart2) && beforeEdit.slice(engEnd) === afterEdit.slice(engEnd2),
  "правка engagement задела код вне его литерала");
const [, , salesBefore] = await blockRange(afterEdit, "sales");
await page.click('#formView .form-block[data-name="sales"] .form-add');
const salesCode = await code(page);
const [, , salesAfter] = await blockRange(salesCode, "sales");
check(salesAfter === salesBefore + 1, `«Добавить» в sales: было ${salesBefore}, стало ${salesAfter}`);

/* ==== УДОБСТВО ФОРМЫ ==== */
const blockTitles = (source, name) => page.evaluate(([s, n]) =>
  findBlocks(s, "list").find(b => b.name === n).value.map(item => item.title), [source, name]);
// Новый элемент встаёт первым, чтобы его не искать в конце длинного списка.
check((await blockTitles(salesCode, "sales"))[0] === "", "новый элемент sales не первый");

// ↓ у первого элемента меняет его местами со вторым.
const engBeforeMove = await blockTitles(await code(page), "engagement");
await page.click('#formView .form-block[data-name="engagement"] .form-card .form-move-down');
const engAfterMove = await blockTitles(await code(page), "engagement");
check(engAfterMove[0] === engBeforeMove[1] && engAfterMove[1] === engBeforeMove[0],
  "↓ не поменял элементы местами: " + engAfterMove.slice(0, 2).join(" | "));

// Удаление в два нажатия: первое только спрашивает, второе удаляет.
const salesCount = async () => (await blockTitles(await code(page), "sales")).length;
const salesBeforeDelete = await salesCount();
const deleteFirstSales = '#formView .form-block[data-name="sales"] .form-card .form-delete';
await page.click(deleteFirstSales);
check(await salesCount() === salesBeforeDelete, "удаление сработало с первого нажатия");
check(await page.isVisible(`${deleteFirstSales}.armed`), "после первого нажатия нет вопроса «Удалить?»");
await page.click(deleteFirstSales);
check(await salesCount() === salesBeforeDelete - 1, "второе нажатие не удалило элемент");

await page.click("#formView .form-collapse-all");
check(await page.evaluate(() => [...document.querySelectorAll("#formView details")].every(d => !d.open)),
  "«Свернуть все» свернула не всё");
await page.click("#formView .form-expand-all");
check(await page.evaluate(() => [...document.querySelectorAll("#formView details")].every(d => d.open)),
  "«Развернуть все» раскрыла не всё");

// На ширине фрейма VK связанные поля стоят парой: кнопка и её ссылка в одной строке.
await page.setViewportSize({ width: VK_FRAME_WIDTH, height: 900 });
const pairGap = await page.evaluate(() => {
  const top = path => document.querySelector(`#formView [data-path="${path}"]`).getBoundingClientRect().top;
  return Math.abs(top("sales.1.button") - top("sales.1.button_url"));
});
check(pairGap <= 2, "на 650px «Кнопка» и «Ссылка кнопки» не в одной строке: разница " + pairGap + "px");
if (SHOTS) {
  await page.click("#formView .form-collapse-all");
  await page.click('#formView .form-block[data-name="sales"] > summary');
  await page.click('#formView .form-block[data-name="sales"] .form-card:nth-of-type(2) > summary');
  await page.screenshot({ path: `${SHOTS}/blocks-${VK_FRAME_WIDTH}.png` });
}
await page.setViewportSize({ width: 1200, height: 900 });

// Иконка новой строки — фото текущего сообщества, а не пользователя.
await page.goto(URL + "?group_id=777", { waitUntil: "load" });
await page.waitForSelector(".CodeMirror", { state: "attached" });
await page.selectOption("#widgetType", "list");
await page.click("#formTab");
await setCode(page, "");
await page.click("#templateBtn");
await page.selectOption('#formView .form-add-field[data-path="rows.0"]', "icon_id");
check((await code(page)).includes('"icon_id": "club777"'), "новый icon_id не club777 при group_id=777");
// Id иконки строки не вводят: аватар посетителя в виджете пугает («я не оставлял сообщение»).
const iconCell = await page.evaluate(() => ({
  inputs: document.querySelectorAll('#formView input[data-path="rows.0.icon_id"]').length,
  shown: document.querySelector('#formView .form-icon-value[data-path="rows.0.icon_id"]')?.textContent,
}));
check(iconCell.inputs === 0 && iconCell.shown === "Аватар сообщества",
  "у иконки строки есть поле ввода или нет подписи «Аватар сообщества»: " + JSON.stringify(iconCell));
// Без id сообщества подставить нечего — пункт выключен.
const iconOption = await page.evaluate(() => {
  const box = document.createElement("div");
  renderForm(box, "list", templateToCode("list"), () => {}, {});
  return box.querySelector('.form-add-field[data-path="rows.0"] option[value="icon_id"]')?.disabled;
});
check(iconOption === true, "без id сообщества «Иконка сообщества» можно добавить: " + iconOption);
await page.click("#codeTab");

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
await setCode(page, "return {\"title\":\"до перезагрузки\"};");
await setCode(page, "return {\"title\":\"после перезагрузки\"};");
await page.reload({ waitUntil: "load" });
await page.waitForSelector(".CodeMirror", { state: "attached" });
check((await code(page)).includes("после перезагрузки"), "код не пережил перезагрузку");
// История отмены хранится рядом с кодом: «Отменить» работает и после перезагрузки.
check(!(await page.isDisabled("#undoBtn")), "после перезагрузки «Отменить» выключена");
await page.click("#undoBtn");
check((await code(page)).includes("до перезагрузки"), "«Отменить» после перезагрузки не вернула прежний код");
// Глубина истории ограничена у каждого документа, иначе хранилище растёт без предела.
const depthOf = () => page.evaluate(() => document.querySelector(".CodeMirror").CodeMirror.getDoc().history.undoDepth);
check(await depthOf() === 200, "глубина истории List не 200: " + await depthOf());
await page.selectOption("#widgetType", "tiles");
check(await depthOf() === 200, "глубина истории Tiles не 200: " + await depthOf());
await page.selectOption("#widgetType", "list");
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

/* ==== ХРАНЕНИЕ ПО ГРУППАМ ==== */
// У каждой группы свой код: общий слот на тип подсовывал в одну группу скрипт другой.
const openGroup = async id => {
  await page.goto(URL + "?group_id=" + id, { waitUntil: "load" });
  await page.waitForSelector(".CodeMirror", { state: "attached" });
};
page = await openPage({ url: URL + "?group_id=111", before: clearStorageOnce });
await setCode(page, 'return {"title":"группа 111","rows":[]};');
await openGroup(222);
check(!(await code(page)).includes("группа 111"), "код группы 111 виден в группе 222");
await openGroup(111);
check((await code(page)).includes("группа 111"), "код группы 111 не сохранился");
await page.evaluate(() => localStorage.setItem("vk_widget_editor_v2",
  JSON.stringify({ widgetType: "list", code: { list: "return 42;" } })));
await openGroup(333);
check(await code(page) === "return 42;", "группа без своего кода не взяла общий");
const inheritWarning = await page.evaluate(() => document.getElementById("logList").textContent);
check(inheritWarning.includes("другой группы"), "нет предупреждения, что общий код мог быть от другой группы");
await page.context().close();

/* ==== ВЕРСИИ ==== */
// Часы подменяются: версия появляется на первой правке в новом часу, старше суток —
// по одной на день. Выбор версии — обычная правка, её откатывает «Отменить».
{
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const versionsPage = await context.newPage();
  versionsPage.on("pageerror", e => problems.push("ошибка скрипта: " + e.message));
  await versionsPage.route(/cdnjs\.cloudflare\.com/, route => route.abort());
  await versionsPage.clock.install({ time: new Date("2026-09-10T10:00:00") });
  await versionsPage.goto(URL, { waitUntil: "load" });
  await versionsPage.waitForSelector(".CodeMirror", { state: "attached" });
  await setCode(versionsPage, "return 'v1';");
  await setCode(versionsPage, "return 'v2';");
  await versionsPage.clock.fastForward(HOUR_MS);
  await setCode(versionsPage, "return 'v3';");
  await versionsPage.clock.fastForward(26 * HOUR_MS);
  await setCode(versionsPage, "return 'v4';");
  await versionsPage.click("#versionsBtn");
  const versionLabels = await versionsPage.locator("#versionsMenu [role=menuitem]").allTextContents();
  console.log("версии:", versionLabels.join(" | "));
  check(versionLabels.join() === "Сегодня 13:00,Вчера 11:00", "версии в меню не те: " + versionLabels.join(", "));
  await versionsPage.click('#versionsMenu [role=menuitem] >> text="Вчера 11:00"');
  check(await code(versionsPage) === "return 'v2';", "выбор версии не поставил её код");
  await versionsPage.click("#undoBtn");
  check(await code(versionsPage) === "return 'v4';", "«Отменить» не вернула код до выбора версии");
  await context.close();
}

/* ==== VK БЕЗ СООБЩЕСТВА ==== */
// Открыто по vk.ru/app7100465: виджет ставить некуда — заглушка со скринами и ссылкой.
{
  const lonely = await openPage({ fakeVk: true, url: URL + "?group_id=0", before: clearStorageOnce });
  const placeholder = await lonely.evaluate(async () => {
    const images = [...document.querySelectorAll("#installPlaceholder img")];
    await Promise.all(images.map(img => img.complete ? null : new Promise(done => { img.onload = img.onerror = done; })));
    return {
      shown: !document.getElementById("installPlaceholder").hidden,
      editor: !document.querySelector(".workspace").hidden,
      link: document.querySelector("#installPlaceholder .install-add")?.href,
      images: images.map(img => img.naturalWidth),
      status: document.getElementById("vkStatus").textContent,
    };
  });
  console.log("vk без сообщества:", JSON.stringify(placeholder));
  check(placeholder.shown && !placeholder.editor, "в VK без сообщества нет заглушки или виден редактор");
  check(placeholder.link === "https://vk.com/add_community_app.php?aid=7100465", "ссылка «Добавить в сообщество» не та: " + placeholder.link);
  check(placeholder.images.length === 2 && placeholder.images.every(width => width > 0), "скриншоты заглушки не загрузились: " + placeholder.images);
  if (SHOTS) {
    for (const width of [390, VK_FRAME_WIDTH]) {
      await lonely.setViewportSize({ width, height: 900 });
      await lonely.screenshot({ path: `${SHOTS}/placeholder-${width}.png`, fullPage: true });
    }
  }
  // «Попробовать здесь»: редактор открывается с предупреждением, но без предпросмотра и прав —
  // ни кнопками, ни Ctrl+Enter: поставить виджет можно только из сообщества.
  await lonely.setViewportSize({ width: 1200, height: 900 });
  await lonely.click("#tryHereBtn");
  await lonely.click(".CodeMirror");
  await lonely.keyboard.press("Control+Enter");
  const trial = await lonely.evaluate(() => ({
    editor: !document.querySelector(".workspace").hidden,
    placeholder: !document.getElementById("installPlaceholder").hidden,
    note: !document.getElementById("testModeNote").hidden,
    vkButtons: ["previewBtn", "permissionBtn"].filter(id => document.getElementById(id).getClientRects().length),
    previews: window.__vkCalls.filter(call => call[0] !== "resizeWindow").length,
  }));
  console.log("тестовый режим:", JSON.stringify(trial));
  check(trial.editor && !trial.placeholder && trial.note, "«Попробовать здесь» не открыл редактор с предупреждением");
  check(!trial.vkButtons.length, "в тестовом режиме видны кнопки VK: " + trial.vkButtons.join(", "));
  check(trial.previews === 0, "в тестовом режиме ушёл вызов VK: " + trial.previews);
  if (SHOTS) await lonely.screenshot({ path: `${SHOTS}/trial-${VK_FRAME_WIDTH}.png` });
  await lonely.context().close();
}

/* ==== ВНУТРИ VK (подделка) ==== */
page = await openPage({ fakeVk: true, before: clearStorageOnce });
check(!(await page.isDisabled("#previewBtn")), "в VK кнопка предпросмотра выключена");
check(await page.isHidden("#installPlaceholder"), "в сообществе видна заглушка вместо редактора");

// VK сам iframe не растягивает: страница сообщает высоту — низ карточки плюс поле.
const appHeight = () => page.evaluate(() =>
  Math.ceil(document.querySelector(".app").getBoundingClientRect().bottom + window.scrollY) + 16);
const lastResize = () => page.evaluate(() => window.__vkCalls.filter(call => call[0] === "resizeWindow").at(-1)?.[2]);
await page.waitForFunction(() => window.__vkCalls.some(call => call[0] === "resizeWindow"), null, { timeout: 5000 })
  .catch(() => {});
const firstResize = await lastResize();
check(firstResize === await appHeight(), `после подключения resizeWindow не по высоте страницы: ${firstResize} вместо ${await appHeight()}`);
// В настоящем VK resizeWindow меняет высоту окна. Редактор от неё зависеть не должен,
// иначе фрейм и редактор растягивают друг друга по кругу.
const editorHeights = [];
for (const height of [630, 1000]) {
  await page.setViewportSize({ width: 650, height });
  editorHeights.push(await page.evaluate(() => document.querySelector(".CodeMirror").getBoundingClientRect().height));
}
await page.setViewportSize({ width: 1200, height: 900 });
check(editorHeights[0] === editorHeights[1], "в VK высота редактора зависит от высоты окна: " + editorHeights.join(" -> "));
await page.waitForFunction(() => {
  const calls = window.__vkCalls.filter(call => call[0] === "resizeWindow");
  const app = Math.ceil(document.querySelector(".app").getBoundingClientRect().bottom + window.scrollY) + 16;
  return calls.at(-1)?.[2] === app;
}, null, { timeout: 5000 }).catch(() => {});
const settledResize = await lastResize();

await page.click("#previewBtn");
await page.click(".CodeMirror");
await page.keyboard.press("Control+Enter");
await page.click("#permissionBtn");
// resizeWindow идёт своим чередом, проверки аргументов — по остальным вызовам.
const calls = await page.evaluate(() => window.__vkCalls.filter(call => call[0] !== "resizeWindow"));
console.log("вызовы VK:", JSON.stringify(calls).slice(0, 200));
check(calls[0]?.[0] === "showAppWidgetPreviewBox" && calls[0][1] === "list" && calls[0][2].includes("Рестораны"),
  "предпросмотр ушёл в VK не с теми аргументами");
check(calls[1]?.[0] === "showAppWidgetPreviewBox", "Ctrl+Enter не открыл предпросмотр");
check(calls[2]?.[0] === "showGroupSettingsBox" && calls[2][1] === 64, "права запрошены не с тем битом");
await page.evaluate(() => window.__vkCallbacks.onAppWidgetPreviewFail({ error_msg: "тест" }));
check(!(await page.evaluate(() => document.getElementById("log").hidden)), "ошибка VK не показана в журнале");
// Журнал вырос — фрейм обязан вырасти следом, иначе журнал срезан, как было в VK.
await page.waitForFunction(before => (window.__vkCalls.filter(call => call[0] === "resizeWindow").at(-1)?.[2] ?? 0) > before,
  settledResize, { timeout: 5000 }).catch(() => {});
const grownResize = await lastResize();
check(grownResize > settledResize && grownResize === await appHeight(),
  `журнал появился, а фрейм не вырос до высоты страницы: ${settledResize} -> ${grownResize}, нужно ${await appHeight()}`);

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
const unlabeled = await page.evaluate(() => [...document.querySelectorAll(".toolbar button:not([role=menuitem])")]
  .filter(button => !button.querySelector(".btn-label")?.textContent.trim()).map(button => button.id));
check(!unlabeled.length, "кнопки панели без подписи: " + unlabeled.join(", "));
const tooltips = await page.evaluate(() => document.querySelectorAll(".toolbar [title]").length);
check(tooltips === 0, "на панели остались всплывающие подсказки title: " + tooltips);

// Сколько рядов занимает панель: элементы с верхом ближе 8px считаются одним рядом,
// иначе разная высота кнопки и списка дала бы лишний «ряд».
const toolbarRows = () => page.evaluate(() => {
  // Скрытые пункты меню сниппетов дают нулевой прямоугольник — это не ряд панели.
  const tops = [...document.querySelectorAll(".toolbar button, .toolbar select")]
    .filter(el => el.getClientRects().length)
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

// Наведение не должно уводить кнопку из-под курсора: иначе она сжимается, снова
// попадает под курсор и мигает без конца. Проверяется каждая кнопка на каждой ширине.
// Фокус с клавиатуры от прошлой проверки снимается, и перед каждой кнопкой курсор
// уходит, а подписи схлопываются: иначе замер снимается с чужой раскрытой подписью.
await page.evaluate(() => document.activeElement?.blur());
for (const width of [641, 650, 700, 768, 900, 1024, 1200]) {
  await page.setViewportSize({ width, height: 900 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const rowsBefore = await toolbarRows();
  for (const button of await page.$$(".toolbar button:not([role=menuitem])")) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    const box = await button.boundingBox();
    if (!box) continue;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(250);
    const stays = await page.evaluate(([px, py, el]) => document.elementFromPoint(px, py)?.closest("button") === el, [x, y, button]);
    const rowsAfter = await toolbarRows();
    check(stays && rowsAfter === rowsBefore,
      `на ${width}px наведение на ${await button.getAttribute("id")} уводит кнопку из-под курсора или меняет ряды (${rowsBefore} -> ${rowsAfter})`);
  }
  await page.mouse.move(0, 0);
}

// Вёрстка не зависит от содержимого и окна: длинные строки скрипта не распирают блок
// ни в коде, ни в форме — на любой ширине от телефона до широкого монитора.
await setCode(page, veoomsk);
for (const view of ["code", "form"]) {
  await page.click(view === "code" ? "#codeTab" : "#formTab");
  for (const width of [320, 390, 650, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const fit = await page.evaluate(() => {
      const card = document.querySelector(".app").getBoundingClientRect();
      const parts = [".workspace", ".toolbar", ".CodeMirror", "#formView", "#storageNote"]
        .map(selector => document.querySelector(selector))
        .filter(part => part && part.getClientRects().length);
      const widest = Math.max(...parts.map(part => part.getBoundingClientRect().right));
      const note = document.getElementById("storageNote").getBoundingClientRect();
      // Рамка формы держится, а содержимое внутри неё может уехать под прокрутку:
      // так длинный заголовок элемента выталкивал «Добавить» и крестики за край.
      const form = document.getElementById("formView");
      const formRight = form.getBoundingClientRect().right - form.clientLeft;
      const pushedOut = [...form.querySelectorAll("button")]
        .filter(button => button.getClientRects().length && button.getBoundingClientRect().right > formRight + 1)
        .map(button => button.textContent.trim() || button.getAttribute("aria-label"));
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        spill: Math.round(widest - card.right),
        note: note.width > 0 && note.height > 0,
        pushedOut: [...new Set(pushedOut)].slice(0, 3),
      };
    });
    const where = `${view === "code" ? "код" : "форма"} на ${width}px`;
    check(fit.page <= 1 && fit.spill <= 0,
      `${where}: страница уезжает на ${fit.page}px, блок шире карточки на ${fit.spill}px`);
    check(fit.note, `${where}: не видно предупреждения о хранении`);
    check(!fit.pushedOut.length, `${where}: кнопки за правым краем формы: ${fit.pushedOut.join(", ")}`);
  }
}
await page.click("#codeTab");
if (SHOTS) {
  await page.setViewportSize({ width: VK_FRAME_WIDTH, height: 900 });
  await page.screenshot({ path: `${SHOTS}/code-long-${VK_FRAME_WIDTH}.png` });
}

/* ==== ТЕМЫ ==== */
// Тёмная тема берётся из настройки системы: фон обязан смениться целиком, иначе
// в тёмном VK останется белая карточка.
const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
console.log("светлая тема:", lightBg);
check(lightBg === "rgb(235, 237, 240)", "светлая тема не покрасила фон: " + lightBg);
// Форму во фрейме VK смотрят глазами в обеих темах.
const shootForm = async name => {
  if (!SHOTS) return;
  await page.setViewportSize({ width: VK_FRAME_WIDTH, height: 900 });
  await page.click("#formTab");
  await page.screenshot({ path: `${SHOTS}/${name}-${VK_FRAME_WIDTH}.png` });
  await page.click("#codeTab");
};
await shootForm("form");
await page.context().close();

page = await openPage({ fakeVk: true, colorScheme: "dark", before: clearStorageOnce });
const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
console.log("тёмная тема:", darkBg);
check(darkBg === "rgb(10, 10, 10)", "тёмная тема не покрасила фон: " + darkBg);
await shootForm("dark-form");
if (SHOTS) {
  for (const width of [390, VK_FRAME_WIDTH, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${SHOTS}/dark-width-${width}.png`, fullPage: true });
  }
}

/* ==== ТЕЛЕФОН ==== */
// Наведения нет: подписи кнопок видны сразу, кнопки стоят по две в ряд.
page = await openPage({ fakeVk: true, before: clearStorageOnce, mobile: true });
const mobileBar = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll(".toolbar button:not([role=menuitem])")];
  const hiddenLabels = buttons.filter(button => {
    const label = button.querySelector(".btn-label");
    return !label || getComputedStyle(label).opacity !== "1" || label.getBoundingClientRect().width === 0;
  }).map(button => button.id);
  const perRow = new Map();
  for (const button of buttons) {
    const top = Math.round(button.getBoundingClientRect().top);
    perRow.set(top, (perRow.get(top) ?? 0) + 1);
  }
  return { hiddenLabels, widestRow: Math.max(...perRow.values()), noHover: matchMedia("(hover: none)").matches };
});
console.log("телефон:", JSON.stringify(mobileBar));
check(mobileBar.noHover, "телефон в смоке не эмулирует отсутствие наведения");
check(!mobileBar.hiddenLabels.length, "на телефоне скрыты подписи у: " + mobileBar.hiddenLabels.join(", "));
check(mobileBar.widestRow <= 2, "на телефоне в ряду больше двух кнопок: " + mobileBar.widestRow);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-390.png` });

await browser.close();
if (problems.length) {
  console.error("\nсломано:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("\nвсё на месте");
