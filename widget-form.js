/* Форма без кода — второй вид того же кода. Источник правды один: документ
   CodeMirror. Форма вычитывает из кода данные, а каждую правку пишет обратно
   в код, поэтому отмена, хранение и предпросмотр одинаковы в обоих видах.

   Код бывает двух видов. Простой — один return с JSON-объектом, как у шаблонов:
   форма показывает виджет целиком. Скрипт — данные в переменных и логика вокруг
   них: форма показывает блоки данных с подходящей сигнатурой и меняет только
   их литералы, логику не трогает. */

/* ==== КОД И ВИДЖЕТ ==== */
function widgetToCode(widget) {
  return "return " + JSON.stringify(widget, null, 2) + ";";
}

// Строки-комментарии над return: совет в шаблоне или пометки автора. Форма их не
// показывает, но при правке пишет обратно — иначе первая же правка их стирала бы.
function leadingComments(code) {
  return code.match(/^(?:[ \t]*\/\/[^\n]*\n)*/)[0];
}

// Шаблон типа как код; совет типа (hint) встаёт комментарием первой строкой.
function templateToCode(type) {
  const { template, hint } = WIDGET_TYPES[type];
  return (hint ? `// ${hint}\n` : "") + widgetToCode(template);
}

function readSimpleWidget(code) {
  const match = code.slice(leadingComments(code).length).trim().match(/^return\s+([\s\S]*?);?$/);
  if (!match) return null;
  try {
    const widget = JSON.parse(match[1]);
    return widget && typeof widget === "object" && !Array.isArray(widget) ? widget : null;
  } catch {
    return null;
  }
}

/* ==== БЛОКИ СКРИПТА ==== */
// VKScript почти JS; acorn не разберёт только выборку «@.» — меняем её на токен
// той же длины, чтобы позиции узлов совпали с исходником.
function parseScript(code) {
  const comments = [];
  try {
    const ast = acorn.parse(code.replace(/@\./g, "._"),
      { ecmaVersion: 5, allowReturnOutsideFunction: true, onComment: comments });
    return { ast, comments };
  } catch {
    return null;
  }
}

// Чистый литерал — только строки, числа, true/false/null и массивы с объектами из них.
// Всё остальное (вызовы, переменные, выражения) — логика, и значения у неё нет.
function literalValue(node) {
  switch (node.type) {
    case "Literal":
      return node.regex ? undefined : node.value;
    case "UnaryExpression":
      return node.operator === "-" && typeof node.argument.value === "number" ? -node.argument.value : undefined;
    case "ArrayExpression": {
      const items = node.elements.map(item => (item ? literalValue(item) : undefined));
      return items.includes(undefined) ? undefined : items;
    }
    case "ObjectExpression": {
      const obj = {};
      for (const property of node.properties) {
        if (property.computed || property.kind !== "init") return undefined;
        const value = literalValue(property.value);
        if (value === undefined) return undefined;
        obj[property.key.type === "Identifier" ? property.key.name : property.key.value] = value;
      }
      return obj;
    }
    default:
      return undefined;
  }
}

// Какие формы данных знает тип: элементы его списков и сам виджет. Выбор типа
// меняет набор форм — это и есть стратегия поиска сигнатур.
function knownShapes(type) {
  const fields = WIDGET_TYPES[type].fields;
  const shapes = Object.values(fields)
    .filter(field => field.kind === "array" && field.of.kind === "object")
    .map(field => field.of);
  shapes.push(objField(fields));
  return shapes;
}

const fitsShape = (obj, shape) => obj !== null && typeof obj === "object" && !Array.isArray(obj)
  && Object.keys(obj).length > 0 && Object.keys(obj).every(key => key in shape.fields);

// Сигнатура блока: непустой массив объектов или один объект, все ключи которых — поля формы.
function matchShape(value, type) {
  const shapes = knownShapes(type);
  if (Array.isArray(value)) {
    return value.length ? shapes.find(shape => value.every(item => fitsShape(item, shape))) ?? null : null;
  }
  return shapes.find(shape => fitsShape(value, shape)) ?? null;
}

