/* Типы виджетов VK: подпись, схема полей, правила и пример кода — одна таблица на всё.
   Отсюда берут список типов на странице, шаблоны, форма без кода и проверка.

   Схема по https://dev.vk.com/ru/reference/objects/app-widget (сверено 2026-09-12).
   Длина строк в доке считается в символах UTF-16 — это и есть String.length. */

/* ==== ПОЛЯ ==== */
const strField = (max, extra) => ({ kind: "string", max, ...extra });
const urlField = extra => ({ kind: "url", ...extra });
const intField = (min, max, extra) => ({ kind: "integer", min, max, ...extra });
const enumField = values => ({ kind: "enum", values });
const objField = fields => ({ kind: "object", fields });
const arrField = (of, min, max) => ({ kind: "array", of, min, max });

// Шапка и подвал общие для всех типов. В доке у more_url и местами у title_url
// написан тип «object» — это опечатка: во всех примерах там строка-адрес.
const HEADER_FOOTER = {
  title: strField(100, { required: true }),
  title_url: urlField(),
  title_counter: intField(),
  more: strField(100),
  more_url: urlField({ requiredWith: "more" }),
};

// sameInAll — правило доки «должно быть указано у всех элементов или не указано ни у одного».
const LIST_ROW = objField({
  title: strField(undefined, { required: true, oneLine: true }),
  title_url: urlField(),
  button: strField(50, { sameInAll: true }),
  button_url: urlField({ requiredWith: "button" }),
  icon_id: strField(undefined, { sameInAll: true }),
  descr: strField(100, { oneLine: true }),
  address: strField(100),
  time: strField(100),
  text: strField(300),
});

const COVER_ROW = objField({
  title: strField(),
  button: strField(50, { sameInAll: true }),
  button_url: urlField({ requiredWith: "button" }),
  cover_id: strField(undefined, { required: true }),
  url: urlField(),
  descr: strField(100, { oneLine: true }),
});

const TILE = objField({
  title: strField(),
  descr: strField(50, { oneLine: true, sameInAll: true }),
  url: urlField(),
  link: strField(50),
  link_url: urlField({ requiredWith: "link" }),
  icon_id: strField(),
});

const TEAM = objField({ name: strField(50), descr: strField(50), icon_id: strField() });
const SCORE = objField({ team_a: intField(-999, 999), team_b: intField(-999, 999) });
const TEAM_EVENTS = arrField(objField({ event: strField(50), minute: intField() }), 0, 6);

// List и Compact list: до 6 строк, но если хоть у одной есть text — до 3.
const LIST_FIELDS = { ...HEADER_FOOTER, rows: arrField(LIST_ROW, 1, 6) };
const LIST_RULES = [
  widget => widget.rows?.some(row => row.text) && widget.rows.length > 3
    ? "rows: если у строк есть text, строк не больше 3" : null,
];

// Логотипы команд «указываются для каждой или не указываются для обеих».
const bothTeamIcons = match => Boolean(match?.team_a?.icon_id) === Boolean(match?.team_b?.icon_id);

// Адрес для примеров: VK не пускает в виджет ничего, кроме своих доменов, даже "#".
const SAMPLE_URL = "https://vk.com";

// Подписи полей в форме: ключи VK английские, человеку нужны слова.
const FIELD_LABELS = {
  title: "Заголовок", title_url: "Ссылка заголовка", title_counter: "Счётчик",
  more: "Текст подвала", more_url: "Ссылка подвала",
  rows: "Строки", tiles: "Плитки", head: "Колонки", body: "Строки таблицы", matches: "Матчи",
  button: "Кнопка", button_url: "Ссылка кнопки", icon_id: "Иконка, id", cover_id: "Обложка, id",
  descr: "Описание", address: "Адрес", time: "Время работы", text: "Текст", text_url: "Ссылка текста",
  url: "Ссылка", link: "Доп. ссылка", link_url: "Адрес доп. ссылки", align: "Выравнивание",
  match: "Матч", state: "Состояние", team_a: "Команда A", team_b: "Команда B", name: "Название",
  score: "Счёт", events: "События", event: "Игрок", minute: "Минута", live_url: "Трансляция",
  date: "Период", start: "Начало, unixtime", end: "Конец, unixtime",
  goal: "Цель", funded: "Собрано", backers: "Участников", currency: "Валюта",
};

