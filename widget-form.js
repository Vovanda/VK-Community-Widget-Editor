/* Форма без кода — второй вид того же кода. Источник правды один: документ
   CodeMirror. Форма вычитывает из кода виджет, а каждую правку пишет обратно
   в код, поэтому отмена, хранение и предпросмотр одинаковы в обоих видах.

   Сейчас форма понимает только простой код — один return с JSON-объектом,
   как у шаблонов. Скрипт с переменными и вызовами API она не трогает. */

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
// Правка значения пишет код и обновляет список нарушений, форму не перерисовывает —
// иначе поле теряло бы фокус на каждой букве. Добавление и удаление перерисовывают.
function renderForm(container, type, code, writeCode) {
  const widget = readSimpleWidget(code);
  if (!widget) {
    container.replaceChildren(el("p", "form-refusal",
      "Этот код сложнее формы: в нём есть переменные или вызовы API. Правь его во вкладке «Код»."));
    return;
  }
  const problems = el("ul", "form-problems");
  const showProblems = () =>
    problems.replaceChildren(...validateWidget(type, widget).map(text => el("li", null, text)));
  const ctx = {
    commit() {
      writeCode(widgetToCode(widget));
      showProblems();
    },
    restructure() {
      ctx.commit();
      draw();
    },
  };
  function draw() {
    container.replaceChildren(renderObject(widget, WIDGET_TYPES[type].fields, "", ctx), problems);
    showProblems();
  }
  draw();
}
