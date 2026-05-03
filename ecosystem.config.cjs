const path = require('path');
const fs = require('fs');
const SITE2RAG_ROOT = process.env.SITE2RAG_ROOT || path.join(__dirname, '..');
// Load .env from SITE2RAG_ROOT so PM2 picks up secrets without shell sourcing
const envVars = {};
const envFile = path.join(SITE2RAG_ROOT, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) envVars[m[1]] = m[2].trim();
  });
}
const ANTHROPIC_API_KEY = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
module.exports = {
  apps: [
    {
      name: 'site2rag',
      script: './src/index.js',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--max-old-space-size=8192',
      env: { NODE_ENV: 'production', SITE2RAG_ROOT },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 30000,
      max_memory_restart: '10G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: '../logs/site2rag.out.log',
      error_file: '../logs/site2rag.err.log',
      merge_logs: true
    },
    {
      name: 'lnker-server',
      script: './bin/lnker-server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: { NODE_ENV: 'production', SITE2RAG_ROOT, LNKER_PORT: '7841' },
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      out_file: '../logs/lnker-server.out.log',
      error_file: '../logs/lnker-server.err.log',
      merge_logs: true
    },
    {
      name: 'pdf-report-server',
      script: './bin/report-server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SITE2RAG_ROOT,
        REPORT_PORT: '7840',
        CORS_ORIGIN: 'https://site2rag.lnker.com',
        ANTHROPIC_API_KEY,
        UPGRADE_REPORT_PATH: path.join(SITE2RAG_ROOT, 'report')
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      out_file: '../logs/report-server.out.log',
      error_file: '../logs/report-server.err.log',
      merge_logs: true
    },
    {
      name: 'pdf-upgrade-worker',
      script: './bin/pdf-upgrade-worker.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SITE2RAG_ROOT,
        ANTHROPIC_API_KEY,
        LOCAL_LLM: process.env.LOCAL_LLM || 'http://boss.taile945b3.ts.net:8000/v1',
        LOCAL_LLM_MODEL: process.env.LOCAL_LLM_MODEL || 'llava'
      },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 60000,
      max_memory_restart: '512M',
      out_file: '../logs/pdf-upgrade.out.log',
      error_file: '../logs/pdf-upgrade.err.log',
      merge_logs: true
    },
    {
      name: 'site2rag-updater',
      script: './bin/updater.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SITE2RAG_ROOT,
        UPDATE_CHECK_INTERVAL_MIN: '60',
        UPDATE_BRANCH: 'main',
        UPDATE_ENABLED: 'true'
      },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 60000,
      max_memory_restart: '256M',
      out_file: '../logs/updater.out.log',
      error_file: '../logs/updater.err.log',
      merge_logs: true
    }
  ]
};
