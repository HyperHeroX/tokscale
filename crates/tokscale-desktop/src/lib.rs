//! Tokscale desktop widget backend.
//!
//! Window operations route through Rust commands via `core.invoke` (the only
//! Tauri JS path that works reliably here). Always-on-top uses a direct Win32
//! `SetWindowPos` on Windows — Tauri's `set_always_on_top` reports ok but does
//! not actually keep a transparent frameless window on top.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokscale_core::{
    generate_local_graph_report, get_hourly_report, get_model_report, get_monthly_report,
    scanner::ScannerSettings, GraphResult, GroupBy, HourlyReport, ModelReport, MonthlyReport,
    ReportOptions,
};
use tokscale_usage::UsageOutput;

const DEFAULT_GROUP_BY: &str = "client,model";

// ── Persisted window state ────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
struct DesktopState {
    #[serde(default = "default_pinned")]
    pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<f64>,
}

fn default_pinned() -> bool {
    true
}

// `derive(Default)` would set pinned = false (bool default). Pin must default
// to true, so implement Default by hand.
impl Default for DesktopState {
    fn default() -> Self {
        Self { pinned: true, x: None, y: None, width: None, height: None }
    }
}

fn state_path() -> PathBuf {
    tokscale_core::paths::get_config_dir().join("desktop.json")
}

fn load_state() -> DesktopState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(state: &DesktopState) {
    let path = state_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, json);
    }
}

// ── Always-on-top (Win32 direct on Windows) ───────────────────────────────

#[cfg(target_os = "windows")]
fn force_topmost(window: &tauri::WebviewWindow, top: bool) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GA_ROOT, SetWindowPos, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd = hwnd.0 as *mut core::ffi::c_void;
    // Resolve the real top-level window: Tauri may hand back a child webview
    // hwnd, and SetWindowPos on a child does not change the owner's z-order.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let target = if root.is_null() { hwnd } else { root };
    let after = if top { HWND_TOPMOST } else { HWND_NOTOPMOST };
    let r = unsafe {
        SetWindowPos(target, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    };
    if r == 0 {
        Err("SetWindowPos returned 0".into())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn force_topmost(window: &tauri::WebviewWindow, top: bool) -> Result<(), String> {
    window.set_always_on_top(top).map_err(|e| e.to_string())
}

// ── Report option helpers ─────────────────────────────────────────────────

fn base_options(group_by: GroupBy, since: Option<String>, until: Option<String>) -> ReportOptions {
    ReportOptions {
        home_dir: None,
        use_env_roots: true,
        clients: None,
        since,
        until,
        year: None,
        group_by,
        scanner_settings: ScannerSettings::default(),
    }
}

// ── Data commands ─────────────────────────────────────────────────────────

#[tauri::command]
async fn get_subscription_usage() -> Result<Vec<UsageOutput>, String> {
    eprintln!("[desktop] get_subscription_usage invoked");
    // CliReadOnly avoids the TuiSurface codex auth-import path, which deadlocks
    // inside the widget. A hard 15s timeout + cache fallback guarantees the
    // frontend never hangs on "Loading…".
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::task::spawn_blocking(|| {
            tokscale_usage::fetch_all_report_with_intent(
                tokscale_usage::UsageFetchIntent::CliReadOnly,
            )
        }),
    )
    .await;
    match result {
        Ok(Ok(report)) => {
            for d in &report.diagnostics {
                eprintln!("[desktop] usage diag {} {:?}: {}", d.provider, d.severity, d.message);
            }
            eprintln!("[desktop] usage done, {} outputs", report.outputs.len());
            Ok(report.outputs)
        }
        Ok(Err(e)) => Err(format!("usage worker join failed: {e}")),
        Err(_) => {
            eprintln!("[desktop] usage fetch timed out (>15s), using cache/empty");
            Ok(tokscale_usage::load_cache().unwrap_or_default())
        }
    }
}

#[tauri::command]
async fn get_models_report(
    group_by: Option<String>,
    since: Option<String>,
    until: Option<String>,
) -> Result<ModelReport, String> {
    eprintln!("[desktop] get_models_report invoked");
    let group_by = group_by
        .unwrap_or_else(|| DEFAULT_GROUP_BY.to_string())
        .parse::<GroupBy>()
        .unwrap_or(GroupBy::ClientModel);
    match tokio::time::timeout(
        std::time::Duration::from_secs(20),
        get_model_report(base_options(group_by, since, until)),
    )
    .await
    {
        Ok(r) => {
            eprintln!("[desktop] get_models_report done");
            r
        }
        Err(_) => {
            eprintln!("[desktop] get_models_report timed out (>20s)");
            Err("models report timed out".into())
        }
    }
}

#[tauri::command]
async fn get_today_trend() -> Result<GraphResult, String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    generate_local_graph_report(base_options(GroupBy::Model, Some(today.clone()), Some(today))).await
}

#[tauri::command]
async fn get_overview_graph() -> Result<GraphResult, String> {
    generate_local_graph_report(base_options(GroupBy::Model, None, None)).await
}

#[tauri::command]
async fn get_monthly_view() -> Result<MonthlyReport, String> {
    get_monthly_report(base_options(GroupBy::Model, None, None)).await
}

#[tauri::command]
async fn get_hourly_view() -> Result<HourlyReport, String> {
    get_hourly_report(base_options(GroupBy::Model, None, None)).await
}

