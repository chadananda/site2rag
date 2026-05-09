# searchLayer — Future Standalone Project

Split off from site2rag after the OCR pipeline is dialed in.

## What it is

Two deliverables:
1. **searchLayer API** — network service that routes OCR/ML jobs to available worker nodes
2. **searchLayerTools** — Docker image containing the full toolstack + worker agent

The reason Docker is central (not optional): it's the update delivery mechanism. Push a new image,
all nodes pull and restart automatically. No SSH, no per-machine package management after initial setup.

## Update story

```
Developer updates toolstack
    ↓ docker build && docker push searchlayertools:latest
All nodes (via Watchtower or similar)
    ↓ detect new image → pull → restart container
Cluster upgraded with zero manual steps
```

This is why the installer exists: it sets up Docker on the node and configures auto-pull, not just
the worker agent. After that, the image controls the toolstack.

## Architecture

```
Client (site2rag, or any app)
    ↓ POST /tools/run { tool, args }
searchLayer API (runs on one machine, e.g. tower-nas)
    ↓ picks lowest-load available worker via GET /capacity
Worker node — Docker container on any machine
    ↓ runs tool, returns { stdout, stderr }
```

### searchLayerTools Docker image
- All CLI tools pre-installed: tesseract, gs, pdftoppm, convert/magick, unpaper, ffmpeg
- All Python OCR packages: easyocr, paddleocr, doctr, kraken, surya-ocr, torch, transformers
- Worker agent (worker-agent.py) runs as the container entrypoint
- HTTP service: GET /health, GET /capacity, POST /tools/run
- Auto-detects available GPU via device passthrough
- Self-registers with searchLayer API on startup

### searchLayer API
- Central registry of worker nodes
- GET /workers — live health snapshots of all workers
- POST /workers/register — containers call this on startup
- POST /tools/run — capacity-aware routing: pick lowest-load worker that has the tool
- GET /health — cluster-level health summary

## Install story (adding a new node)

```bash
# One command — installs Docker, pulls image, sets up auto-update, registers with cluster
curl -fsSL https://searchlayer.io/install | bash -s -- --registry http://myserver:49900
```

The installer script:
1. Installs Docker if not present
2. Installs Watchtower (or equivalent) for auto-pull on image update
3. Writes a docker-compose.yml with the registry URL and GPU passthrough for this machine's hardware
4. Starts the container
5. Node self-registers; shows up in GET /workers

## GPU passthrough per platform

| Platform | GPU | Compose config |
|----------|-----|----------------|
| Linux + NVIDIA | CUDA | `--gpus all` via nvidia-container-toolkit |
| Linux + AMD | ROCm | `--device /dev/kfd --device /dev/dri` + group video |
| Linux (CPU only) | none | no extra flags |
| macOS (M-series) | Metal | **not supported in Docker** — Metal can't be passed through |

macOS nodes require a parallel native install path — Metal GPU cannot be passed through to Docker.
The native installer mirrors the Docker image's toolstack: brew for CLI tools, pip venv for ML packages,
LaunchAgent for persistence and auto-restart. Updates are handled by a separate update mechanism
(e.g., a launchd timer that pulls the latest installer and re-runs it).

Current macOS nodes: jafar (M1 Mac mini), chads-air (M3 laptop).
Planned: M5 Mac minis when Apple Silicon AI performance justifies it.

## What stays in site2rag

- `src/pipeline/tool-runner.js` — already abstracts local vs HTTP; points at searchLayer API URL
- `src/pipeline/server.js` — /workers registry routes are the prototype for the searchLayer API
- `bin/worker-agent.py` — prototype worker agent; moves into the Docker image
- `bin/install-worker.sh` — prototype installer; replaced by the real install script
- `docker/searchlayertools/` — draft Dockerfile; becomes the real image

## Networking: Tailscale as the transport layer

All searchLayer APIs run over Tailscale. Services bind to their ports normally; Tailscale handles
WAN traversal, encryption, and access control transparently. No VPN config, no firewall rules,
no port forwarding — a node is reachable the moment it joins the tailnet.

This scales cleanly to cloud compute: a cloud VM joins the tailnet via `tailscale up`, immediately
participates in the cluster at the same port with the same API. No architecture changes needed.

**Node discovery via Tailscale API**
- Query Tailscale API → enumerate all tailnet nodes with hostnames and IPs
- Probe each at port 49910 for `/health` to get capabilities
- Tailscale is the authoritative node inventory; worker agent is the capability description
- Check login.tailscale.com for per-machine notes/metadata field — if present, could store
  `searchlayer:49910` there for zero-probe discovery

**Human-readable `GET /` on worker agent**
- Returns markdown summary: hostname, hardware, tools, endpoint URLs
- Viewable in a browser directly via Tailscale hostname (e.g. http://jafar:49910/)
- No tooling required; works from any machine on the tailnet

## Separation checklist (when ready to split)

- [ ] New repo: searchlayer
- [ ] searchLayerTools Docker image: move Dockerfile, add all tool variants (CPU/CUDA/ROCm flavors)
- [ ] searchLayer API server: extract /workers logic from pipeline/server.js, add routing
- [ ] Install script: detect OS, install Docker, pull image, configure GPU, start + register
- [ ] Auto-update (Linux/Docker): Watchtower container alongside worker, watches for new image tags
- [ ] Auto-update (macOS/native): launchd timer re-runs install script on schedule; script is idempotent
- [ ] site2rag's tool-runner.js points at searchLayer API URL (one endpoint, not per-worker)
- [ ] npm package: searchlayer-client wrapping the tool-runner HTTP logic
- [ ] Image registry: Docker Hub or self-hosted (Gitea registry on tower-nas)