// Заголовок блока — комментарий прямо над объявлением, без декоративных «===».
function commentAbove(comments, code, start) {
  const comment = comments.filter(c => c.end <= start).pop();
  if (!comment || code.slice(comment.end, start).trim() !== "") return null;
  return comment.value.replace(/=+/g, " ").trim() || null;
}

// Все верхнеуровневые var с литералом: имя, диапазон в коде и значение.
function literalDeclarations(code) {
  const parsed = parseScript(code);
  if (!parsed) return null;
  const found = [];
  for (const node of parsed.ast.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const declaration of node.declarations) {
      if (!declaration.init) continue;
      const value = literalValue(declaration.init);
      if (value === undefined) continue;
      found.push({ name: declaration.id.name, start: declaration.init.start, end: declaration.init.end, value,
        title: commentAbove(parsed.comments, code, node.start) });
    }
  }
  return found;
}

function findBlocks(code, type) {
  const declarations = literalDeclarations(code);
  if (!declarations) return null;
  return declarations
    .map(declaration => ({ ...declaration, shape: matchShape(declaration.value, type) }))
    .filter(block => block.shape);
}

// Правленый блок пишется в стиле скриптов владельца: элемент массива — одна строка.
function literalToCode(value) {
  if (Array.isArray(value)) {
    return value.length ? "[\n" + value.map(item => "    " + JSON.stringify(item)).join(",\n") + "\n]" : "[]";
  }
  return JSON.stringify(value, null, 4);
}

// Блок данных — пул, из которого скрипт выбирает, а не строки виджета: правила
// массива (сколько строк, кнопка у всех) к нему не относятся, только поля элементов.
function blockProblems(block) {
  const problems = [];
  const items = Array.isArray(block.value) ? block.value : [block.value];
  items.forEach((item, i) => checkObject(item, block.shape.fields, `${block.name}[${i}]`, problems));
  return problems;
}

/* ==== РАСКЛАДКА ==== */
// Сколько колонок из шести занимает поле: связанные поля встают парами, заголовок,
// описание и текст — на всю ширину. Числа по умолчанию — половина.
const FIELD_SPANS = {
  title_url: 3, title_counter: 3, more: 3, more_url: 3,
  button: 3, button_url: 3, link: 3, link_url: 3, address: 3, time: 3,
  icon_id: 3, cover_id: 3, url: 3, text_url: 3, live_url: 3, currency: 3,
  start: 3, end: 3, goal: 2, funded: 2, backers: 2, event: 4, minute: 2, align: 2,
};
const fieldSpan = (key, field) => FIELD_SPANS[key] ?? (field.kind === "integer" ? 3 : 6);

// Длинный список сразу раскрытым — простыня: карточки свёрнуты, если их больше трёх.
const CARDS_OPEN_UP_TO = 3;

/* ==== ПОЛЯ ==== */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fieldLabel = key => FIELD_LABELS[key] ?? String(key);
const joinPath = (path, key) => (path === "" ? String(key) : path + "." + key);
const fieldId = path => "field-" + path.replace(/[^\w]/g, "-");

// Переносы строк VK разрешает только в тексте строки списка — там многострочное поле.
const isLongText = field => field.kind === "string" && !field.oneLine && (field.max ?? 0) >= 200;

// Значение нового поля или элемента. Новый элемент повторяет набор полей соседа:
// у VK кнопки и иконки должны быть у всех элементов списка или ни у одного.
// Некоторые поля имеют осмысленное значение по умолчанию — иконка сообщества.
function emptyValue(field, sibling, key, defaults) {
  if (field.kind === "string" && key != null && key in defaults) return defaults[key];
  switch (field.kind) {
    case "integer": return 0;
    case "enum": return field.values[0];
    case "array": return sibling ? sibling.map(item => emptyValue(field.of, item, null, defaults)) : [];
    case "object": {
      const keys = Object.keys(field.fields).filter(k => field.fields[k].required || (sibling && k in sibling));
      return Object.fromEntries(keys.map(k => [k, emptyValue(field.fields[k], sibling?.[k], k, defaults)]));
    }
    default: return "";
  }
}

