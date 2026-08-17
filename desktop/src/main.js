import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const $ = (id) => document.getElementById(id);
const log = (msg, kind = "") => {
  const el = document.createElement("div");
  el.className = "line" + (kind ? ` line--${kind}` : "");
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  const box = $("log");
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
};

// Load persisted config
const cfg = JSON.parse(localStorage.getItem("copilot.cfg") || "{}");
if (cfg.serverUrl) $("server-url").value = cfg.serverUrl;
if (cfg.chunkSeconds) $("chunk-seconds").value = cfg.chunkSeconds;
if (cfg.vad !== undefined) $("vad").value = cfg.vad;

function persist() {
  localStorage.setItem("copilot.cfg", JSON.stringify({
    serverUrl: $("server-url").value,
    micDevice: $("mic-device").value,
    loopbackDevice: $("loopback-device").value,
    chunkSeconds: $("chunk-seconds").value,
    vad: $("vad").value,
  }));
}

async function loadDevices() {
  try {
    const d = await invoke("list_devices");
    const micSel = $("mic-device");
    const loopSel = $("loopback-device");
    micSel.innerHTML = `<option value="">(implicit: ${d.default_input ?? "?"})</option>`;
    for (const name of d.inputs) {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      micSel.appendChild(opt);
    }
    loopSel.innerHTML = `<option value="">(implicit: ${d.default_output ?? "?"})</option>`;
    for (const name of d.outputs) {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      loopSel.appendChild(opt);
    }
    if (cfg.micDevice) micSel.value = cfg.micDevice;
    if (cfg.loopbackDevice) loopSel.value = cfg.loopbackDevice;
    log(`${d.inputs.length} input, ${d.outputs.length} output devices`);
  } catch (e) {
    log("device error: " + e, "err");
  }
}

function fmtTs(ts) {
  const s = Math.floor(ts);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
}

function appendTurn(role, text, ts) {
  const box = $("transcript");
  const empty = box.querySelector(".empty");
  if (empty) empty.remove();
  const turn = document.createElement("div");
  turn.className = `turn turn--${role}`;
  turn.innerHTML = `
    <div>
      <span class="turn__role">${role}</span>
      <span class="turn__ts">+${fmtTs(ts)}</span>
    </div>
    <div class="turn__text"></div>`;
  turn.querySelector(".turn__text").textContent = text;
  box.appendChild(turn);
  box.scrollTop = box.scrollHeight;
}

$("btn-start").addEventListener("click", async () => {
  persist();
  try {
    await invoke("start_call", {
      config: {
        server_url: $("server-url").value.trim(),
        mic_device: $("mic-device").value || null,
        loopback_device: $("loopback-device").value || null,
        chunk_seconds: parseFloat($("chunk-seconds").value) || 6.0,
        vad_aggressiveness: parseInt($("vad").value, 10) || 2,
      },
    });
    await invoke("show_overlay");
    $("btn-start").disabled = true;
    $("btn-stop").disabled = false;
    log("call started", "ok");
  } catch (e) {
    log("start failed: " + e, "err");
  }
});

$("btn-stop").addEventListener("click", async () => {
  try {
    await invoke("stop_call");
    await invoke("hide_overlay");
    $("btn-start").disabled = false;
    $("btn-stop").disabled = true;
    log("call stopped", "ok");
  } catch (e) {
    log("stop failed: " + e, "err");
  }
});

$("btn-overlay").addEventListener("click", async () => {
  await invoke("show_overlay");
});

$("btn-reload").addEventListener("click", async () => {
  try {
    await invoke("reload_playbook");
    log("playbook reload sent", "ok");
  } catch (e) {
    log("reload failed: " + e, "err");
  }
});

$("btn-manual").addEventListener("click", async () => {
  const role = $("manual-role").value;
  const text = $("manual-text").value.trim();
  if (!text) return;
  try {
    await invoke("send_manual", { role, text });
    $("manual-text").value = "";
    appendTurn(role, text, 0);
  } catch (e) {
    log("manual failed: " + e, "err");
  }
});

// --- listen to Rust events ---

listen("ws-status", (e) => {
  const st = $("conn-status");
  const isOn = e.payload === "connected";
  st.className = "status " + (isOn ? "status--on" : "status--off");
  st.textContent = e.payload;
  log("ws " + e.payload, isOn ? "ok" : "err");
});

listen("ws-error", (e) => log("ws-error: " + e.payload, "err"));
listen("audio-error", (e) => log("audio-error: " + e.payload, "err"));

listen("audio-status", (e) => {
  const p = e.payload;
  log(`audio ${p.role}: ${p.device} @ ${p.sample_rate}Hz ${p.channels}ch ${p.format}`, "ok");
});

listen("audio-flush", (e) => {
  const p = e.payload;
  log(`flush ${p.role} ${p.duration_ms}ms (${p.samples} samples)`);
});

listen("ws-message", (e) => {
  let msg;
  try { msg = JSON.parse(e.payload); } catch { return; }
  if (msg.type === "transcript") {
    appendTurn(msg.role, msg.text, msg.ts);
  } else if (msg.type === "ready") {
    log(`ready: session ${msg.sessionId}, playbook ${msg.playbookBytes}B`, "ok");
  } else if (msg.type === "playbook-reloaded") {
    log(`playbook reloaded (${msg.bytes}B)`, "ok");
  } else if (msg.type === "suggestion") {
    log(`SUGGEST [${msg.priority}] ${msg.text}`, "ok");
  } else if (msg.type === "decision" && msg.action === "silent") {
    // silent — noop
  } else if (msg.type === "error") {
    log(`backend error [${msg.kind}]: ${msg.message}`, "err");
  }
});

loadDevices();
