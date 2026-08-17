// WebSocket client to bossnet-copilot backend.
// Sends audio (binary) + control (JSON). Receives suggestions and forwards
// them to the frontend via Tauri events.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub enum WsMsg {
    Audio { role_tag: u8, duration_ms: u32, wav: Vec<u8> },
    ManualText { role: String, text: String },
    ReloadPlaybook,
    ClearTranscript,
    Ping,
}

pub async fn run(
    app: AppHandle,
    url: &str,
    mut rx: mpsc::UnboundedReceiver<WsMsg>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let (ws, _resp) = connect_async(url).await.map_err(|e| anyhow!("ws connect: {e}"))?;
    let (mut sink, mut stream) = ws.split();

    let _ = app.emit("ws-status", "connected");

    // Reader task
    let app_reader = app.clone();
    let stop_reader = stop.clone();
    let read_task = tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            if stop_reader.load(Ordering::SeqCst) {
                break;
            }
            match msg {
                Ok(Message::Text(t)) => {
                    // Forward all backend messages to frontend
                    let _ = app_reader.emit("ws-message", t.to_string());

                    // If it's a suggestion, also push to overlay window
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                        if v.get("type").and_then(|x| x.as_str()) == Some("suggestion") {
                            if let Some(overlay) = app_reader.get_webview_window("overlay") {
                                let _ = overlay.show();
                                let _ = overlay.set_always_on_top(true);
                                let _ = app_reader.emit_to("overlay", "suggestion", v.clone());
                            }
                        }
                    }
                }
                Ok(Message::Ping(p)) => {
                    let _ = app_reader.emit("ws-ping", ());
                    let _ = p; // pong handled by tungstenite auto
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        let _ = app_reader.emit("ws-status", "disconnected");
    });

    // Writer loop
    while !stop.load(Ordering::SeqCst) {
        match tokio::time::timeout(std::time::Duration::from_secs(20), rx.recv()).await {
            Ok(Some(msg)) => {
                let frame = match msg {
                    WsMsg::Audio { role_tag, duration_ms, wav } => {
                        let mut buf = Vec::with_capacity(5 + wav.len());
                        buf.push(role_tag);
                        buf.extend_from_slice(&duration_ms.to_be_bytes());
                        buf.extend_from_slice(&wav);
                        Message::Binary(buf.into())
                    }
                    WsMsg::ManualText { role, text } => Message::Text(
                        json!({ "type": "manual-text", "role": role, "text": text }).to_string().into(),
                    ),
                    WsMsg::ReloadPlaybook => {
                        Message::Text(json!({ "type": "reload-playbook" }).to_string().into())
                    }
                    WsMsg::ClearTranscript => {
                        Message::Text(json!({ "type": "clear-transcript" }).to_string().into())
                    }
                    WsMsg::Ping => Message::Text(json!({ "type": "ping" }).to_string().into()),
                };
                if let Err(e) = sink.send(frame).await {
                    let _ = app.emit("ws-error", format!("send: {e}"));
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => {
                // idle timeout: send ping
                let _ = sink.send(Message::Text(json!({ "type": "ping" }).to_string().into())).await;
            }
        }
    }

    let _ = sink.close().await;
    let _ = read_task.await;
    Ok(())
}
