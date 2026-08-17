// Audio capture: mic (agent) + WASAPI loopback (client).
// Fiecare stream: 16kHz mono i16 -> VAD taie in utterances -> WAV in memorie
// -> trimis pe WS ca binary frame [role:1B][duration_ms:4B][WAV bytes].

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::io::Cursor;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::ws;
use crate::StartConfig;

const TARGET_SR: u32 = 16_000;
const VAD_FRAME_MS: usize = 30; // webrtc-vad supports 10/20/30
const VAD_FRAME_SAMPLES: usize = TARGET_SR as usize * VAD_FRAME_MS / 1000; // 480
const MAX_UTT_MS: u32 = 8_000; // hard flush after 8s of speech
const MIN_UTT_MS: u32 = 800;   // ignore utterances shorter than this
const SILENCE_TAIL_MS: u32 = 500; // silence ms after speech to close utterance

#[derive(Serialize)]
pub struct DeviceList {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

pub fn list_devices() -> Result<DeviceList> {
    let host = cpal::default_host();
    let inputs: Vec<String> = host
        .input_devices()?
        .filter_map(|d| d.name().ok())
        .collect();
    let outputs: Vec<String> = host
        .output_devices()?
        .filter_map(|d| d.name().ok())
        .collect();
    let default_input = host.default_input_device().and_then(|d| d.name().ok());
    let default_output = host.default_output_device().and_then(|d| d.name().ok());
    Ok(DeviceList {
        inputs,
        outputs,
        default_input,
        default_output,
    })
}

pub struct Session {
    stop_flag: Arc<AtomicBool>,
    ws_tx: mpsc::UnboundedSender<ws::WsMsg>,
    // keep threads alive
    _threads: Vec<thread::JoinHandle<()>>,
}

impl Session {
    pub fn start(app: AppHandle, cfg: StartConfig) -> Result<Self> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let (ws_tx, ws_rx) = mpsc::unbounded_channel::<ws::WsMsg>();

        // WebSocket task on tokio runtime
        let app_clone = app.clone();
        let ws_url = cfg.server_url.clone();
        let stop_clone = stop_flag.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                if let Err(e) = ws::run(app_clone.clone(), &ws_url, ws_rx, stop_clone.clone()).await {
                    let _ = app_clone.emit("ws-error", format!("{e}"));
                }
            });
        });

        let mut threads = Vec::new();

        // Agent = mic
        {
            let ws_tx = ws_tx.clone();
            let stop = stop_flag.clone();
            let app = app.clone();
            let vad_agg = cfg.vad_aggressiveness;
            let max_utt = ((cfg.chunk_seconds * 1000.0) as u32).max(MIN_UTT_MS);
            let mic_dev = cfg.mic_device.clone();
            threads.push(thread::spawn(move || {
                if let Err(e) = capture_stream(
                    app.clone(),
                    Role::Agent,
                    DeviceSelection::Input(mic_dev),
                    ws_tx,
                    stop,
                    vad_agg,
                    max_utt,
                ) {
                    let _ = app.emit("audio-error", format!("mic: {e}"));
                }
            }));
        }

        // Client = loopback (output device opened as input via WASAPI loopback on Windows)
        {
            let ws_tx = ws_tx.clone();
            let stop = stop_flag.clone();
            let app = app.clone();
            let vad_agg = cfg.vad_aggressiveness;
            let max_utt = ((cfg.chunk_seconds * 1000.0) as u32).max(MIN_UTT_MS);
            let out_dev = cfg.loopback_device.clone();
            threads.push(thread::spawn(move || {
                if let Err(e) = capture_stream(
                    app.clone(),
                    Role::Client,
                    DeviceSelection::Loopback(out_dev),
                    ws_tx,
                    stop,
                    vad_agg,
                    max_utt,
                ) {
                    let _ = app.emit("audio-error", format!("loopback: {e}"));
                }
            }));
        }

        Ok(Session {
            stop_flag,
            ws_tx,
            _threads: threads,
        })
    }

    pub fn stop(self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    pub async fn send_manual(&self, role: String, text: String) -> Result<()> {
        self.ws_tx
            .send(ws::WsMsg::ManualText { role, text })
            .map_err(|_| anyhow!("ws channel closed"))
    }

    pub async fn reload_playbook(&self) -> Result<()> {
        self.ws_tx
            .send(ws::WsMsg::ReloadPlaybook)
            .map_err(|_| anyhow!("ws channel closed"))
    }
}