/* ==== ТИПЫ ==== */
const WIDGET_TYPES = {
  list: {
    label: "List",
    fields: LIST_FIELDS,
    rules: LIST_RULES,
    template: { title: "Рестораны", rows: [{ title: "Корюшка", button: "Забронировать", button_url: SAMPLE_URL, descr: "Вид на стрелку" }] },
  },
  table: {
    label: "Table",
    fields: {
      ...HEADER_FOOTER,
      head: arrField(objField({ text: strField(50), align: enumField(["left", "center", "right"]) }), 1, 6),
      body: arrField(arrField(objField({ text: strField(100), url: urlField(), icon_id: strField() }), 1, 6), 1, 11),
    },
    rules: [
      widget => (widget.head ? 1 : 0) + (widget.body?.length ?? 0) > 11
        ? "table: не больше 11 строк вместе со строкой заголовков" : null,
      widget => widget.body?.some(row => row.slice(1).some(cell => cell.icon_id))
        ? "body: icon_id только у первой ячейки строки" : null,
    ],
    template: { title: "Таблица", head: [{ text: "Колонка 1" }], body: [[{ text: "Ячейка" }]] },
  },
  tiles: {
    label: "Tiles",
    fields: { ...HEADER_FOOTER, tiles: arrField(TILE, 3, 10) },
    template: {
      title: "Фильмы",
      tiles: [
        { title: "Доктор Стрэндж", descr: "Фэнтези", url: SAMPLE_URL, link: "Купить", link_url: SAMPLE_URL },
        { title: "Прибытие", descr: "Фантастика", url: SAMPLE_URL, link: "Купить", link_url: SAMPLE_URL },
        { title: "Интерстеллар", descr: "Фантастика", url: SAMPLE_URL, link: "Купить", link_url: SAMPLE_URL },
      ],
    },
  },
  // По доке Compact list «аналогичен List, за исключением того, что кнопка располагается справа».
  compact_list: {
    label: "Compact list",
    fields: LIST_FIELDS,
    rules: LIST_RULES,
    template: { title: "Компактный список", rows: [{ title: "Элемент", button: "Подробнее", button_url: SAMPLE_URL, descr: "Описание" }] },
  },
  cover_list: {
    label: "Cover list",
    fields: { ...HEADER_FOOTER, rows: arrField(COVER_ROW, 1, 3) },
    template: { title: "Рестораны", rows: [{ title: "Корюшка", button: "Забронировать", cover_id: "12345_6789", url: SAMPLE_URL, button_url: SAMPLE_URL, descr: "Описание" }] },
  },
  match: {
    label: "Match",
    fields: {
      ...HEADER_FOOTER,
      match: objField({ state: strField(50), team_a: TEAM, team_b: TEAM, score: SCORE,
        events: objField({ team_a: TEAM_EVENTS, team_b: TEAM_EVENTS }) }),
    },
    rules: [widget => bothTeamIcons(widget.match) ? null : "match: icon_id у обеих команд или ни у одной"],
    template: { title: "Матч", match: { state: "Идёт первый тайм", team_a: { name: "Зенит" }, team_b: { name: "Спартак" }, score: { team_a: 2, team_b: 0 } } },
  },
  matches: {
    label: "Matches",
    fields: {
      ...HEADER_FOOTER,
      // icon_id у матча в списке полей доки не описан, но стоит в её же примере — оставляем.
      matches: arrField(objField({ state: strField(50), live_url: urlField(), url: urlField(), icon_id: strField(),
        team_a: TEAM, team_b: TEAM, score: SCORE })),
    },
    rules: [widget => widget.matches?.every(bothTeamIcons) === false ? "matches: icon_id у обеих команд или ни у одной" : null],
    template: { title: "Список матчей", matches: [{ team_a: { name: "Зенит" }, team_b: { name: "Спартак" }, score: { team_a: 2, team_b: 0 }, icon_id: "123_456" }] },
  },
  donation: {
    label: "Donation",
    fields: {
      ...HEADER_FOOTER,
      title_counter: intField(-1000000, 1000000),
      more: strField(),
      text: strField(80),
      text_url: urlField(),
      button_url: urlField({ required: true }),
      date: objField({ start: intField(), end: intField() }),
      goal: intField(0, 99999999),
      funded: intField(0, 99999999),
      backers: intField(0, 99999999),
      currency: enumField(["RUB", "USD", "UAH", "BYR", "EUR", "MDL", "AZN", "GEL", "AMD", "ILS", "GBP", "TMT", "BYN", "KZS", "KZT"]),
    },
    template: { title: "Поддержать", text: "На помощь животным", button_url: SAMPLE_URL, goal: 80000, funded: 7000, backers: 20, currency: "RUB", date: { start: 1700000000, end: 1701000000 } },
  },
};

