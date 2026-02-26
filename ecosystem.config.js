module.exports = {
  apps: [{
    name: 'hai-tech-bot',
    script: 'server.js',
    cwd: '/home/igrois/.openclaw/workspace/hai-tech-whatsapp-bot',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 18790
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
