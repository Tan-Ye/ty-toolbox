use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tiny_http::{Header, Method, Request, Response, Server};

const PET_WINDOW_ID: &str = "pet";
const PET_SETTINGS_WINDOW_ID: &str = "pet-settings";
const DEFAULT_HTTP_PORT: u16 = 7340;
const WORK_STATES: [&str; 6] = [
    "thinking",
    "working",
    "result",
    "waiting",
    "success",
    "error",
];
const ANIMATIONS: [&str; 8] = [
    "idle",
    "look",
    "drag",
    "click-happy",
    "click-shy",
    "click-wave",
    "sleep",
    "walk",
];
const CORNERS: [&str; 4] = ["top-left", "top-right", "bottom-left", "bottom-right"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Appearance {
    scale: i64,
    corner: String,
    always_on_top: bool,
    bubble_font_size: i64,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            scale: 100,
            corner: "bottom-right".into(),
            always_on_top: true,
            bubble_font_size: 15,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Behavior {
    idle_actions: bool,
    idle_interval_min: i64,
    click_react: bool,
    drag_animation: bool,
}

impl Default for Behavior {
    fn default() -> Self {
        Self {
            idle_actions: true,
            idle_interval_min: 4,
            click_react: true,
            drag_animation: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Speech {
    bubble_duration_sec: i64,
    chatter: bool,
    chatter_interval_min: i64,
    chatter_lines: Vec<String>,
}

impl Default for Speech {
    fn default() -> Self {
        Self {
            bubble_duration_sec: 6,
            chatter: true,
            chatter_interval_min: 8,
            chatter_lines: vec![
                "今天也想吃点好的。".into(),
                "要不要休息一下？".into(),
                "我一直在这儿。".into(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Prefs {
    appearance: Appearance,
    behavior: Behavior,
    speech: Speech,
    updated_at: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            appearance: Appearance::default(),
            behavior: Behavior::default(),
            speech: Speech::default(),
            updated_at: String::new(),
        }
    }
}

fn normalize(mut prefs: Prefs) -> Prefs {
    prefs.appearance.scale = prefs.appearance.scale.clamp(80, 140);
    if !CORNERS.contains(&prefs.appearance.corner.as_str()) {
        prefs.appearance.corner = "bottom-right".into();
    }
    prefs.appearance.bubble_font_size = prefs.appearance.bubble_font_size.clamp(13, 18);
    prefs.behavior.idle_interval_min = prefs.behavior.idle_interval_min.clamp(1, 10);
    prefs.speech.bubble_duration_sec = prefs.speech.bubble_duration_sec.clamp(3, 15);
    prefs.speech.chatter_interval_min = prefs.speech.chatter_interval_min.clamp(3, 15);
    prefs.speech.chatter_lines = prefs
        .speech
        .chatter_lines
        .iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .take(200)
        .collect();
    prefs
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("PET_DATA_DIR") {
        return PathBuf::from(dir);
    }
    match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("读取应用数据目录失败：{error}");
            std::env::temp_dir().join("ty-toolbox-pet")
        }
    }
}

fn prefs_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("prefs.json")
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn load_prefs(app: &AppHandle) -> Prefs {
    let path = prefs_path(app);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Prefs::default();
        }
        Err(error) => {
            eprintln!("读取偏好失败（{}）：{error}", path.display());
            return Prefs::default();
        }
    };
    match serde_json::from_str::<Prefs>(&text) {
        Ok(prefs) => normalize(prefs),
        Err(error) => {
            eprintln!("偏好文件解析失败（{}）：{error}", path.display());
            backup_broken_prefs(&path);
            Prefs::default()
        }
    }
}

fn backup_broken_prefs(path: &Path) {
    let backup = path.with_file_name(format!("prefs.json.broken-{}", unix_seconds()));
    if let Err(error) = fs::rename(path, &backup) {
        eprintln!("备份损坏的偏好文件失败：{error}");
    }
}

fn save_prefs(app: &AppHandle, incoming: &Value) -> Result<Prefs, String> {
    let mut base = serde_json::to_value(load_prefs(app))
        .map_err(|error| format!("序列化当前偏好失败：{error}"))?;
    merge_json(&mut base, incoming);
    let prefs: Prefs = serde_json::from_value(base).map_err(|error| format!("偏好数据不合法：{error}"))?;
    let mut prefs = normalize(prefs);
    prefs.updated_at = unix_seconds().to_string();

    let path = prefs_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建数据目录失败：{error}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&prefs)
        .map_err(|error| format!("序列化偏好失败：{error}"))?;
    fs::write(&tmp, text).map_err(|error| format!("写入偏好失败：{error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("替换偏好失败：{error}"))?;
    let _ = app.emit_to(PET_WINDOW_ID, "pet:settings", &prefs);
    Ok(prefs)
}

fn merge_json(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                if value.is_null() {
                    continue;
                }
                if let Some(base_value) = base_map.get_mut(key) {
                    merge_json(base_value, value);
                } else {
                    base_map.insert(key.clone(), value.clone());
                }
            }
        }
        (base, overlay) => {
            if !overlay.is_null() {
                *base = overlay.clone();
            }
        }
    }
}

fn settings_from_payload(payload: Option<Value>) -> Value {
    match payload {
        Some(Value::Object(map)) => match map.get("settings") {
            Some(settings) => settings.clone(),
            None => Value::Object(map),
        },
        Some(other) => other,
        None => Value::Null,
    }
}

fn prefs_payload(app: &AppHandle) -> Value {
    json!({
        "settings": load_prefs(app),
        "dataDir": app_data_dir(app).to_string_lossy(),
    })
}

fn status_payload(app: &AppHandle) -> Value {
    let visible = app
        .get_webview_window(PET_WINDOW_ID)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    json!({
        "ok": true,
        "running": true,
        "version": env!("CARGO_PKG_VERSION"),
        "visible": visible,
        "httpPort": http_port(),
        "dataDir": app_data_dir(app).to_string_lossy(),
        "prefsPath": prefs_path(app).to_string_lossy(),
    })
}

fn http_port() -> u16 {
    std::env::var("PET_HTTP_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_HTTP_PORT)
}

fn show_pet(app: &AppHandle) -> Result<(), String> {
    match app.get_webview_window(PET_WINDOW_ID) {
        Some(window) => {
            window.show().map_err(|error| error.to_string())?;
            let _ = window.set_focus();
            Ok(())
        }
        None => create_pet_window(app)
            .map(|_| ())
            .map_err(|error| error.to_string()),
    }
}

fn hide_pet(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_ID) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn webview_data_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("PET_WEBVIEW_DATA_DIR") {
        return PathBuf::from(dir);
    }
    app_data_dir(app).join("webview2")
}

fn create_pet_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_ID) {
        return Ok(window);
    }
    let data_dir = webview_data_dir(app);
    let _ = fs::create_dir_all(&data_dir);
    let window = WebviewWindowBuilder::new(app, PET_WINDOW_ID, WebviewUrl::App("index.html".into()))
        .title("Pet")
        .inner_size(320.0, 440.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .data_directory(data_dir)
        .visible(true)
        .build()?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window(PET_WINDOW_ID) {
                let _ = window.hide();
            }
        }
    });
    Ok(window)
}

