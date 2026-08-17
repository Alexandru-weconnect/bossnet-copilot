mod audio;
mod ws;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
pub struct StartConfig {
    pub server_url: String, // wss://teambossnet.ro:3003/?t=<token>
    pub mic_device: Option<String>,     // None = default
    pub loopback_device: Option<String>, // None = default output for WASAPI loopback
    pub chunk_seconds: f32,             // typical 4.0
    pub vad_aggressiveness: u8,         // 0-3
}

pub struct AppState {
    pub session: Mutex<Option<audio::Session>>,
}

#[tauri::command]
async fn list_devices() -> Result<audio::DeviceList, String> {
    audio::list_devices().map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_call(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    config: StartConfig,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    if guard.is_some() {
        return Err("session already running".into());
    }
    let session = audio::Session::start(app.clone(), config).map_err(|e| e.to_string())?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
async fn stop_call(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    if let Some(s) = guard.take() {
        s.stop();
    }
    Ok(())
}

#[tauri::command]
async fn show_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        w.show().map_err(|e| e.to_string())?;
        w.set_always_on_top(true).ok();
    }
    Ok(())
}

#[tauri::command]
async fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn send_manual(
    state: tauri::State<'_, Arc<AppState>>,
    role: String,
    text: String,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    if let Some(s) = guard.as_ref() {
        s.send_manual(role, text).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn reload_playbook(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let guard = state.session.lock().await;
    if let Some(s) = guard.as_ref() {
        s.reload_playbook().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let state = Arc::new(AppState {
        session: Mutex::new(None),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .setup(|app| {
            // Overlay window starts hidden. Show it after user clicks "Start call".
            if let Some(overlay) = app.get_webview_window("overlay") {
                overlay.set_always_on_top(true).ok();
                // On Windows this makes the window invisible to screen sharing (WDA_MONITOR)
                let _ = overlay.set_content_protected(true);
            }
            let _ = app.emit("app-ready", ());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            start_call,
            stop_call,
            show_overlay,
            hide_overlay,
            send_manual,
            reload_playbook,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
