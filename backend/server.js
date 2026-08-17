// Bossnet Copilot Backend
// WebSocket server care primeste chunk-uri audio de la desktop app (2 canale:
// agent/client), le trimite la whisper-api local pentru transcriere,
// acumuleaza transcriptul rulant si spawn-eaza Claude CLI la fiecare
// utterance nou pentru a decide daca sugereaza ceva sau tace.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const FormData = require('form-data');
const fetch = require('node-fetch');

const PORT = Number(process.env.COPILOT_PORT || 3003);
const JWT_SECRET = process.env.COPILOT_JWT_SECRET || 'change-me';
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:5123/api/transcribe';
const CLAUDE_CLI = process.env.CLAUDE_CLI || '/home/teambossnet/.local/bin/claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || 'low';
const PLAYBOOK_PATH = process.env.PLAYBOOK_PATH || path.join(__dirname, '..', 'playbook.md');
const SYSTEM_PROMPT_PATH = process.env.SYSTEM_PROMPT_PATH || path.join(__dirname, 'system-prompt.md');
const SSL_CERT = process.env.SSL_CERT || '';
const SSL_KEY = process.env.SSL_KEY || '';

// --- HTTP(S) + WS server -------------------------------------------------

function buildServer(handler) {
  if (SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
    try {
      const srv = https.createServer({
        cert: fs.readFileSync(SSL_CERT),
        key: fs.readFileSync(SSL_KEY),
      }, handler);
      console.log('[copilot] HTTPS mode');
      return srv;
    } catch (e) {
      console.error('[copilot] HTTPS init failed, falling back to HTTP:', e.message);
    }
  }
  console.log('[copilot] HTTP mode (no SSL cert configured)');
  return http.createServer(handler);
}

const server = buildServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: PORT, sessions: sessions.size }));
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Simple token check via query string ?t=<token>
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('t') || '';
    const expected = crypto.createHmac('sha256', JWT_SECRET).update('copilot-client').digest('hex').slice(0, 32);
    if (token !== expected) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  } catch (e) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// --- Session state --------------------------------------------------------

const sessions = new Map(); // sessionId -> Session

class Session {
  constructor(id, ws) {
    this.id = id;
    this.ws = ws;
    this.startedAt = Date.now();
    this.transcript = []; // [{role: 'agent'|'client', ts, text}]
    this.recentSuggestions = []; // {ts, text}
    this.pendingClaude = false;
    this.pendingRerun = false;
    this.playbook = null;
    this.systemPrompt = null;
    this.lastActivityAt = Date.now();
  }
}