function renderInput(value, field, path, onValue) {
  let input;
  if (field.kind === "enum") {
    input = el("select");
    for (const option of field.values) input.add(new Option(option, option));
  } else {
    input = el(isLongText(field) ? "textarea" : "input");
    if (field.kind === "integer") input.type = "number";
    if (isLongText(field)) input.rows = 2;
  }
  input.value = value;
  input.id = fieldId(path);
  input.dataset.path = path;
  input.addEventListener("input", () => onValue(field.kind === "integer" ? Number(input.value) : input.value));
  return input;
}

// Кнопка-иконка. Внутри заголовка карточки клик не должен сворачивать карточку.
function iconButton(icon, label, className, onClick, disabled = false) {
  const button = el("button", className);
  button.type = "button";
  button.disabled = disabled;
  button.setAttribute("aria-label", label);
  const glyph = el("i", "fa " + icon);
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph);
  button.addEventListener("click", event => {
    event.preventDefault();
    onClick();
  });
  return button;
}

const removeButton = (label, onClick) => iconButton("fa-xmark", label, "form-remove", onClick);

function renderEntry(obj, key, field, path, ctx) {
  const remove = field.required ? null
    : removeButton(`Убрать поле «${fieldLabel(key)}»`, () => { delete obj[key]; ctx.restructure(); });
  if (field.kind === "object") {
    const group = el("fieldset", "form-group");
    const legend = el("legend", null, fieldLabel(key));
    if (remove) legend.append(remove);
    group.append(legend, renderObject(obj[key], field.fields, path, ctx));
    return group;
  }
  if (field.kind === "array") return renderArray(obj[key], field, fieldLabel(key), path, ctx, remove);
  const cell = el("div", "form-field span-" + fieldSpan(key, field));
  const head = el("div", "form-field-head");
  const label = el("label", "form-label", fieldLabel(key));
  label.htmlFor = fieldId(path);
  head.append(label);
  if (remove) head.append(remove);
  cell.append(head, renderInput(obj[key], field, path, value => { obj[key] = value; ctx.commit(); }));
  return cell;
}

function renderAddField(obj, fields, missing, path, ctx) {
  const select = el("select", "form-add-field");
  select.setAttribute("aria-label", "Добавить поле");
  select.dataset.path = path;
  select.add(new Option(path === "" ? "Добавить поле виджета…" : "Добавить поле…", ""));
  for (const key of missing) select.add(new Option(fieldLabel(key), key));
  select.addEventListener("change", () => {
    if (!select.value) return;
    obj[select.value] = emptyValue(fields[select.value], undefined, select.value, ctx.defaults);
    ctx.restructure();
  });
  return select;
}

// Выбор нового поля стоит перед списками: на уровне виджета он иначе оказывался
// под строками, рядом с их «Добавить», и читался как поле строки.
function renderObject(obj, fields, path, ctx) {
  const box = el("div", "form-object");
  const missing = Object.keys(fields).filter(key => !(key in obj));
  const addField = missing.length ? renderAddField(obj, fields, missing, path, ctx) : null;
  let addFieldPlaced = false;
  for (const [key, field] of Object.entries(fields)) {
    if (!(key in obj)) continue;
    if (field.kind === "array" && addField && !addFieldPlaced) {
      box.append(addField);
      addFieldPlaced = true;
    }
    box.append(renderEntry(obj, key, field, joinPath(path, key), ctx));
  }
  if (addField && !addFieldPlaced) box.append(addField);
  return box;
}

function renderItem(items, index, field, path, ctx) {
  if (field.kind === "object") return renderObject(items[index], field.fields, path, ctx);
  if (field.kind === "array") return renderArray(items[index], field, "Ячейки", path, ctx, null);
  return renderInput(items[index], field, path, value => { items[index] = value; ctx.commit(); });
}

// Подпись свёрнутой карточки — номер и то, по чему элемент узнают.
function cardTitle(item, index) {
  const text = item && typeof item === "object" && !Array.isArray(item)
    ? item.title ?? item.name ?? item.text ?? "" : "";
  return `${index + 1}. ${text}`.trim();
}