fn create_pet_settings_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(PET_SETTINGS_WINDOW_ID) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        PET_SETTINGS_WINDOW_ID,
        WebviewUrl::App("settings.html".into()),
    )
    .title("桌宠设置")
    .inner_size(780.0, 600.0)
    .decorations(true)
    .resizable(true)
    .center()
    .data_directory(webview_data_dir(app))
    .visible(true)
    .build()?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

// 同步命令里直接建窗口会把 Windows 的事件循环卡死，统一转到主线程后再建。
fn open_settings_deferred(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let _ = create_pet_settings_window(&inner);
        });
    });
}

#[tauri::command]
fn pet_request(app: AppHandle, method: String, payload: Option<Value>) -> Result<Value, String> {
    match method.as_str() {
        "pet.prefs.get" => Ok(prefs_payload(&app)),
        "pet.prefs.set" => {
            let settings = settings_from_payload(payload);
            let prefs = save_prefs(&app, &settings)?;
            Ok(json!({ "settings": prefs }))
        }
        "pet.status" => Ok(status_payload(&app)),
        _ => Err(format!("不支持的请求：{method}")),
    }
}

#[tauri::command]
fn pet_prefs_get(app: AppHandle) -> Value {
    prefs_payload(&app)
}

#[tauri::command]
fn pet_prefs_set(app: AppHandle, settings: Value) -> Result<Value, String> {
    let prefs = save_prefs(&app, &settings)?;
    Ok(json!({ "settings": prefs }))
}

