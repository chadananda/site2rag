const path = require('path');
const SITE2RAG_ROOT = process.env.SITE2RAG_ROOT || path.resolve(__dirname, '..');
module.exports = {
  apps: [
    {
      name: 'site2rag',
      script: './src/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: { NODE_ENV: 'production', SITE2RAG_ROOT },
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      restart_delay: 30000,
      max_memory_restart: '2G',
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
        UPGRADE_REPORT_PATH: path.join(SITE2RAG_ROOT, 'report')
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
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