function moveItem(items, from, to, ctx) {
  [items[from], items[to]] = [items[to], items[from]];
  ctx.restructure();
}

// Удаление элемента — в два нажатия: крестик становится «Удалить?», второе нажатие
// удаляет, без него через несколько секунд всё возвращается. Системный confirm во
// фрейме VK браузер может заблокировать, поэтому подтверждение своё.
const DELETE_CONFIRM_MS = 3000;

function deleteButton(label, onDelete) {
  let timer;
  const disarm = () => {
    button.classList.remove("armed");
    button.querySelector(".form-delete-ask")?.remove();
  };
  const button = iconButton("fa-xmark", label, "form-delete", () => {
    if (button.classList.contains("armed")) {
      clearTimeout(timer);
      onDelete();
      return;
    }
    button.classList.add("armed");
    button.append(el("span", "form-delete-ask", "Удалить?"));
    timer = setTimeout(disarm, DELETE_CONFIRM_MS);
  });
  return button;
}

// Стрелки стоят слева, у заголовка, а удаление — одно справа: рядом с крестиком
// промахнуться со «сдвинуть» на «удалить» было слишком легко.
function renderCard(items, index, field, label, path, ctx) {
  const item = items[index];
  const card = el("details", "form-card");
  card.open = ctx.isOpen(item, items.length);
  card.addEventListener("toggle", () => ctx.setOpen(item, card.open));
  const summary = el("summary", "form-card-head");
  const moves = el("span", "form-card-moves");
  moves.append(
    iconButton("fa-arrow-up", `Поднять: ${label}, ${index + 1}`, "form-move form-move-up",
      () => moveItem(items, index, index - 1, ctx), index === 0),
    iconButton("fa-arrow-down", `Опустить: ${label}, ${index + 1}`, "form-move form-move-down",
      () => moveItem(items, index, index + 1, ctx), index === items.length - 1),
  );
  summary.append(moves, el("span", "form-card-title", cardTitle(item, index)),
    deleteButton(`Удалить: ${label}, ${index + 1}`, () => { items.splice(index, 1); ctx.restructure(); }));
  card.append(summary, renderItem(items, index, field.of, joinPath(path, index), ctx));
  return card;
}

// «Добавить» стоит в шапке списка и кладёт элемент первым: в длинном списке
// новый не приходится искать в конце.
function renderArray(items, field, label, path, ctx, remove) {
  const section = el("section", "form-array");
  const head = el("div", "form-array-head");
  const add = el("button", "form-add", "Добавить");
  add.type = "button";
  add.dataset.path = path;
  add.disabled = field.max !== undefined && items.length >= field.max;
  add.addEventListener("click", () => {
    const item = emptyValue(field.of, items[0], null, ctx.defaults);
    items.unshift(item);
    ctx.setOpen(item, true);
    ctx.restructure();
  });
  head.append(el("h3", null, label), el("span", "form-count", field.max ? `${items.length} из ${field.max}` : String(items.length)), add);
  if (remove) head.append(remove);
  section.append(head);
  items.forEach((item, index) => section.append(renderCard(items, index, field, label, path, ctx)));
  return section;
}

/* ==== ФОРМА ==== */
function renderProblems(list, problems) {
  list.replaceChildren(...problems.map(text => el("li", null, text)));
}

// Состояние раскрытия карточек держится по самим элементам: при перестановке
// раскрытая карточка остаётся раскрытой. Без явного выбора короткий список раскрыт.
function openState() {
  const open = new Map();
  return {
    isOpen: (item, count) => (open.has(item) ? open.get(item) : count <= CARDS_OPEN_UP_TO),
    setOpen: (item, value) => {
      if (item && typeof item === "object") open.set(item, value);
    },
  };
}

function formBar(container) {
  const bar = el("div", "form-bar");
  const toggleAll = open => () => container.querySelectorAll("details").forEach(details => { details.open = open; });
  const collapse = el("button", "form-bar-button form-collapse-all", "Свернуть все");
  const expand = el("button", "form-bar-button form-expand-all", "Развернуть все");
  collapse.type = expand.type = "button";
  collapse.addEventListener("click", toggleAll(false));
  expand.addEventListener("click", toggleAll(true));
  bar.append(collapse, expand);
  return bar;
}