#[derive(Clone, Copy)]
enum Role {
    Agent,
    Client,
}

impl Role {
    fn tag(&self) -> u8 {
        match self {
            Role::Agent => 0,
            Role::Client => 1,
        }
    }
    fn label(&self) -> &'static str {
        match self {
            Role::Agent => "agent",
            Role::Client => "client",
        }
    }
}

enum DeviceSelection {
    Input(Option<String>),
    Loopback(Option<String>),
}

fn capture_stream(
    app: AppHandle,
    role: Role,
    sel: DeviceSelection,
    ws_tx: mpsc::UnboundedSender<ws::WsMsg>,
    stop: Arc<AtomicBool>,
    vad_agg: u8,
    max_utt_ms: u32,
) -> Result<()> {
    let host = cpal::default_host();

    let (device, config) = match sel {
        DeviceSelection::Input(name) => {
            let device = match name {
                Some(n) => host
                    .input_devices()?
                    .find(|d| d.name().map(|dn| dn == n).unwrap_or(false))
                    .ok_or_else(|| anyhow!("input device not found: {}", n))?,
                None => host
                    .default_input_device()
                    .ok_or_else(|| anyhow!("no default input"))?,
            };
            let cfg = device.default_input_config()?;
            (device, cfg)
        }
        DeviceSelection::Loopback(name) => {
            // On Windows/WASAPI, opening an OUTPUT device as INPUT stream triggers loopback.
            let device = match name {
                Some(n) => host
                    .output_devices()?
                    .find(|d| d.name().map(|dn| dn == n).unwrap_or(false))
                    .ok_or_else(|| anyhow!("output device not found: {}", n))?,
                None => host
                    .default_output_device()
                    .ok_or_else(|| anyhow!("no default output"))?,
            };
            // Use the device's default OUTPUT config for loopback capture on Windows.
            let cfg = device.default_output_config()?;
            (device, cfg)
        }
    };

    let src_sr = config.sample_rate().0;
    let src_channels = config.channels() as usize;
    let sample_format = config.sample_format();

    let _ = app.emit(
        "audio-status",
        serde_json::json!({
            "role": role.label(),
            "device": device.name().unwrap_or_else(|_| "?".to_string()),
            "sample_rate": src_sr,
            "channels": src_channels,
            "format": format!("{:?}", sample_format),
        }),
    );

    // Ring buffer of resampled mono i16 samples at 16kHz for VAD
    let buffer: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::with_capacity(TARGET_SR as usize * 30)));
    let stream_err = Arc::new(Mutex::new(None::<String>));

    let err_cb = {
        let stream_err = stream_err.clone();
        move |e| {
            *stream_err.lock().unwrap() = Some(format!("{e}"));
        }
    };

    let build = |device: &cpal::Device, cfg: &cpal::StreamConfig| -> Result<cpal::Stream> {
        let buf = buffer.clone();
        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                cfg,
                move |data: &[f32], _| {
                    let mono = downmix_f32_to_i16(data, src_channels);
                    let resampled = resample_linear_i16(&mono, src_sr, TARGET_SR);
                    let mut b = buf.lock().unwrap();
                    b.extend_from_slice(&resampled);
                },
                err_cb.clone(),
                None,
            )?,
            cpal::SampleFormat::I16 => device.build_input_stream(
                cfg,
                move |data: &[i16], _| {
                    let mono = downmix_i16(data, src_channels);
                    let resampled = resample_linear_i16(&mono, src_sr, TARGET_SR);
                    let mut b = buf.lock().unwrap();
                    b.extend_from_slice(&resampled);
                },
                err_cb.clone(),
                None,
            )?,
            cpal::SampleFormat::U16 => device.build_input_stream(
                cfg,
                move |data: &[u16], _| {
                    let mono: Vec<i16> = downmix_i16(
                        &data.iter().map(|&v| (v as i32 - 32768) as i16).collect::<Vec<_>>(),
                        src_channels,
                    );
                    let resampled = resample_linear_i16(&mono, src_sr, TARGET_SR);
                    let mut b = buf.lock().unwrap();
                    b.extend_from_slice(&resampled);
                },
                err_cb.clone(),
                None,
            )?,
            _ => return Err(anyhow!("unsupported sample format")),
        };
        Ok(stream)
    };

    let stream_cfg = config.config();
    let stream = build(&device, &stream_cfg)?;
    stream.play()?;

    // VAD chunker
    let mut vad = webrtc_vad::Vad::new_with_mode(match vad_agg {
        0 => webrtc_vad::VadMode::Quality,
        1 => webrtc_vad::VadMode::LowBitrate,
        2 => webrtc_vad::VadMode::Aggressive,
        _ => webrtc_vad::VadMode::VeryAggressive,
    });

    let mut utt_samples: Vec<i16> = Vec::with_capacity(TARGET_SR as usize * 10);
    let mut in_speech = false;
    let mut silence_ms: u32 = 0;
    let mut utt_start: Option<Instant> = None;

    while !stop.load(Ordering::SeqCst) {
        if let Some(err) = stream_err.lock().unwrap().take() {
            return Err(anyhow!("audio stream error: {err}"));
        }

        // Drain enough for at least one VAD frame
        let mut frame: Vec<i16> = Vec::with_capacity(VAD_FRAME_SAMPLES);
        {
            let mut b = buffer.lock().unwrap();
            while b.len() >= VAD_FRAME_SAMPLES && frame.len() < VAD_FRAME_SAMPLES {
                frame.push(b.remove(0));
            }
        }
        if frame.len() < VAD_FRAME_SAMPLES {
            thread::sleep(Duration::from_millis(15));
            continue;
        }

        let is_voice = vad
            .is_voice_segment(&frame)
            .unwrap_or(false);

        if is_voice {
            if !in_speech {
                in_speech = true;
                utt_start = Some(Instant::now());
            }
            silence_ms = 0;
            utt_samples.extend_from_slice(&frame);
        } else if in_speech {
            silence_ms += VAD_FRAME_MS as u32;
            utt_samples.extend_from_slice(&frame);
        }

        let utt_ms = if let Some(s) = utt_start { s.elapsed().as_millis() as u32 } else { 0 };

        let should_flush = in_speech
            && (silence_ms >= SILENCE_TAIL_MS || utt_ms >= max_utt_ms);

        if should_flush {
            if utt_ms >= MIN_UTT_MS {
                let wav = encode_wav_i16_mono_16k(&utt_samples);
                let _ = ws_tx.send(ws::WsMsg::Audio {
                    role_tag: role.tag(),
                    duration_ms: utt_ms,
                    wav,
                });
                let _ = app.emit(
                    "audio-flush",
                    serde_json::json!({
                        "role": role.label(),
                        "duration_ms": utt_ms,
                        "samples": utt_samples.len(),
                    }),
                );
            }
            utt_samples.clear();
            in_speech = false;
            silence_ms = 0;
            utt_start = None;
        }
    }

    drop(stream);
    Ok(())
}

