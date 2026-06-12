const path = require('path');
const fs = require('fs');
const SITE2RAG_ROOT = process.env.SITE2RAG_ROOT || path.join(__dirname, '..');
// Load .env from SITE2RAG_ROOT so PM2 picks up secrets without shell sourcing
const envVars = {};
const envFile = path.join(SITE2RAG_ROOT, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) envVars[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}
const ANTHROPIC_API_KEY = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const DEEPSEEK_API_KEY  = envVars.DEEPSEEK_API_KEY  || process.env.DEEPSEEK_API_KEY  || '';
const SLP_API_KEY       = envVars.SLP_API_KEY       || process.env.SLP_API_KEY       || '';
const SITE_ADMIN_EMAIL  = envVars.SITE_ADMIN_EMAIL  || process.env.SITE_ADMIN_EMAIL  || '';
const SITE_ADMIN_PASS   = envVars.SITE_ADMIN_PASS   || process.env.SITE_ADMIN_PASS   || '';
const TMPDIR = path.join(SITE2RAG_ROOT, 'tmp'); // all processes write temp files to the data drive, never the OS drive
module.exports = {
  apps: [
    {
      name: 'site2rag',
      script: './src/index.js',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--max-old-space-size=16384',
      env: { NODE_ENV: 'production', SITE2RAG_ROOT, TMPDIR },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 30000,
      max_memory_restart: '60G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: '../logs/site2rag.out.log',
      error_file: '../logs/site2rag.err.log',
      merge_logs: true
    },
    {
      name: 'site2rag-lnker',
      script: './bin/lnker-server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: { NODE_ENV: 'production', SITE2RAG_ROOT, LNKER_PORT: '7841', TMPDIR },
      autorestart: true,
      watch: false,
      max_memory_restart: '4G',
      out_file: '../logs/lnker-server.out.log',
      error_file: '../logs/lnker-server.err.log',
      merge_logs: true
    },
    {
      name: 'site2rag-report',
      script: './bin/report-server.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        TMPDIR,
        SITE2RAG_ROOT,
        REPORT_PORT: '7840',
        CORS_ORIGIN: 'https://site2rag.lnker.com',
        ANTHROPIC_API_KEY,
        DEEPSEEK_API_KEY,
        SITE_ADMIN_EMAIL,
        SITE_ADMIN_PASS,
        UPGRADE_REPORT_PATH: path.join(SITE2RAG_ROOT, 'report'),
        PIPELINE_URL: 'http://localhost:49900',
        SLP_API_KEY
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '8G',
      out_file: '../logs/report-server.out.log',
      error_file: '../logs/report-server.err.log',
      merge_logs: true
    },
    {
      name: 'site2rag-updater',
      script: './bin/updater.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        TMPDIR,
        SITE2RAG_ROOT,
        UPDATE_CHECK_INTERVAL_MIN: '60',
        UPDATE_BRANCH: 'main',
        UPDATE_ENABLED: 'true'
      },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 60000,
      max_memory_restart: '4G',
      out_file: '../logs/updater.out.log',
      error_file: '../logs/updater.err.log',
      merge_logs: true
    }
  ]
};
