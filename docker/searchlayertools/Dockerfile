# searchlayertools — Universal OCR/ML worker image
# All CLI tools and Python ML packages pre-installed.
# Deploy: docker run -d -p 49910:49910 [--device /dev/kfd --device /dev/dri] searchlayertools
# GPU: AMD ROCm — add --device /dev/kfd --device /dev/dri/renderD128 --group-add video
#      NVIDIA   — use nvidia-container-toolkit: --gpus all
# Build: docker build -t searchlayertools docker/searchlayertools/

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV WORKER_PORT=49910

# ── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # OCR CLI tools
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-osd \
    tesseract-ocr-ara \
    tesseract-ocr-fas \
    tesseract-ocr-fra \
    tesseract-ocr-deu \
    tesseract-ocr-spa \
    # PDF tools
    ghostscript \
    poppler-utils \
    unpaper \
    # Image processing
    imagemagick \
    ffmpeg \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # Utilities
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── Python ML packages ───────────────────────────────────────────────────────
# Install into a venv so pip doesn't fight system Python
RUN python3 -m venv /opt/searchlayer-venv

# PyTorch CPU first (overridden by ROCm/CUDA variants at runtime via env)
RUN /opt/searchlayer-venv/bin/pip install --no-cache-dir \
    torch torchvision --index-url https://download.pytorch.org/whl/cpu

# OCR engines
RUN /opt/searchlayer-venv/bin/pip install --no-cache-dir \
    easyocr \
    paddlepaddle \
    paddleocr \
    python-doctr \
    kraken \
    surya-ocr \
    transformers

# ── Worker agent ─────────────────────────────────────────────────────────────
COPY worker-agent.py /usr/local/bin/worker-agent.py
RUN chmod +x /usr/local/bin/worker-agent.py

# ── ImageMagick policy fix ────────────────────────────────────────────────────
# Ubuntu ships a restrictive policy that blocks PDF processing
RUN sed -i 's/<policy domain="coder" rights="none" pattern="PDF"/<policy domain="coder" rights="read|write" pattern="PDF"/' \
    /etc/ImageMagick-6/policy.xml 2>/dev/null || true

EXPOSE 49910

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:49910/health || exit 1

ENTRYPOINT ["/opt/searchlayer-venv/bin/python", "/usr/local/bin/worker-agent.py"]