// ── Window control commands ───────────────────────────────────────────────

#[tauri::command]
fn start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_pinned(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Mutex<DesktopState>>,
    pinned: bool,
) -> Result<bool, String> {
    let r = force_topmost(&window, pinned);
    eprintln!("[desktop] set_pinned({}) = {:?}", pinned, r.as_ref().map(|_| "ok").map_err(|e| e.to_string()));
    r?;
    if let Ok(mut s) = state.lock() {
        s.pinned = pinned;
        save_state(&s);
    }
    Ok(pinned)
}

#[tauri::command]
fn fit_window_height(window: tauri::WebviewWindow, height: u32) -> Result<(), String> {
    let current = window.outer_size().map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(current.width, height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ── Right-click menu: full surfaces ───────────────────────────────────────

#[tauri::command]
fn open_external(kind: String) -> Result<(), String> {
    match kind.as_str() {
        "web" => open_frontend(),
        "tui" => open_terminal(&[]).map_err(|e| e.to_string()),
        other => Err(format!("unknown external kind: {other}")),
    }
}

#[tauri::command]
fn run_cli(command: String) -> Result<(), String> {
    let args: Vec<&str> = command.split_whitespace().collect();
    if args.is_empty() {
        return Err("empty command".into());
    }
    open_terminal(&args).map_err(|e| e.to_string())
}

/// Resolve the tokscale CLI binary: prefer the one sitting next to this widget
/// exe (target/debug in dev), falling back to `tokscale` on PATH.
fn tokscale_bin() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["tokscale.exe", "tokscale"] {
                let p = dir.join(name);
                if p.exists() {
                    return p.to_string_lossy().into_owned();
                }
            }
        }
    }
    "tokscale".to_string()
}

/// Launch the standalone dashboard Tauri app (`tokscale-frontend`) that ships
/// next to this widget exe. The frontend app is a full local dashboard, opened
/// in its own window.
fn open_frontend() -> Result<(), String> {
    let bin = frontend_bin();
    let mut cmd = std::process::Command::new(&bin);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    match cmd.spawn() {
        Ok(_) => eprintln!("[desktop] launched frontend app: {bin}"),
        Err(e) => eprintln!("[desktop] frontend app launch failed ({bin}): {e}"),
    }
    Ok(())
}

/// Resolve the standalone frontend app binary next to this widget exe
/// (target/debug in dev), falling back to PATH.
fn frontend_bin() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["tokscale-frontend.exe", "tokscale-frontend"] {
                let p = dir.join(name);
                if p.exists() {
                    return p.to_string_lossy().into_owned();
                }
            }
        }
    }
    "tokscale-frontend".to_string()
}

#[cfg(target_os = "windows")]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn()?;
    Ok(())
}
#[cfg(all(unix, not(target_os = "macos")))]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(url).spawn()?;
    Ok(())
}
#[cfg(target_os = "macos")]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("open").arg(url).spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_terminal(args: &[&str]) -> std::io::Result<()> {
    let bin = tokscale_bin();
    let line = if args.is_empty() {
        bin
    } else {
        format!("{bin} {}", args.join(" "))
    };
    std::process::Command::new("cmd")
        .args(["/C", "start", "cmd", "/K", &line])
        .spawn()?;
    Ok(())
}
#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(args: &[&str]) -> std::io::Result<()> {
    let bin = tokscale_bin();
    let mut cmd = std::process::Command::new("x-terminal-emulator");
    cmd.arg("-e").arg(&bin);
    for a in args {
        cmd.arg(a);
    }
    cmd.spawn()?;
    Ok(())
}
#[cfg(target_os = "macos")]
fn open_terminal(args: &[&str]) -> std::io::Result<()> {
    let bin = tokscale_bin();
    let script = if args.is_empty() {
        bin
    } else {
        format!("{bin} {}", args.join(" "))
    };
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(format!("tell app \"Terminal\" to do script \"{script}\""))
        .spawn()?;
    Ok(())
}

// ── App entry ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = load_state();
    let pinned0 = initial.pinned;
    let pos0 = (initial.x, initial.y);
    let size0 = (initial.width, initial.height);

    tauri::Builder::default()
        .manage(Mutex::new(initial))
        .setup(move |app| {
            if let Some(win) = app.get_webview_window("main") {
                let r = force_topmost(&win, pinned0);
                eprintln!("[desktop] setup topmost({}) ok={}", pinned0, r.is_ok());
                if let (Some(x), Some(y)) = pos0 {
                    let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                }
                if let (Some(w), Some(h)) = size0 {
                    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                let state = window.app_handle().state::<Mutex<DesktopState>>();
                let locked = state.lock();
                if let Ok(mut s) = locked {
                    if let Ok(pos) = window.outer_position() {
                        s.x = Some(pos.x as f64);
                        s.y = Some(pos.y as f64);
                    }
                    if let Ok(size) = window.outer_size() {
                        s.width = Some(size.width as f64);
                        s.height = Some(size.height as f64);
                    }
                    save_state(&s);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_subscription_usage,
            get_models_report,
            get_today_trend,
            get_overview_graph,
            get_monthly_view,
            get_hourly_view,
            start_drag,
            set_pinned,
            fit_window_height,
            quit_app,
            open_external,
            run_cli,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tokscale desktop");
}
