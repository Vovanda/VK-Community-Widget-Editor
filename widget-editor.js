// ------------------ Глобальные переменные ------------------
var widgetType;  // глобально, чтобы onReady видел
var editor;      // глобально, чтобы onReady видел

// ------------------ Глобальные функции ------------------
function addError(msg) {
  const $container = $(".error-log");
  $("#vk-alerts").show();

  const $details = $("<details>").addClass("error-item");
  const summaryText = msg.length > 30 ? msg.slice(0, 30) + "..." : msg;
  const $summary = $("<summary>").text(summaryText);
  const $pre = $("<pre>").text(msg);

  $details.append($summary).append($pre);
  $container.prepend($details);
}

// Глобальная функция для VK.init
function onReady() {
  // VK API ошибки
  VK.addCallback('onAppWidgetPreviewFail', e => addError('VK Preview Fail: ' + JSON.stringify(e)));
  VK.addCallback('onAppWidgetPreviewCancel', e => console.log('VK Preview Cancel!'));
  VK.addCallback('onAppWidgetPreviewSuccess', e => console.log('VK Preview Success!', e));

  // Предпросмотр виджета
  $('#previewBtn').click(() => {
    try {
      VK.callMethod("showAppWidgetPreviewBox", widgetType, editor.getValue());
    } catch(e) {
      console.error("VK JS Exception (не в лог):", e);
    }
  });

  // Настройки прав на группу
  $('#btn-permission').click(() => VK.callMethod("showGroupSettingsBox", 64));
}

// ------------------ Код редактора ------------------
$(function() {
  const MAX_HISTORY = 1000;
  const LS_KEY = "vk_widget_editor_state";

  const templates = {
    text: { title:"Цитата дня", text:"«Нам нужно гордиться»" },
    list: { title:"Рестораны", rows:[{title:"Корюшка", button:"Забронировать", button_url:"#", descr:"Вид на стрелку"}] },
    table:{ title:"Таблица", head:[{text:"Колонка 1"}], body:[[{"text":"Ячейка"}]] },
    tiles:{ title:"Фильмы", tiles:[{title:"Доктор Стрэндж", descr:"Фэнтези", url:"#", link:"Купить", link_url:"#"}] },
    compact_list:{ title:"Компактный список", rows:[{title:"Элемент", button:"Подробнее", button_url:"#", descr:"Описание"}] },
    cover_list:{ title:"Рестораны", rows:[{title:"Корюшка", button:"Забронировать", cover_id:"12345_6789", url:"#", button_url:"#", descr:"Описание"}] },
    match:{ title:"Матч", match:{state:"Идёт первый тайм", team_a:{name:"Зенит"}, team_b:{name:"Спартак"}, score:{team_a:2,team_b:0}} },
    matches:{ title:"Список матчей", matches:[{team_a:{name:"Зенит"}, team_b:{name:"Спартак"}, score:{team_a:2,team_b:0}, icon_id:"123_456"}] },
    donation:{ title:"Поддержать", text:"На помощь животным", button_url:"#", goal:80000, funded:7000, backers:20, currency:"RUB", date:{start:1700000000,end:1701000000} }
  };

  let state = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  if(!state.widgetType) state.widgetType = 'text';
  widgetType = state.widgetType;

  if(!state.history) state.history = {};
  if(!state.history[widgetType]) state.history[widgetType] = [];
  let histIndex = state.history[widgetType].length - 1;

  editor = CodeMirror.fromTextArea($("#editor")[0], {
    mode:"javascript",
    lineNumbers:true,
    matchBrackets:true,
    autoCloseBrackets:true,
    theme:"default"
  });

  if(histIndex >= 0) editor.setValue(state.history[widgetType][histIndex]);
  else {
    const code = "return "+JSON.stringify(templates[widgetType], null, 2)+";";
    editor.setValue(code);
    state.history[widgetType].push(code);
    histIndex++;
    saveState();
  }

  function saveState(){
    state.widgetType = widgetType;
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  // Отслеживаем изменения для истории
  editor.on("change", ()=> {
    const val = editor.getValue();
    if(state.history[widgetType][histIndex] !== val){
      state.history[widgetType].push(val);
      histIndex = state.history[widgetType].length-1;
      saveState();
    }
  });

  // Смена типа виджета
  $("#widget-type").val(widgetType);
  $("#widget-type").on("change", function(){
    widgetType = $(this).val();
    if(!state.history[widgetType]) state.history[widgetType] = [];
    histIndex = state.history[widgetType].length-1;
    if(histIndex>=0) editor.setValue(state.history[widgetType][histIndex]);
    else {
      const code = "return "+JSON.stringify(templates[widgetType], null, 2)+";";
      editor.setValue(code);
      state.history[widgetType].push(code);
      histIndex++;
    }
    saveState();
  });

  // Undo/Redo
  $("#undoBtn").click(()=> {
    if(histIndex>0){
      histIndex--;
      editor.setValue(state.history[widgetType][histIndex]);
    }
  });
  $("#redoBtn").click(()=> {
    if(histIndex<state.history[widgetType].length-1){
      histIndex++;
      editor.setValue(state.history[widgetType][histIndex]);
    }
  });

  // Сниппет
  $("#snippetBtn").click(()=> {
    const snippet = `// Random snippet
var friends_ids = API.friends.get({ user_id: 3972090, count: 10000 });
var count_of_randoms = 2;
var rnd_ids = API.friends.get({ user_id: 3972090, order: "random", count: count_of_randoms }).items;
var rnd_values = [];
var i = 0;

while (i < count_of_randoms) {
    rnd_values.push(friends_ids.items.indexOf(rnd_ids[i]) / friends_ids.count);
    i = i + 1;
}`;
    editor.setValue(snippet + "\n" + editor.getValue());
  });

  // Шаблон
  $("#templateBtn").click(()=> {
    const code = "return "+JSON.stringify(templates[widgetType], null, 2)+";";
    editor.setValue(code);
  });

  // Форматирование
  $("#formatBtn").click(()=> {
    try{
      const code = editor.getValue();
      const match = code.match(/return\s+([\s\S]*);/);
      if(!match) return;
      const obj = eval("("+match[1]+")");
      editor.setValue("return "+JSON.stringify(obj, null, 2)+";");
    } catch(e){
      console.error("Format error (не в лог):", e);
    }
  });

  // Очистка ошибок VK
  $("#clearErrorsBtn").click(()=> {
    $(".error-log").empty();
    $("#vk-alerts").hide();
  });
});
