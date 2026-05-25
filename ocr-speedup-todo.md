# OCR Speed-Up TODO
Goal: s3 stage (batch OCR) under 40s for a 5-page English image scan.
Baseline: 255-281s. Latest benchmark: 168s (3 workers routing, Jafar offline).

---

## Network Machines

| Machine | IP | CPU | RAM | GPU | Status |
|---------|----|----|-----|-----|--------|
| tower-nas | 100.77.148.41 | 80-core Xeon | 188GB | GT 730 (useless, CC 3.5) | ✅ Online — registry, pipeline-server, Meilisearch |
| Jafar (Bayan's Mini) | 100.98.204.79 | M1, 8 cores | 8GB | Metal ✅ | ✅ Online — doctr+kraken; easyocr/paddle upgraded |
| chads-air | Chads-Air.local | M3 | 24GB | Metal ✅ | ✅ Online, cap=50%, SERVE_POOL_SIZE=0 (OOM risk) |
| boss | 100.94.103.121 (changes on Tailscale reinstall) | Strix Halo 395+ | 128GB | RDNA 3.5 (ROCm) ✅ | ⚠️ GPU crash bug — amdgpu.runpm=0 fix pending reboot |

---

## Immediate TODO

### Fix tower-nas (offline)
```bash
# When it comes back:
ssh tower-nas "pm2 status"
# Deploy updated files:
scp src/pipeline/tool-runner.js tower-nas:/tank/site2rag/app/src/pipeline/tool-runner.js
scp src/pipeline/server.js tower-nas:/tank/site2rag/app/src/pipeline/server.js
ssh tower-nas "cd /tank/site2rag/app && pm2 reload all"
```

### Fix Jafar easyocr (torch upgrade)
Upgrading torch 1.10.2 → latest. EasyOCR 1.7.2 requires `torch.ao.quantization.QuantStub`.
After upgrade, restart worker:
```bash
ssh xSwarm@100.98.204.79 "launchctl unload ~/Library/LaunchAgents/com.site2rag.worker-agent.plist && launchctl load ~/Library/LaunchAgents/com.site2rag.worker-agent.plist"
```

---

## Architecture (confirmed working)

**Pipeline server**: tower-nas port 49900
**Worker registry**: tower-nas port 49900/workers
**Worker port**: 49910 on each machine

**File transfer**: HTTP base64 inputFiles (NO NFS required)
- tool-runner.js packs directories as `__dir_N/filename` base64 keys
- worker-agent.js and worker-agent.py reconstruct dirs from these keys
- Eliminates all NFS dependency — any machine on the network can be a worker

**GPU-aware routing** (implemented, awaiting tower-nas deploy):
- `GPU_PREFERRED_TOOLS = {easyocr_ocr, paddle_ocr, doctr_ocr, surya_ocr}`
- Workers report `gpu:cuda`, `gpu:rocm`, `gpu:metal` in health
- Non-GPU workers get +30 score penalty for GPU-preferred tools
- Boss (ROCm→gpu:cuda=true), Jafar (Metal), chads-air (Metal) preferred for OCR

**Routing**: tool-runner picks lowest-score worker; GPU workers win for OCR tools.
SERVE_CAPABLE_TOOLS (easyocr_ocr, paddle_ocr, doctr_ocr, kraken_ocr) bypass capacity check.

**Serve pools (tower-nas JS worker)**:
- 4 warm Python subprocesses per engine × 3 engines = 12 total
- OMP_NUM_THREADS=6 each
- Eliminates model cold-start (~30-60s per engine)

**Serve pools (Python workers)**:
- boss: SERVE_POOL_SIZE=4, 40-CU GPU, 128GB RAM — should be fast
- chads-air: SERVE_POOL_SIZE=4 (M3, 24GB)
- Jafar: SERVE_POOL_SIZE=0 (8GB RAM constrained)

---

## What Was Fixed This Session

1. **NFS dependency removed**: tool-runner.js packs directories as base64 inputFiles
2. **worker-agent.py nfs_ok gating removed**: OCR tools no longer require NFS mount
3. **worker-agent.py directory reconstruction**: handles `__dir_N/filename` keys
4. **Non-zero exits return 200**: tesseract --psm 0 OSD legitimately exits 1; fixed retry storms
5. **Jafar disk full fixed**: TMPDIR→Fat-Library (5TB), model caches relocated, 59GB free
6. **PYTORCH_ENABLE_MPS_FALLBACK=1**: set for M* mac workers, enables Metal GPU
7. **chads-air cap=50%**: never uses >50% of machine
8. **Boss GPU confirmed**: HSA_OVERRIDE_GFX_VERSION=11.0.0 → PyTorch sees AMD Radeon 8060S (gpu:cuda=true via ROCm), 124GB unified memory
9. **Boss serve pools**: SERVE_POOL_SIZE=4, all 3 OCR engines enabled
10. **GPU-aware routing**: pickWorker in tool-runner.js prefers GPU workers for OCR tools (+30 penalty for CPU-only)
11. **Registry persistence**: server.js saves workers to SQLite — survives pipeline-server restarts (NOT YET DEPLOYED — tower-nas offline)
12. **Hugo page markers**: s8-export.js now emits `{pdf_page=N}` format (ingester-compatible)

---

## Path to <40s

Current bottleneck: tower-nas offline (serves as registry/orchestrator).
With tower-nas back + all 4 machines:
- boss (ROCm GPU, SERVE_POOL_SIZE=4): ~50-100ms/crop
- chads-air (M3 Metal, SERVE_POOL_SIZE=4): ~50-100ms/crop
- Jafar (M1 Metal, doctr+kraken): ~100-200ms/crop
- tower-nas (80-core CPU, serve pools 4×3): ~500ms/crop but 12 parallel

For a 5-page doc with ~20 crops/page = 100 crops total:
- 3 GPU workers handling 33 crops each at ~100ms = ~3.3s + overhead
- Expected s3: 10-20s with all machines working
- Bottleneck will be Haiku synthesis pass, not OCR

**GT 730 note**: DO NOT enable serve pools on tower-nas's GT 730 (CC 3.5, not supported by PyTorch).
