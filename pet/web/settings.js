(function () {
  "use strict";

  var tauri = window.__TAURI__ || {};
  var invoke = tauri.core && tauri.core.invoke;
  var windowApi = tauri.window;

  var DEFAULT_LINES = [
    "今天也想吃点好的。",
    "你忙你的，我在这儿待着。",
    "有点困，但还能再撑一会儿。",
    "要不要歇一会儿？",
    "这事儿不急，慢慢来。",
    "喝口水吧。",
    "我在想晚上吃什么。",
    "安静一会儿也挺好。",
    "你好像很久没动了。",
    "我是不是有点话多？",
    "今天过得还行吧。",
    "别熬太晚。",
    "我在这儿，不走。",
    "这个点，该吃点东西了。",
    "慢慢来，不着急。",
    "记得伸个懒腰。",
  ];

  var DEFAULTS = {
    appearance: { scale: 100, corner: "bottom-right", alwaysOnTop: true, bubbleFontSize: 15 },
    behavior: { idleActions: true, idleIntervalMin: 4, clickReact: true, dragAnimation: true },
    speech: {
      bubbleDurationSec: 6,
      chatter: true,
      chatterIntervalMin: 8,
      chatterLines: DEFAULT_LINES.slice(),
    },
    updatedAt: "",
  };

  var CORNERS = [
    ["bottom-right", "右下角"],
    ["bottom-left", "左下角"],
    ["top-right", "右上角"],
    ["top-left", "左上角"],
  ];

  var SCHEMA = [
    {
      id: "appearance",
      label: "外观",
      cards: [
        {
          title: "人物",
          hint: "保存后桌宠窗口会按比例调整",
          fields: [
            { type: "range", path: "appearance.scale", label: "人物大小", min: 80, max: 140, step: 5, unit: "%" },
            { type: "select", path: "appearance.corner", label: "停靠角落", options: CORNERS },
            { type: "toggle", path: "appearance.alwaysOnTop", label: "始终置顶" },
          ],
        },
        {
          title: "气泡",
          hint: "说话时显示的文字大小",
          fields: [{ type: "range", path: "appearance.bubbleFontSize", label: "字号", min: 13, max: 18, step: 1, unit: "px" }],
        },
      ],
    },
    {
      id: "behavior",
      label: "行为",
      cards: [
        {
          title: "空闲动作",
          hint: "没人理的时候，她会自己看看四周或走两步",
          fields: [
            { type: "toggle", path: "behavior.idleActions", label: "开启空闲小动作" },
            { type: "range", path: "behavior.idleIntervalMin", label: "间隔", min: 1, max: 10, step: 1, unit: "分钟" },
          ],
        },
        {
          title: "交互",
          hint: "鼠标操作时的反应",
          fields: [
            { type: "toggle", path: "behavior.clickReact", label: "点击时回应" },
            { type: "toggle", path: "behavior.dragAnimation", label: "拖拽时播放拖拽动画" },
          ],
        },
      ],
    },
    {
      id: "speech",
      label: "说话",
      cards: [
        {
          title: "气泡",
          fields: [{ type: "range", path: "speech.bubbleDurationSec", label: "停留时长", min: 3, max: 15, step: 1, unit: "秒" }],
        },
        {
          title: "碎碎念",
          hint: "闲下来自己说一句，纯本地台词，不花 token",
          fields: [
            { type: "toggle", path: "speech.chatter", label: "开启碎碎念" },
            { type: "range", path: "speech.chatterIntervalMin", label: "间隔", min: 3, max: 15, step: 1, unit: "分钟" },
            { type: "textarea", path: "speech.chatterLines", label: "台词表（一行一句）", hint: "留空则使用内置台词" },
          ],
        },
      ],
    },
    {
      id: "about",
      label: "关于",
      cards: [
        {
          title: "Pet 桌宠",
          fields: [
            { type: "info", label: "版本", value: "0.1.0" },
            { type: "info", label: "数据目录", id: "dataDir", value: "读取中…" },
            {
              type: "actions",
              label: "退出",
              buttons: [["退出 Pet", "quit"]],
            },
          ],
        },
      ],
    },
  ];

  var settings = clone(DEFAULTS);
  var statusEl = document.getElementById("status");
  var saveBtn = document.getElementById("save");
  var navEl = document.getElementById("nav");
  var panelsEl = document.getElementById("panels");
  var currentSection = "appearance";

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, patch) {
    var out = clone(base);
    if (!patch || typeof patch !== "object") return out;
    Object.keys(patch).forEach(function (key) {
      var next = patch[key];
      if (next && typeof next === "object" && !Array.isArray(next) && typeof out[key] === "object") {
        out[key] = deepMerge(out[key], next);
      } else if (next !== undefined) {
        out[key] = next;
      }
    });
    return out;
  }

  function getPath(object, path) {
    return path.split(".").reduce(function (acc, key) {
      return acc && typeof acc === "object" ? acc[key] : undefined;
    }, object);
  }

  function setPath(object, path, value) {
    var keys = path.split(".");
    var cursor = object;
    for (var i = 0; i < keys.length - 1; i += 1) {
      if (!cursor[keys[i]] || typeof cursor[keys[i]] !== "object") cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
  }

  function request(method, payload) {
    if (!invoke) return Promise.resolve(null);
    return invoke("pet_request", { method: method, payload: payload || {} });
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  // ---------- 渲染 ----------

  function buildNav() {
    navEl.textContent = "";
    SCHEMA.forEach(function (section) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = section.label;
      button.dataset.section = section.id;
      if (section.id === currentSection) button.classList.add("active");
      button.addEventListener("click", function () {
        currentSection = section.id;
        Array.prototype.forEach.call(navEl.children, function (child) {
          child.classList.toggle("active", child.dataset.section === section.id);
        });
        Array.prototype.forEach.call(panelsEl.children, function (panel) {
          panel.classList.toggle("active", panel.dataset.panel === section.id);
        });
      });
      navEl.appendChild(button);
    });
  }

  function buildPanels() {
    panelsEl.textContent = "";
    SCHEMA.forEach(function (section) {
      var panel = document.createElement("section");
      panel.className = "panel" + (section.id === currentSection ? " active" : "");
      panel.dataset.panel = section.id;
      section.cards.forEach(function (card) {
        panel.appendChild(buildCard(card));
      });
      panelsEl.appendChild(panel);
    });
  }

  function buildCard(card) {
    var wrap = document.createElement("div");
    wrap.className = "card";
    var head = document.createElement("div");
    head.className = "card-head";
    var title = document.createElement("span");
    title.className = "card-title";
    title.textContent = card.title;
    head.appendChild(title);
    if (card.hint) {
      var hint = document.createElement("span");
      hint.className = "card-hint";
      hint.textContent = card.hint;
      head.appendChild(hint);
    }
    wrap.appendChild(head);
    var body = document.createElement("div");
    if (card.fields.length > 1 && card.fields.every(function (f) { return f.type === "toggle"; })) {
      body.className = "grid2";
    }
    card.fields.forEach(function (field) {
      body.appendChild(buildField(field));
    });
    wrap.appendChild(body);
    return wrap;
  }

  function buildField(field) {
    if (field.type === "info") {
      var info = document.createElement("div");
      info.className = "field";
      var infoLabel = document.createElement("div");
      infoLabel.className = "field-label";
      infoLabel.textContent = field.label;
      var infoValue = document.createElement("div");
      infoValue.className = "row-text";
      infoValue.id = field.id || "info-" + field.label;
      infoValue.textContent = field.value || "";
      info.appendChild(infoLabel);
      info.appendChild(infoValue);
      return info;
    }
    if (field.type === "actions") {
      var acts = document.createElement("div");
      acts.className = "field";
      var actsLabel = document.createElement("div");
      actsLabel.className = "field-label";
      actsLabel.textContent = field.label;
      acts.appendChild(actsLabel);
      var row = document.createElement("div");
      row.className = "row-actions";
      field.buttons.forEach(function (item) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "btn";
        button.textContent = item[0];
        button.addEventListener("click", function () {
          if (item[1] === "quit" && invoke) {
            invoke("pet_quit").catch(function (error) {
              setStatus("退出失败：" + String((error && error.message) || error), "err");
            });
          }
        });
        row.appendChild(button);
      });
      acts.appendChild(row);
      return acts;
    }
    if (field.type === "toggle") return buildToggle(field);
    if (field.type === "select") return buildSelect(field);
    if (field.type === "range") return buildRange(field);
    if (field.type === "textarea") return buildTextarea(field);
    return document.createElement("div");
  }

  function buildToggle(field) {
    var wrap = document.createElement("div");
    wrap.className = "toggle";
    var label = document.createElement("span");
    label.className = "toggle-label";
    label.textContent = field.label;
    var switchEl = document.createElement("label");
    switchEl.className = "switch";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!getPath(settings, field.path);
    input.addEventListener("change", function () {
      setPath(settings, field.path, input.checked);
    });
    var track = document.createElement("span");
    track.className = "switch-track";
    switchEl.appendChild(input);
    switchEl.appendChild(track);
    wrap.appendChild(label);
    wrap.appendChild(switchEl);
    return wrap;
  }

  function buildSelect(field) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var label = document.createElement("div");
    label.className = "field-label";
    label.textContent = field.label;
    var select = document.createElement("select");
    field.options.forEach(function (pair) {
      var option = document.createElement("option");
      option.value = pair[0];
      option.textContent = pair[1];
      select.appendChild(option);
    });
    select.value = String(getPath(settings, field.path));
    select.addEventListener("change", function () {
      setPath(settings, field.path, select.value);
    });
    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
  }

  function buildRange(field) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var label = document.createElement("div");
    label.className = "field-label";
    var nameEl = document.createElement("span");
    nameEl.textContent = field.label;
    var valueEl = document.createElement("span");
    valueEl.className = "field-value";
    var input = document.createElement("input");
    input.type = "range";
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    var initial = Number(getPath(settings, field.path));
    input.value = String(Number.isFinite(initial) ? initial : field.min);
    valueEl.textContent = input.value + (field.unit || "");
    input.addEventListener("input", function () {
      var value = Number(input.value);
      setPath(settings, field.path, value);
      valueEl.textContent = value + (field.unit || "");
    });
    label.appendChild(nameEl);
    label.appendChild(valueEl);
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function buildTextarea(field) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var label = document.createElement("div");
    label.className = "field-label";
    label.textContent = field.label;
    if (field.hint) {
      var hint = document.createElement("span");
      hint.className = "field-value";
      hint.textContent = field.hint;
      label.appendChild(hint);
    }
    var area = document.createElement("textarea");
    var lines = getPath(settings, field.path);
    area.value = Array.isArray(lines) ? lines.join("\n") : "";
    area.placeholder = "一行一句";
    area.addEventListener("input", function () {
      var next = area.value
        .split("\n")
        .map(function (line) { return line.trim(); })
        .filter(Boolean);
      setPath(settings, field.path, next);
    });
    wrap.appendChild(label);
    wrap.appendChild(area);
    return wrap;
  }

  // ---------- 读写 ----------

  function load() {
    if (!invoke) {
      render();
      return;
    }
    request("pet.prefs.get")
      .then(function (payload) {
        if (payload && payload.settings) {
          settings = deepMerge(DEFAULTS, payload.settings);
        }
        if (payload && payload.dataDir) {
          var dir = document.getElementById("dataDir");
          if (dir) dir.textContent = payload.dataDir;
        }
        render();
      })
      .catch(function (error) {
        setStatus("读取设置失败：" + String((error && error.message) || error), "err");
        render();
      });
  }

  function render() {
    buildNav();
    buildPanels();
    var dir = document.getElementById("dataDir");
    if (dir && !dir.textContent) dir.textContent = "（未连接后端）";
    Array.prototype.forEach.call(panelsEl.children, function (panel) {
      panel.classList.toggle("active", panel.dataset.panel === currentSection);
    });
  }

  function save() {
    saveBtn.disabled = true;
    setStatus("保存中…");
    request("pet.prefs.set", { settings: settings })
      .then(function () {
        setStatus("已保存", "ok");
        if (invoke) invoke("pet_settings_changed", { settings: settings }).catch(function () {});
        saveBtn.disabled = false;
      })
      .catch(function (error) {
        setStatus("保存失败：" + String((error && error.message) || error), "err");
        saveBtn.disabled = false;
      });
  }

  var closeBtn = document.getElementById("close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      if (invoke) {
        invoke("pet_settings_close").catch(function () {
          if (windowApi && windowApi.getCurrentWindow) windowApi.getCurrentWindow().close();
        });
        return;
      }
      if (windowApi && windowApi.getCurrentWindow) windowApi.getCurrentWindow().close();
    });
  }

  // F12 打开开发者工具（排查用；浏览器里没有 invoke 时自动忽略）。
  window.addEventListener("keydown", function (event) {
    if (event.key === "F12") {
      event.preventDefault();
      if (invoke) invoke("pet_settings_devtools").catch(function () {});
    }
  });

  saveBtn.addEventListener("click", save);
  load();
})();