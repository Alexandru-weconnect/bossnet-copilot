# bossnet-copilot backend

Node.js WebSocket server. Real-time sales copilot pentru Bossnet.

## Ce face

1. Primeste chunk-uri audio pe WSS de la desktop app (2 canale: agent mic + client loopback)
2. Trimite fiecare chunk la `whisper-api` local (`POST http://127.0.0.1:5123/api/transcribe`)
3. Acumuleaza transcript rulant
4. La fiecare utterance nou spawn-eaza `claude` CLI cu playbook + transcript
5. Trimite decizia (silent sau suggest) inapoi la desktop pe WSS

## Deploy

```bash
# 1. Copiaza in /home/teambossnet/proiecte/bossnet-copilot/
mkdir -p /home/teambossnet/proiecte/bossnet-copilot
cp -r ./* /home/teambossnet/proiecte/bossnet-copilot/

# 2. Install deps
cd /home/teambossnet/proiecte/bossnet-copilot/backend
npm install

# 3. Start via PM2
pm2 start ecosystem.config.js
pm2 save   # persist across reboots
pm2 startup   # rulat o singura data — genereaza comanda systemd

# 4. Verifica
pm2 logs bossnet-copilot --lines 30
curl -k https://127.0.0.1:3003/health
```

## Endpoint WS

`wss://teambossnet.ro:3003/?t=<token>`

Token-ul se genereaza HMAC-SHA256(JWT_SECRET, 'copilot-client'), primele 32 hex chars.
Server-ul il tipareste la pornire in log.

## Protocol WS

**Client -> server:**
- Binary frame: `[1B role (0=agent,1=client)] [4B big-endian uint32 duration_ms] [payload WebM/Opus]`
- JSON `{"type":"ping"}`
- JSON `{"type":"reload-playbook"}` — dupa ce editezi playbook.md
- JSON `{"type":"clear-transcript"}` — reset la apel nou
- JSON `{"type":"manual-text","role":"agent|client","text":"..."}` — insert manual

**Server -> client:**
- `{"type":"ready","sessionId":"..."}`
- `{"type":"transcript","role":"agent|client","text":"...","ts":<sec>,"whisperMs":<ms>}`
- `{"type":"suggestion","priority":"high|medium|low","tip":"...","text":"...","reason":"...","ts":<sec>}`
- `{"type":"decision","action":"silent","reason":"..."}`
- `{"type":"error","kind":"whisper|claude","message":"..."}`

## Variabile env

Vezi `ecosystem.config.js`. Trebuie sa suprascrii **COPILOT_JWT_SECRET** cu ceva random real inainte de production.