#[tauri::command]
fn pet_status(app: AppHandle) -> Value {
    status_payload(&app)
}

#[tauri::command]
fn pet_show(app: AppHandle) -> Result<(), String> {
    show_pet(&app)
}

#[tauri::command]
fn pet_hide(app: AppHandle) -> Result<(), String> {
    hide_pet(&app)
}

#[tauri::command]
fn pet_ready(app: AppHandle) -> Value {
    let _ = app.emit_to(
        PET_WINDOW_ID,
        "pet:say",
        json!({ "text": "我在呢，命令已经开着了。", "durationMs": 4000 }),
    );
    json!({ "ok": true })
}

#[tauri::command]
fn pet_say(app: AppHandle, text: String, duration_ms: Option<u64>) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("台词不能为空".into());
    }
    let _ = app.emit_to(
        PET_WINDOW_ID,
        "pet:say",
        json!({ "text": text, "durationMs": duration_ms.unwrap_or(6000) }),
    );
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn pet_work(app: AppHandle, state: String, task: Option<String>) -> Result<Value, String> {
    if !WORK_STATES.contains(&state.as_str()) {
        return Err(format!("未知工作状态：{state}"));
    }
    let _ = app.emit_to(
        PET_WINDOW_ID,
        "pet:work",
        json!({ "state": state, "task": task }),
    );
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn pet_clear_work(app: AppHandle) -> Value {
    let _ = app.emit_to(PET_WINDOW_ID, "pet:work", json!({ "clear": true }));
    json!({ "ok": true })
}

#[tauri::command]
fn pet_play(app: AppHandle, animation: String) -> Result<Value, String> {
    let animation = animation.trim();
    if !ANIMATIONS.contains(&animation) {
        return Err(format!("未知动画：{animation}"));
    }
    let _ = app.emit_to(
        PET_WINDOW_ID,
        "pet:play",
        json!({ "animation": animation }),
    );
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn pet_settings_open(app: AppHandle) -> Result<(), String> {
    create_pet_settings_window(&app)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn pet_settings_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_SETTINGS_WINDOW_ID) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pet_settings_changed(app: AppHandle, settings: Value) -> Result<Value, String> {
    let _ = app.emit_to(PET_WINDOW_ID, "pet:settings", settings);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn pet_quit(app: AppHandle) -> Value {
    app.exit(0);
    json!({ "ok": true })
}

fn start_http_server(app: AppHandle) {
    let port = http_port();
    thread::spawn(move || {
        let address = format!("127.0.0.1:{port}");
        let server = match Server::http(&address) {
            Ok(server) => server,
            Err(error) => {
                eprintln!("控制接口启动失败（{address}）：{error}");
                return;
            }
        };
        eprintln!("Pet 控制接口：http://{address}");
        for request in server.incoming_requests() {
            handle_http(request, &app);
        }
    });
}

fn handle_http(mut request: Request, app: &AppHandle) {
    let method = request.method().clone();
    let path = request
        .url()
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    let (status, value) = match route_http(app, method, &path, &body) {
        Ok(value) => (200, value),
        Err((status, message)) => (status, json!({ "ok": false, "error": message })),
    };
    respond(request, status, value);
}

fn route_http(
    app: &AppHandle,
    method: Method,
    path: &str,
    body: &str,
) -> Result<Value, (u16, String)> {
    let method_label = format!("{method:?}");
    match (method, path) {
        (Method::Get, "/health") => Ok(json!({ "ok": true })),
        (Method::Get, "/status") => Ok(status_payload(app)),
        (Method::Get, "/prefs") => Ok(prefs_payload(app)),
        (Method::Put, "/prefs") | (Method::Post, "/prefs") => {
            let value: Value = serde_json::from_str(body)
                .map_err(|error| (400, format!("JSON 解析失败：{error}")))?;
            let settings = settings_from_payload(Some(value));
            let prefs = save_prefs(app, &settings).map_err(|error| (400, error))?;
            Ok(json!({
                "settings": prefs,
                "dataDir": app_data_dir(app).to_string_lossy(),
            }))
        }
        (Method::Post, "/say") => {
            let value: Value = serde_json::from_str(body)
                .map_err(|error| (400, format!("JSON 解析失败：{error}")))?;
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                return Err((400, "text 不能为空".into()));
            }
            let duration = value
                .get("durationMs")
                .and_then(Value::as_u64)
                .unwrap_or(6000);
            let _ = app.emit_to(
                PET_WINDOW_ID,
                "pet:say",
                json!({ "text": text, "durationMs": duration }),
            );
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/work") => {
            let value: Value = serde_json::from_str(body)
                .map_err(|error| (400, format!("JSON 解析失败：{error}")))?;
            let state = value
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !WORK_STATES.contains(&state.as_str()) {
                return Err((400, format!("未知工作状态：{state}")));
            }
            let task = match value.get("task") {
                None | Some(Value::Null) => None,
                Some(Value::String(task)) => Some(task.clone()),
                Some(_) => return Err((400, "task 必须是字符串".into())),
            };
            let _ = app.emit_to(
                PET_WINDOW_ID,
                "pet:work",
                json!({ "state": state, "task": task }),
            );
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/work/clear") => {
            let _ = app.emit_to(PET_WINDOW_ID, "pet:work", json!({ "clear": true }));
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/play") => {
            let value: Value = serde_json::from_str(body)
                .map_err(|error| (400, format!("JSON 解析失败：{error}")))?;
            let animation = value
                .get("animation")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !ANIMATIONS.contains(&animation.as_str()) {
                return Err((400, format!("未知动画：{animation}")));
            }
            let _ = app.emit_to(
                PET_WINDOW_ID,
                "pet:play",
                json!({ "animation": animation }),
            );
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/show") => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = show_pet(&handle);
            });
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/hide") => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = hide_pet(&handle);
            });
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/settings") => {
            open_settings_deferred(app);
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/quit") => {
            app.exit(0);
            Ok(json!({ "ok": true }))
        }
        _ => Err((404, format!("未知接口：{method_label} {path}"))),
    }
}

