module.exports = {
  apps: [{
    name: 'worker-agent',
    script: '/tank/site2rag/app/bin/worker-agent.js',
    env: {
      WORKER_REGISTRY: 'http://localhost:49900',
      PUBLIC_URL: 'http://100.77.148.41:49910',
      SERVE_POOL_SIZE: '4',
      CAPACITY_LIMIT: '0.8',
    }
  }]
};