// Правка значения пишет код и обновляет список нарушений, форму не перерисовывает —
// иначе поле теряло бы фокус на каждой букве. Добавление, удаление и перестановка перерисовывают.
function renderWidgetForm(container, type, widget, writeCode, defaults) {
  const problems = el("ul", "form-problems");
  const ctx = {
    ...openState(),
    defaults,
    commit() {
      writeCode(widgetToCode(widget));
      renderProblems(problems, validateWidget(type, widget));
    },
    restructure() {
      ctx.commit();
      draw();
    },
  };
  function draw() {
    container.replaceChildren(formBar(container), renderObject(widget, WIDGET_TYPES[type].fields, "", ctx), problems);
    renderProblems(problems, validateWidget(type, widget));
  }
  draw();
}

// Каждый блок — своя область. Правка меняет только литерал блока; после неё
// позиции всех литералов сдвигаются, поэтому они пересчитываются по новому коду,
// а значения остаются теми же объектами, к которым привязаны поля.
function renderBlocksForm(container, type, code, blocks, writeCode, defaults) {
  let current = code;
  const cards = openState();
  const syncRanges = () => {
    const ranges = new Map(literalDeclarations(current).map(d => [d.name, d]));
    for (const block of blocks) Object.assign(block, { start: ranges.get(block.name).start, end: ranges.get(block.name).end });
  };
  const areas = blocks.map(block => {
    const area = el("details", "form-block");
    area.open = true;
    area.dataset.name = block.name;
    const summary = el("summary", "form-block-head");
    summary.append(el("span", "form-block-title", block.title ?? block.name));
    if (block.title) summary.append(el("code", "form-block-name", block.name));
    const body = el("div", "form-block-body");
    const problems = el("ul", "form-problems");
    const ctx = {
      ...cards,
      defaults,
      commit() {
        current = current.slice(0, block.start) + literalToCode(block.value) + current.slice(block.end);
        writeCode(current);
        syncRanges();
        renderProblems(problems, blockProblems(block));
      },
      restructure() {
        ctx.commit();
        draw();
      },
    };
    function draw() {
      body.replaceChildren(Array.isArray(block.value)
        ? renderArray(block.value, arrField(block.shape), "Элементы", block.name, ctx, null)
        : renderObject(block.value, block.shape.fields, block.name, ctx), problems);
      renderProblems(problems, blockProblems(block));
    }
    draw();
    area.append(summary, body);
    return area;
  });
  container.replaceChildren(formBar(container),
    el("p", "form-note", "Скрипт: в форме блоки данных, логика остаётся в коде и не меняется."), ...areas);
}

function renderForm(container, type, code, writeCode, defaults = {}) {
  // Шаблон предлагается только пустому коду: поверх готового он бы всё затёр.
  if (code.trim() === "") {
    const start = el("button", "form-add form-start", "Начать с шаблона");
    start.type = "button";
    start.addEventListener("click", () => {
      const template = templateToCode(type);
      // Свой шаг истории: иначе быстрый ввод после шаблона склеился бы с ним,
      // и «Отменить» сносила бы шаблон вместе с первой правкой.
      writeCode(template, "template");
      renderForm(container, type, template, writeCode, defaults);
    });
    container.replaceChildren(el("p", "form-refusal", "Код пуст."), start);
    return;
  }
  const widget = readSimpleWidget(code);
  if (widget) {
    const comments = leadingComments(code);
    renderWidgetForm(container, type, widget, (next, origin) => writeCode(comments + next, origin), defaults);
    return;
  }
  const blocks = findBlocks(code, type);
  if (blocks?.length) {
    renderBlocksForm(container, type, code, blocks, writeCode, defaults);
    return;
  }
  container.replaceChildren(el("p", "form-refusal",
    "В этом коде нет блоков данных, которые понимает форма. Правь его во вкладке «Код»."));
}