function loadContexts(session) {
  try { session.playbook = fs.readFileSync(PLAYBOOK_PATH, 'utf8'); }
  catch (e) { session.playbook = '(playbook indisponibil: ' + e.message + ')'; }
  try { session.systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8'); }
  catch (e) { session.systemPrompt = 'Esti asistent silentios de vanzari.'; }
}

// --- WS handlers ----------------------------------------------------------

wss.on('connection', (ws) => {
  const id = crypto.randomBytes(6).toString('hex');
  const session = new Session(id, ws);
  loadContexts(session);
  sessions.set(id, session);
  console.log('[copilot] session start', id);

  ws.send(JSON.stringify({ type: 'ready', sessionId: id, playbookBytes: session.playbook.length }));

  ws.on('message', async (raw, isBinary) => {
    session.lastActivityAt = Date.now();

    if (isBinary) {
      // Binary frame = audio chunk. Header: 1 byte role (0=agent,1=client) + 4 bytes uint32 duration_ms + payload (WebM/Opus or WAV).
      try {
        const buf = Buffer.from(raw);
        const role = buf.readUInt8(0) === 0 ? 'agent' : 'client';
        const durationMs = buf.readUInt32BE(1);
        const audio = buf.slice(5);
        await handleAudioChunk(session, role, durationMs, audio);
      } catch (e) {
        console.error('[copilot] binary parse error', e.message);
      }
      return;
    }

    // JSON control message
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
      case 'reload-playbook':
        loadContexts(session);
        ws.send(JSON.stringify({ type: 'playbook-reloaded', bytes: session.playbook.length }));
        break;
      case 'clear-transcript':
        session.transcript = [];
        session.recentSuggestions = [];
        ws.send(JSON.stringify({ type: 'cleared' }));
        break;
      case 'manual-text':
        // Fallback: agentul poate insera text manual (fara STT)
        if (msg.role && msg.text) {
          appendUtterance(session, msg.role, msg.text);
          triggerClaude(session);
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log('[copilot] session end', id);
    sessions.delete(id);
  });

  ws.on('error', (e) => console.error('[copilot] ws error', id, e.message));
});

// --- Audio -> Whisper -> Transcript --------------------------------------

async function handleAudioChunk(session, role, durationMs, audio) {
  // Skip if too short (probably silence chunk)
  if (audio.length < 2000) return;

  const t0 = Date.now();
  try {
    const text = await transcribeWithWhisper(audio, role);
    const took = Date.now() - t0;

    if (!text || text.trim().length < 2) {
      console.log(`[copilot] ${session.id} ${role} empty (${took}ms)`);
      return;
    }

    appendUtterance(session, role, text.trim());

    session.ws.send(JSON.stringify({
      type: 'transcript',
      role,
      text: text.trim(),
      ts: Date.now() - session.startedAt,
      whisperMs: took,
    }));

    triggerClaude(session);
  } catch (e) {
    console.error('[copilot] whisper error', e.message);
    session.ws.send(JSON.stringify({ type: 'error', kind: 'whisper', message: e.message }));
  }
}

async function transcribeWithWhisper(audioBuf, role) {
  const form = new FormData();
  form.append('file', audioBuf, {
    filename: `chunk-${Date.now()}-${role}.webm`,
    contentType: 'audio/webm',
  });
  form.append('folder', 'copilot-live');
  form.append('language', 'ro');
  form.append('model', 'large-v3-turbo');

  const res = await fetch(WHISPER_URL, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    timeout: 30000,
  });
  if (!res.ok) throw new Error('whisper HTTP ' + res.status);
  const data = await res.json();
  return data.text || data.transcript || '';
}

function appendUtterance(session, role, text) {
  const last = session.transcript[session.transcript.length - 1];
  const ts = Date.now() - session.startedAt;
  // If same role in <2s, merge (continuation of same utterance)
  if (last && last.role === role && ts - last.ts < 2000) {
    last.text += ' ' + text;
    last.ts = ts;
    return;
  }
  session.transcript.push({ role, ts, text });
  if (session.transcript.length > 200) session.transcript.shift();
}

// --- Claude CLI decision loop --------------------------------------------

function triggerClaude(session) {
  if (session.pendingClaude) { session.pendingRerun = true; return; }
  session.pendingClaude = true;
  session.pendingRerun = false;

  runClaudeOnce(session)
    .catch(e => console.error('[copilot] claude error', e.message))
    .finally(() => {
      session.pendingClaude = false;
      if (session.pendingRerun) {
        setTimeout(() => triggerClaude(session), 500);
      }
    });
}

async function runClaudeOnce(session) {
  const now = Date.now();
  const elapsedS = Math.floor((now - session.startedAt) / 1000);

  const transcriptLines = session.transcript.slice(-30)
    .map(u => `[${u.role.toUpperCase()} +${Math.floor(u.ts/1000)}s] ${u.text}`)
    .join('\n');

  const recentSugg = session.recentSuggestions.slice(-5)
    .map(s => `- (+${Math.floor((s.ts-session.startedAt)/1000)}s) ${s.text}`)
    .join('\n') || '(niciuna)';

  const lastRole = session.transcript.length ? session.transcript[session.transcript.length-1].role : 'none';

  const userPrompt = [
    '[PLAYBOOK]',
    session.playbook,
    '[/PLAYBOOK]',
    '',
    '[TRANSCRIPT APEL, ultimele replici]',
    transcriptLines || '(gol)',
    '[/TRANSCRIPT]',
    '',
    '[STARE APEL]',
    `Timp apel: ${elapsedS}s`,
    `Ultima replica: ${lastRole}`,
    `Sugestii recente (evita dubluri):`,
    recentSugg,
    '[/STARE APEL]',
    '',
    'Decide: sugereaza sau taci. Raspunde DOAR cu obiectul JSON conform format-ului.',
  ].join('\n');

  const answer = await spawnClaude(session.systemPrompt, userPrompt);

  const decision = parseDecision(answer);
  if (!decision) {
    console.log(`[copilot] ${session.id} claude non-JSON reply, ignoring`);
    return;
  }

  if (decision.action === 'silent') {
    session.ws.send(JSON.stringify({ type: 'decision', action: 'silent' }));
    return;
  }

  if (decision.action === 'suggest' && decision.text) {
    // Dedup guard: skip if very similar to a recent one
    const dupHit = session.recentSuggestions.find(s => similar(s.text, decision.text));
    if (dupHit) {
      session.ws.send(JSON.stringify({ type: 'decision', action: 'silent', reason: 'dedup' }));
      return;
    }
    session.recentSuggestions.push({ ts: Date.now(), text: decision.text });
    if (session.recentSuggestions.length > 20) session.recentSuggestions.shift();

    session.ws.send(JSON.stringify({
      type: 'suggestion',
      priority: decision.priority || 'medium',
      tip: decision.tip || 'INFO',
      text: decision.text,
      reason: decision.reason || '',
      ts: Date.now() - session.startedAt,
    }));
  }
}

function spawnClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', userPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', CLAUDE_MODEL,
      '--effort', CLAUDE_EFFORT,
      '--append-system-prompt', systemPrompt,
      '--max-turns', '1',
      '--dangerously-skip-permissions',
    ];

    // Clean env — remove CLAUDECODE markers so CLI doesn't complain about nested session
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    for (const k of Object.keys(env)) {
      if (k.startsWith('CLAUDE_CODE_')) delete env[k];
    }

    const proc = spawn(CLAUDE_CLI, args, { env, cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let assistantText = '';

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
      let lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text' && block.text) assistantText += block.text;
            }
          }
        } catch {}
      }
    });

    proc.stderr.on('data', c => stderr += c.toString());

    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('claude timeout'));
    }, 20000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !assistantText) {
        return reject(new Error(`claude exit ${code}: ${stderr.slice(0, 300)}`));
      }
      resolve(assistantText.trim());
    });
  });
}