/* ==== ПРОВЕРКА ==== */
// Адреса VK пускает только на свои домены. Дока говорит расплывчато «внутренние ссылки»,
// точный список дал ответ предпросмотра: «only vk.com, vk.ru, vkontakte.ru, vkvideo.ru,
// assetcache.ru, vk.me, vk.cc, vk.link urls are allowed». Схема необязательна: в примерах
// доки встречается vk.com/club1 без https.
const VK_URL_HOSTS = ["vk.com", "vk.ru", "vkontakte.ru", "vkvideo.ru", "assetcache.ru", "vk.me", "vk.cc", "vk.link"];

function isVkUrl(value) {
  const host = value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].toLowerCase();
  return VK_URL_HOSTS.some(allowed => host === allowed || host.endsWith("." + allowed));
}

// Список нарушений схемы; пустой список — виджет по доке корректен.
function validateWidget(type, widget) {
  const spec = WIDGET_TYPES[type];
  const problems = [];
  checkObject(widget, spec.fields, "виджет", problems);
  for (const rule of spec.rules ?? []) {
    const problem = rule(widget);
    if (problem) problems.push(problem);
  }
  return problems;
}

function checkObject(value, fields, path, problems) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${path}: нужен объект`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in fields)) problems.push(`${path}.${key}: такого поля в доке нет`);
  }
  for (const [key, field] of Object.entries(fields)) {
    const here = `${path}.${key}`;
    if (key in value) {
      checkValue(value[key], field, here, problems);
    } else if (field.required) {
      problems.push(`${here}: обязательное поле`);
    } else if (field.requiredWith && field.requiredWith in value) {
      problems.push(`${here}: обязательно, раз указано ${field.requiredWith}`);
    }
  }
}

function checkValue(value, field, path, problems) {
  switch (field.kind) {
    case "string":
    case "url":
      if (typeof value !== "string") {
        problems.push(`${path}: нужна строка`);
      } else {
        if (field.max && value.length > field.max) problems.push(`${path}: длиннее ${field.max} символов`);
        if (field.oneLine && value.includes("\n")) problems.push(`${path}: без переносов строки`);
        if (field.kind === "url" && !isVkUrl(value)) problems.push(`${path}: адрес только на домены VK: ${VK_URL_HOSTS.join(", ")}`);
      }
      break;
    case "integer":
      if (!Number.isInteger(value)) {
        problems.push(`${path}: нужно целое число`);
      } else if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        problems.push(`${path}: вне диапазона ${field.min}..${field.max}`);
      }
      break;
    case "enum":
      if (!field.values.includes(value)) problems.push(`${path}: допустимо ${field.values.join(", ")}`);
      break;
    case "object":
      checkObject(value, field.fields, path, problems);
      break;
    case "array":
      if (!Array.isArray(value)) {
        problems.push(`${path}: нужен массив`);
        break;
      }
      if (field.min !== undefined && value.length < field.min) problems.push(`${path}: не меньше ${field.min}`);
      if (field.max !== undefined && value.length > field.max) problems.push(`${path}: не больше ${field.max}`);
      value.forEach((item, i) => checkValue(item, field.of, `${path}[${i}]`, problems));
      if (field.of.kind === "object") checkSameInAll(value, field.of.fields, path, problems);
      break;
  }
}

function checkSameInAll(items, fields, path, problems) {
  for (const [key, field] of Object.entries(fields)) {
    if (!field.sameInAll) continue;
    const present = items.filter(item => item && key in item).length;
    if (present && present !== items.length) problems.push(`${path}: ${key} у всех элементов или ни у одного`);
  }
}
