import { listen } from "@tauri-apps/api/event";

const $ = (id) => document.getElementById(id);
let hideTimer = null;

function render(s) {
  $("tip").textContent = s.tip || "INFO";
  $("text").textContent = s.text || "";
  $("prio").textContent = s.priority || "medium";
  $("prio").className = "prio prio--" + (s.priority || "medium");
  $("reason").textContent = s.reason || "";
  const card = $("card");
  card.classList.remove("silent");
  clearTimeout(hideTimer);
  // fade to "silent" style after 12s so it stops distracting
  hideTimer = setTimeout(() => card.classList.add("silent"), 12_000);
}

listen("suggestion", (e) => render(e.payload));