function parseDecision(text) {
  if (!text) return null;
  // strip code fences if present
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // Try to find a JSON object
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (obj && (obj.action === 'silent' || obj.action === 'suggest')) return obj;
    return null;
  } catch { return null; }
}

function similar(a, b) {
  const na = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (na === nb) return true;
  // simple ratio: shared tokens / max tokens
  const sa = new Set(na.split(' '));
  const sb = new Set(nb.split(' '));
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.max(sa.size, sb.size) > 0.7;
}

// --- Idle cleanup ---------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivityAt > 30 * 60 * 1000) {
      console.log('[copilot] closing idle session', id);
      try { s.ws.close(); } catch {}
      sessions.delete(id);
    }
  }
}, 60_000);

// --- Start ---------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[copilot] listening on ${PORT}`);
  console.log(`[copilot] whisper -> ${WHISPER_URL}`);
  console.log(`[copilot] claude   -> ${CLAUDE_CLI} (${CLAUDE_MODEL}/${CLAUDE_EFFORT})`);
  console.log(`[copilot] playbook -> ${PLAYBOOK_PATH}`);
  console.log(`[copilot] client token: t=${crypto.createHmac('sha256', JWT_SECRET).update('copilot-client').digest('hex').slice(0, 32)}`);
});

process.on('SIGTERM', () => { console.log('[copilot] SIGTERM'); process.exit(0); });
