module.exports = {
  apps: [{
    name: 'bossnet-copilot',
    script: 'server.js',
    cwd: __dirname,
    env: {
      COPILOT_PORT: 3003,
      COPILOT_JWT_SECRET: process.env.COPILOT_JWT_SECRET || 'change-me-in-env',
      WHISPER_URL: 'http://127.0.0.1:5123/api/transcribe',
      CLAUDE_CLI: '/home/teambossnet/.local/bin/claude',
      CLAUDE_MODEL: 'sonnet',
      CLAUDE_EFFORT: 'low',
      PLAYBOOK_PATH: '/home/teambossnet/proiecte/bossnet-copilot/playbook.md',
      SYSTEM_PROMPT_PATH: '/home/teambossnet/proiecte/bossnet-copilot/backend/system-prompt.md',
      SSL_CERT: '/home/teambossnet/luc-claude/bridge/.runtime-fullchain.pem',
      SSL_KEY: '/home/teambossnet/ssl/keys/fc649_6ad41_92fd272285b512b3e7cb998dc94b6b7a.key',
      NODE_ENV: 'production'
    },
    max_memory_restart: '400M',
    autorestart: true,
    watch: false,
    error_file: '/home/teambossnet/.pm2/logs/bossnet-copilot-error.log',
    out_file: '/home/teambossnet/.pm2/logs/bossnet-copilot-out.log'
  }]
};
