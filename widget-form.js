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

function readSimpleWidget(code) {
  const match = code.trim().match(/^return\s+([\s\S]*?);?$/);
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

// Длинный текст, в котором VK допускает переносы, правится в многострочном поле.
const isLongText = field => field.kind === "string" && !field.oneLine && (field.max ?? 0) >= 200;

// Значение нового поля или элемента. Новый элемент повторяет набор полей соседа:
// у VK кнопки и иконки должны быть у всех элементов списка или ни у одного.
function emptyValue(field, sibling) {
  switch (field.kind) {
    case "integer": return 0;
    case "enum": return field.values[0];
    case "array": return sibling ? sibling.map(item => emptyValue(field.of, item)) : [];
    case "object": {
      const keys = Object.keys(field.fields).filter(key => field.fields[key].required || (sibling && key in sibling));
      return Object.fromEntries(keys.map(key => [key, emptyValue(field.fields[key], sibling?.[key])]));
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
    if (isLongText(field)) input.rows = 3;
  }
  input.value = value;
  input.id = fieldId(path);
  input.dataset.path = path;
  input.addEventListener("input", () => onValue(field.kind === "integer" ? Number(input.value) : input.value));
  return input;
}

function removeButton(label, onClick) {
  const button = el("button", "form-remove");
  button.type = "button";
  button.setAttribute("aria-label", label);
  const icon = el("i", "fa fa-xmark");
  icon.setAttribute("aria-hidden", "true");
  button.append(icon);
  button.addEventListener("click", onClick);
  return button;
}

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
  const row = el("div", "form-field");
  const label = el("label", "form-label", fieldLabel(key));
  label.htmlFor = fieldId(path);
  row.append(label, renderInput(obj[key], field, path, value => { obj[key] = value; ctx.commit(); }));
  if (remove) row.append(remove);
  return row;
}

function renderAddField(obj, fields, missing, path, ctx) {
  const select = el("select", "form-add-field");
  select.setAttribute("aria-label", "Добавить поле");
  select.dataset.path = path;
  select.add(new Option(path === "" ? "Добавить поле виджета…" : "Добавить поле…", ""));
  for (const key of missing) select.add(new Option(fieldLabel(key), key));
  select.addEventListener("change", () => {
    if (!select.value) return;
    obj[select.value] = emptyValue(fields[select.value]);
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

function renderArray(items, field, label, path, ctx, remove) {
  const section = el("section", "form-array");
  const head = el("div", "form-array-head");
  head.append(el("h3", null, label), el("span", "form-count", field.max ? `${items.length} из ${field.max}` : String(items.length)));
  if (remove) head.append(remove);
  section.append(head);
  items.forEach((item, index) => {
    const card = el("div", "form-card");
    const cardHead = el("div", "form-card-head");
    cardHead.append(el("span", null, String(index + 1)),
      removeButton(`Удалить: ${label}, ${index + 1}`, () => { items.splice(index, 1); ctx.restructure(); }));
    card.append(cardHead, renderItem(items, index, field.of, joinPath(path, index), ctx));
    section.append(card);
  });
  const add = el("button", "form-add", "Добавить");
  add.type = "button";
  add.dataset.path = path;
  add.disabled = field.max !== undefined && items.length >= field.max;
  add.addEventListener("click", () => {
    items.push(emptyValue(field.of, items[items.length - 1]));
    ctx.restructure();
  });
  section.append(add);
  return section;
}

/* ==== ФОРМА ==== */
function renderProblems(list, problems) {
  list.replaceChildren(...problems.map(text => el("li", null, text)));
}

// Правка значения пишет код и обновляет список нарушений, форму не перерисовывает —
// иначе поле теряло бы фокус на каждой букве. Добавление и удаление перерисовывают.
function renderWidgetForm(container, type, widget, writeCode) {
  const problems = el("ul", "form-problems");
  const ctx = {
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
    container.replaceChildren(renderObject(widget, WIDGET_TYPES[type].fields, "", ctx), problems);
    renderProblems(problems, validateWidget(type, widget));
  }
  draw();
}

// Каждый блок — своя область. Правка меняет только литерал блока; после неё
// позиции всех литералов сдвигаются, поэтому они пересчитываются по новому коду,
// а значения остаются теми же объектами, к которым привязаны поля.
function renderBlocksForm(container, type, code, blocks, writeCode) {
  let current = code;
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
  container.replaceChildren(el("p", "form-note",
    "Скрипт: в форме блоки данных, логика остаётся в коде и не меняется."), ...areas);
}

function renderForm(container, type, code, writeCode) {
  const widget = readSimpleWidget(code);
  if (widget) {
    renderWidgetForm(container, type, widget, writeCode);
    return;
  }
  const blocks = findBlocks(code, type);
  if (blocks?.length) {
    renderBlocksForm(container, type, code, blocks, writeCode);
    return;
  }
  container.replaceChildren(el("p", "form-refusal",
    "В этом коде нет блоков данных, которые понимает форма. Правь его во вкладке «Код»."));
}