// --- helpers ---

fn downmix_f32_to_i16(data: &[f32], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return data.iter().map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect();
    }
    let frames = data.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += data[i * channels + c];
        }
        let avg = sum / channels as f32;
        out.push((avg.clamp(-1.0, 1.0) * 32767.0) as i16);
    }
    out
}

fn downmix_i16(data: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return data.to_vec();
    }
    let frames = data.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut sum = 0i32;
        for c in 0..channels {
            sum += data[i * channels + c] as i32;
        }
        out.push((sum / channels as i32) as i16);
    }
    out
}

fn resample_linear_i16(input: &[i16], from_sr: u32, to_sr: u32) -> Vec<i16> {
    if from_sr == to_sr || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to_sr as f64 / from_sr as f64;
    let out_len = ((input.len() as f64) * ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;
        let a = input.get(idx).copied().unwrap_or(0) as f64;
        let b = input.get(idx + 1).copied().unwrap_or(a as i16) as f64;
        let v = a + (b - a) * frac;
        out.push(v as i16);
    }
    out
}

fn encode_wav_i16_mono_16k(samples: &[i16]) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SR,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
        for s in samples {
            writer.write_sample(*s).unwrap();
        }
        writer.finalize().unwrap();
    }
    cursor.into_inner()
}
