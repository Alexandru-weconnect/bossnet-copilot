# Bossnet Copilot

Real-time sales assistant pentru echipa Bossnet.
- **Backend** (Node, PM2, port 3003) — primeste audio pe WS, transcrie cu `whisper-api` local, decide cu `claude` CLI daca sa sugereze.
- **Desktop** (Tauri, Windows) — captureaza mic (agent) + WASAPI loopback (client), afiseaza overlay always-on-top cu sugestii.
- **Playbook** (`playbook.md`) — sursa unica de adevar despre servicii, preturi, obiectii, case studies. Editabil oricand, reload la cerere.

## Structura

```
bossnet-copilot/
├── playbook.md              # editabil — reload din UI
├── backend/                 # PM2 service
│   ├── server.js
│   ├── system-prompt.md
│   ├── ecosystem.config.js
│   └── package.json
├── desktop/                 # Tauri app
│   ├── src/                 # HTML/CSS/JS frontend
│   ├── src-tauri/           # Rust: audio capture + WS
│   │   ├── src/{main,lib,audio,ws}.rs
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   └── package.json
└── .github/workflows/build.yml  # Windows build & release
```

## Deploy backend (server teambossnet.ro)

```bash
# 1. Clone in proiecte/
git clone git@github.com:OWNER/bossnet-copilot.git /home/teambossnet/proiecte/bossnet-copilot
cd /home/teambossnet/proiecte/bossnet-copilot/backend

# 2. Install
npm install

# 3. Set JWT secret in .env (or export before pm2 start)
export COPILOT_JWT_SECRET=$(openssl rand -hex 32)
echo "COPILOT_JWT_SECRET=$COPILOT_JWT_SECRET" > .env

# 4. Start via PM2
pm2 start ecosystem.config.js
pm2 save            # persist across reboots
pm2 logs bossnet-copilot --lines 30

# 5. Take client token from logs (linia "client token: t=...")
# Il pui in desktop app la campul "Server WSS":
#   wss://teambossnet.ro:3003/?t=<token>
```

## Build desktop app

Push la `main` -> GitHub Actions ruleaza automat -> release cu `.msi` si `.exe` in tab-ul Releases.

Local:
```bash
cd desktop
npm install
npm run tauri build
# Iese in desktop/src-tauri/target/release/bundle/
```

## Cum lucreaza

1. Agent apasa "Start apel" in desktop app.
2. Doua thread-uri audio pornesc:
   - **mic** -> chunk-uri VAD -> WS binary frame (role=0)
   - **loopback** (WASAPI, output opened as input) -> chunk-uri VAD -> WS binary frame (role=1)
3. Backend primeste chunk-urile, le trimite la `whisper-api` local -> primeste text.
4. Backend acumuleaza transcript rulant. La fiecare utterance nou spawn-eaza `claude -p ...` cu playbook + transcript + system prompt.
5. Claude raspunde JSON: `{"action":"silent"}` sau `{"action":"suggest","text":"...","priority":"..."}`.
6. Sugestia ajunge inapoi la desktop pe WS -> overlay o afiseaza.

## Editare playbook

Editezi `playbook.md` local (in `/home/teambossnet/proiecte/bossnet-copilot/playbook.md` pe server), apoi apesi "Reload playbook" in desktop app. Nu trebuie restart PM2.

## Note

- **Loopback Windows**: cpal deschide dispozitivul output ca input stream, ceea ce activeaza WASAPI loopback nativ. Nu ai nevoie de driver virtual (BlackHole, VB-Cable etc). Daca vrei un dispozitiv anume (nu default output), selecteaza-l din UI.
- **Content protection overlay**: `contentProtected: true` in tauri.conf.json -> overlay-ul NU apare in screen share / recording pe Windows (WDA_MONITOR).
- **Latenta tipica**: 4-7 secunde de la sfarsit fraza client pana apare sugestia (whisper batch ~2-3s + claude ~2-4s).