fn respond(request: Request, status: u16, value: Value) {
    let body = value.to_string();
    let header = Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .expect("静态响应头必须合法");
    let response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(response);
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示桌宠").build(app)?;
    let hide = MenuItemBuilder::with_id("hide", "隐藏桌宠").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "桌宠设置").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &hide, &settings, &quit])
        .build()?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Pet")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let _ = show_pet(app);
            }
            "hide" => {
                let _ = hide_pet(app);
            }
            "settings" => open_settings_deferred(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                let _ = show_pet(tray.app_handle());
            }
        })
        .build(app)?;
    let _ = app.manage(tray);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _args, _cwd| {
                let _ = show_pet(app);
            },
        ))
        .setup(|app| {
            create_pet_window(app.handle())?;
            if let Err(error) = create_tray(app.handle()) {
                eprintln!("创建托盘失败：{error}");
            }
            start_http_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pet_request,
            pet_prefs_get,
            pet_prefs_set,
            pet_status,
            pet_show,
            pet_hide,
            pet_ready,
            pet_say,
            pet_work,
            pet_clear_work,
            pet_play,
            pet_settings_open,
            pet_settings_close,
            pet_settings_changed,
            pet_quit
        ])
        .run(tauri::generate_context!())
        .expect("启动 Pet 失败");
}
