(function () {
  "use strict";

  // dev 下 vite 热更新可能让脚本执行两次，重复建池会出现两个人物叠在一起。
  if (window.__petBooted) return;
  window.__petBooted = true;

  var tauri = window.__TAURI__ || {};
  var invoke = tauri.core && tauri.core.invoke;
  var listen = tauri.event && tauri.event.listen;
  var windowApi = tauri.window;

  var CLIPS = {
    idle: "assets/idle.webm",
    look: "assets/look.webm",
    drag: "assets/drag.webm",
    happy: "assets/click-happy.webm",
    shy: "assets/click-shy.webm",
    wave: "assets/click-wave.webm",
    sleep: "assets/sleep.webm",
    walk: "assets/walk.webm",
  };

  var app = document.getElementById("app");
  var stage = document.getElementById("stage");
  var hit = document.getElementById("hit");
  var bubble = document.getElementById("bubble");
  var bubbleText = document.getElementById("bubble-text");
  var menu = document.getElementById("menu");

  // 设计稿尺寸：CSS 里的人物与命中区都按这套坐标写，缩放只改 .stage 的 transform。
  var DESIGN_WIDTH = 320;
  var DESIGN_HEIGHT = 440;

  // 后端 prefs.json 是权威，这里是页面首帧的兜底。
  var DEFAULT_PREFS = {
    appearance: { scale: 100, corner: "bottom-right", alwaysOnTop: true, bubbleFontSize: 15 },
    behavior: { idleActions: true, idleIntervalMin: 4, clickReact: true, dragAnimation: true },
    speech: { bubbleDurationSec: 6, chatter: true, chatterIntervalMin: 8, chatterLines: [] },
  };

  var prefs = DEFAULT_PREFS;

  var videos = {};
  var currentName = "";
  var currentVideo = null;
  var bubbleTimer = null;
  var idleTimer = null;
  var menuOpen = false;
  var drag = null;
  var workEl = document.getElementById("work");
  var workTimer = null;
  var WORK_LABELS = {
    thinking: "在想…",
    working: "干活中…",
    result: "有结果了",
    waiting: "等你",
    success: "完成",
    error: "出错了",
  };
  var CLIP_ALIASES = { "click-happy": "happy", "click-shy": "shy", "click-wave": "wave" };

  // 每段素材预加载一个 video，切换时只切显示，避免改 src 造成闪烁/黑帧。
  function buildClips() {
    // 只清 video，保留命中区（命中区跟着 .stage 一起缩放）。
    Array.prototype.slice.call(stage.querySelectorAll("video")).forEach(function (v) {
      v.remove();
    });
    Object.keys(CLIPS).forEach(function (name) {
      var v = document.createElement("video");
      v.className = "anim";
      v.src = CLIPS[name];
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "auto";
      v.style.display = "none";
      stage.appendChild(v);
      videos[name] = v;
    });
  }

  // 窗口被缩放后，人物和命中区按「窗口宽 / 设计稿宽」整体缩放。
  function syncStageScale() {
    var scale = window.innerWidth > 0 ? window.innerWidth / DESIGN_WIDTH : 1;
    stage.style.transform = "scale(" + scale + ")";
  }

  function play(name, options) {
    var once = !!(options && options.once);
    var then = once ? (options && options.then) || "idle" : null;
    var next = videos[name] || videos.idle;
    if (!next) return;
    if (currentVideo === next && !once) {
      // 同一条循环片段正在播，不打断。
      return;
    }
    if (currentVideo && currentVideo !== next) {
      currentVideo.pause();
      currentVideo.style.display = "none";
      currentVideo.onended = null;
    } else if (currentVideo === next) {
      currentVideo.pause();
    }
    currentVideo = next;
    currentName = name;
    next.loop = !once;
    next.style.display = "block";
    try {
      next.currentTime = 0;
    } catch (ignored) {}
    next.onended = once
      ? function () {
          next.onended = null;
          if (then) play(then, { once: false });
        }
      : null;
    var started = next.play();
    if (started && started.catch) started.catch(function () {});
  }

  function say(text, durationMs) {
    if (!text) return;
    bubbleText.textContent = text;
    bubble.hidden = false;
    window.clearTimeout(bubbleTimer);
    window.requestAnimationFrame(function () {
      bubble.classList.add("show");
    });
    bubbleTimer = window.setTimeout(hideBubble, durationMs || bubbleDurationMs());
  }

  function bubbleDurationMs() {
    var speech = prefs.speech || {};
    var seconds = typeof speech.bubbleDurationSec === "number" ? speech.bubbleDurationSec : 6;
    return Math.max(2000, Math.round(seconds * 1000));
  }

  function hideBubble() {
    bubble.classList.remove("show");
    window.setTimeout(function () {
      if (!bubble.classList.contains("show")) bubble.hidden = true;
    }, 220);
  }

  var MENU_ITEMS = [
    { id: "settings", label: "桌宠设置" },
    { id: "hide", label: "隐藏桌宠" },
    { sep: true },
    { id: "quit", label: "退出" },
  ];

  function buildMenu() {
    menu.textContent = "";
    MENU_ITEMS.forEach(function (item) {
      if (item.sep) {
        var line = document.createElement("div");
        line.className = "menu-sep";
        menu.appendChild(line);
        return;
      }
      var button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item";
      button.textContent = item.label;
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        runAction(item.id);
      });
      menu.appendChild(button);
    });
  }

  function showMenu() {
    buildMenu();
    menuOpen = true;
    menu.hidden = false;
  }

  function hideMenu() {
    menuOpen = false;
    menu.hidden = true;
  }

  function request(method, payload) {
    if (!invoke) return Promise.resolve(null);
    return invoke("pet_request", { method: method, payload: payload || {} });
  }

  function runAction(id) {
    hideMenu();
    if (id === "settings") {
      if (invoke) {
        invoke("pet_settings_open").catch(function (error) {
          say("设置没打开：" + String((error && error.message) || error), 5000);
        });
      }
      return;
    }
    if (id === "hide") {
      if (invoke) invoke("pet_hide").catch(function () {});
      return;
    }
    if (id === "quit") {
      if (invoke) invoke("pet_quit").catch(function () {});
    }
  }

  hit.addEventListener("contextmenu", function (event) {
    event.preventDefault();
    showMenu();
  });

  document.addEventListener("click", function (event) {
    if (menuOpen && !menu.contains(event.target)) hideMenu();
  });

  function currentWindow() {
    if (!windowApi || !windowApi.getCurrentWindow) return null;
    try {
      return windowApi.getCurrentWindow();
    } catch (error) {
      console.error("getCurrentWindow failed", error);
      return null;
    }
  }

  // 启动时贴到屏幕对应角落。放在前端算，是因为窗口刚创建时 Rust 侧拿到的
  // 尺寸/显示器信息还不稳定，实测会偏到屏幕中间。
  function placeWindow() {
    var win = currentWindow();
    if (!win || !win.setPosition) return;
    var LogicalPosition = windowApi && windowApi.LogicalPosition;
    var width = window.innerWidth;
    var height = window.innerHeight;
    var corner = (prefs.appearance && prefs.appearance.corner) || "bottom-right";
    var marginX = 24;
    var marginY = 56;
    var availWidth = window.screen.availWidth;
    var availHeight = window.screen.availHeight;
    var x = corner.indexOf("right") >= 0 ? availWidth - width - marginX : marginX;
    var y = corner.indexOf("top") >= 0 ? marginY : availHeight - height - marginY;
    if (!(x >= 0 && y >= 0)) return;
    var move = LogicalPosition ? win.setPosition(new LogicalPosition(x, y)) : win.setPosition({ x: x, y: y });
    if (move && move.catch) {
      move.catch(function (error) {
        console.error("placeWindow failed", error);
      });
    }
  }

  function startDrag(event) {
    if (event.button !== 0) return;
    drag = {
      startX: event.screenX,
      startY: event.screenY,
      moved: false,
      native: false,
      manual: false,
      originX: undefined,
      originY: undefined,
      scale: 1,
      lastMoveAt: 0,
    };
    if (event.pointerId !== undefined && hit.setPointerCapture) {
      try {
        hit.setPointerCapture(event.pointerId);
      } catch (ignored) {}
    }
  }

  function moveDrag(event) {
    if (!drag) return;
    var dx = event.screenX - drag.startX;
    var dy = event.screenY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      drag.moved = true;
      beginNativeDrag();
    }
    if (drag && drag.manual) moveManual(event);
  }

  // 首选系统原生拖动：由窗口管理器移动窗口，最顺滑，也不需要每帧 IPC。
  function beginNativeDrag() {
    var win = currentWindow();
    if (!win || !win.startDragging) {
      beginManualDrag();
      return;
    }
    drag.native = true;
    playDragAnimation();
    var pending = win.startDragging();
    if (pending && pending.catch) {
      pending.catch(function (error) {
        console.error("startDragging failed", error);
        if (!drag) return;
        drag.native = false;
        beginManualDrag();
      });
    }
    // 系统拖动期间收不到 pointerup，兜底恢复待机动画。
    window.setTimeout(function () {
      if (drag && drag.native) {
        drag = null;
        play("idle", { once: false });
        scheduleIdleAction();
      }
    }, 5000);
  }

  // 原生拖动不可用时退回手动移动：读取窗口位置后按指针位移 setPosition。
  function beginManualDrag() {
    var win = currentWindow();
    if (!drag || !win) return;
    drag.manual = true;
    playDragAnimation();
    Promise.all([win.outerPosition(), win.scaleFactor()])
      .then(function (values) {
        if (!drag) return;
        drag.originX = values[0].x;
        drag.originY = values[0].y;
        drag.scale = values[1] || 1;
      })
      .catch(function (error) {
        console.error("read window position failed", error);
        drag = null;
      });
  }

  function moveManual(event) {
    if (!drag || drag.originX === undefined) return;
    var now = Date.now();
    if (now - drag.lastMoveAt < 16) return;
    drag.lastMoveAt = now;
    var win = currentWindow();
    if (!win) return;
    var Position = windowApi.PhysicalPosition;
    var dx = event.screenX - drag.startX;
    var dy = event.screenY - drag.startY;
    var next = new Position(drag.originX + dx * drag.scale, drag.originY + dy * drag.scale);
    win.setPosition(next).catch(function (error) {
      console.error("setPosition failed", error);
    });
  }

  // 拖动时是否播「被拎起来」的动画；设置里可关。
  function playDragAnimation() {
    if (prefs.behavior && prefs.behavior.dragAnimation === false) return;
    play("drag", { once: false });
  }

  function endDrag() {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    if (!moved) {
      if (prefs.behavior && prefs.behavior.clickReact === false) {
        play("idle", { once: false });
      } else {
        var picks = ["happy", "shy", "wave"];
        play(picks[Math.floor(Math.random() * picks.length)], { once: true, then: "idle" });
      }
      scheduleIdleAction();
      return;
    }
    play("idle", { once: false });
    scheduleIdleAction();
  }

  hit.addEventListener("pointerdown", startDrag);
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", endDrag);

  function scheduleIdleAction() {
    window.clearTimeout(idleTimer);
    if (prefs.behavior && prefs.behavior.idleActions === false) return;
    var base = ((prefs.behavior && prefs.behavior.idleIntervalMin) || 3) * 60000;
    var delay = base * (0.6 + Math.random() * 0.8);
    idleTimer = window.setTimeout(function () {
      if (currentName === "idle" && !menuOpen && !drag) {
        var pick = Math.random() < 0.5 ? "look" : "walk";
        play(pick, { once: true, then: "idle" });
      }
      scheduleIdleAction();
    }, delay);
  }

  // 碎碎念：闲下来每隔几分钟说一句，纯本地台词，不花 token。
  var CHATTER_LINES = [
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

  var chatterTimer = null;

  function scheduleChatter() {
    window.clearTimeout(chatterTimer);
    if (prefs.speech && prefs.speech.chatter === false) return;
    var base = ((prefs.speech && prefs.speech.chatterIntervalMin) || 6) * 60000;
    var delay = base * (0.7 + Math.random() * 0.6);
    chatterTimer = window.setTimeout(function () {
      if (!menuOpen && !drag && !bubble.classList.contains("show")) {
        var custom = prefs.speech && prefs.speech.chatterLines;
        var lines = custom && custom.length ? custom : CHATTER_LINES;
        say(lines[Math.floor(Math.random() * lines.length)], bubbleDurationMs());
      }
      scheduleChatter();
    }, delay);
  }

  if (listen) {
    listen("pet:say", function (event) {
      var payload = event && event.payload ? event.payload : {};
      say(payload.text, payload.durationMs);
    }).catch(function () {});
    listen("pet:settings", function (event) {
      applyPrefs(event && event.payload ? event.payload : null);
    }).catch(function () {});
    listen("pet:work", function (event) {
      applyWork(event && event.payload ? event.payload : null);
    }).catch(function () {});
    listen("pet:play", function (event) {
      var payload = event && event.payload ? event.payload : {};
      var name = CLIP_ALIASES[payload.animation] || payload.animation;
      if (!CLIPS[name]) return;
      if (name === "idle") play("idle", { once: false });
      else play(name, { once: true, then: "idle" });
    }).catch(function () {});
  }

  function applyWork(payload) {
    if (!workEl) return;
    payload = payload || {};
    if (payload.clear) {
      workEl.hidden = true;
      workEl.dataset.state = "";
      return;
    }
    var label = WORK_LABELS[payload.state];
    if (!label) return;
    workEl.textContent = payload.task ? label + " · " + payload.task : label;
    workEl.dataset.state = payload.state;
    workEl.hidden = false;
    window.clearTimeout(workTimer);
    if (payload.state === "success" || payload.state === "error") {
      workTimer = window.setTimeout(function () {
        workEl.hidden = true;
      }, 4000);
    }
  }

  // 应用偏好：缩放窗口、气泡字号、置顶、四角定位、行为节奏。
  function applyPrefs(settings) {
    if (!settings || typeof settings !== "object") return;
    prefs = settings;
    var appearance = settings.appearance || {};

    if (typeof appearance.bubbleFontSize === "number") {
      app.style.setProperty("--bubble-font", appearance.bubbleFontSize + "px");
    }

    var win = currentWindow();
    if (win) {
      if (win.setAlwaysOnTop && typeof appearance.alwaysOnTop === "boolean") {
        win.setAlwaysOnTop(appearance.alwaysOnTop).catch(function () {});
      }
      if (win.setSize && windowApi && windowApi.LogicalSize && typeof appearance.scale === "number") {
        var factor = Math.min(140, Math.max(80, appearance.scale)) / 100;
        var size = new windowApi.LogicalSize(
          Math.round(DESIGN_WIDTH * factor),
          Math.round(DESIGN_HEIGHT * factor),
        );
        win.setSize(size).catch(function () {});
      }
    }

    placeWindow();
    scheduleIdleAction();
    scheduleChatter();
  }

  window.addEventListener("resize", function () {
    syncStageScale();
    placeWindow();
  });
  buildClips();
  syncStageScale();
  placeWindow();
  play("idle", { once: false });
  scheduleIdleAction();
  scheduleChatter();

  if (invoke) {
    request("pet.prefs.get")
      .then(function (result) {
        if (result && result.settings) applyPrefs(result.settings);
      })
      .catch(function () {});
    invoke("pet_ready").catch(function () {});
  }
})();
