# ==============================================================================
# Deutsch Shadow — Production Dockerfile for Zero-Cost Cloud Deployment (Render)
# Multi-stage build: compiles React/Vite SPA and serves from unified FastAPI backend
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build the React / Vite frontend
# ------------------------------------------------------------------------------
FROM node:20-slim AS frontend-builder
WORKDIR /build

# Enable pnpm via corepack (matching project's pnpm 10 major version)
RUN corepack enable && corepack prepare pnpm@10 --activate

# Install dependencies with frozen lockfile for deterministic builds
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy frontend source code and compile production assets
COPY frontend/ ./
RUN pnpm build

# ------------------------------------------------------------------------------
# Stage 2: Production Python runtime with FFmpeg and faster-whisper
# ------------------------------------------------------------------------------
FROM python:3.11-slim AS production

# Install system runtime dependencies: FFmpeg, FFprobe, and CA certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python backend dependencies
COPY backend/requirements.txt ./backend/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r ./backend/requirements.txt

# Pre-cache the lightweight Whisper tiny model to eliminate cold-start download delays
RUN mkdir -p /root/.cache/huggingface/hub/models--Systran--faster-whisper-tiny/snapshots/d90ca5fe260221311c53c58e660288d3deb8d356 \
    /root/.cache/huggingface/hub/models--Systran--faster-whisper-tiny/refs && \
    echo "d90ca5fe260221311c53c58e660288d3deb8d356" > /root/.cache/huggingface/hub/models--Systran--faster-whisper-tiny/refs/main && \
    for f in config.json model.bin tokenizer.json vocabulary.txt; do \
        for i in 1 2 3 4 5; do \
            curl -fSL -C - --retry 5 -o "/root/.cache/huggingface/hub/models--Systran--faster-whisper-tiny/snapshots/d90ca5fe260221311c53c58e660288d3deb8d356/$f" \
                "https://huggingface.co/Systran/faster-whisper-tiny/resolve/d90ca5fe260221311c53c58e660288d3deb8d356/$f" && break || sleep 1; \
        done; \
    done && \
    python -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

# Copy compiled frontend distribution from Stage 1 into /app/frontend/dist
COPY --from=frontend-builder /build/dist ./frontend/dist

# Copy backend source code
COPY backend/ ./backend/

# Default container environment:
# - DEUTSCH_SHADOW_DEFAULT_MODEL=tiny: safe for 512 MB RAM limit
# - DEUTSCH_SHADOW_CPU_THREADS=1: prevents thread contention on 0.1 shared vCPU
# - PORT=10000: Render default web service port
ENV DEUTSCH_SHADOW_BASE_DIR=/app \
    DEUTSCH_SHADOW_DATA_DIR=/app/data \
    DEUTSCH_SHADOW_DEFAULT_MODEL=tiny \
    DEUTSCH_SHADOW_CPU_THREADS=1 \
    PORT=10000 \
    PYTHONUNBUFFERED=1

# Ensure data directory exists
RUN mkdir -p /app/data

EXPOSE 10000

# Start Uvicorn bound to 0.0.0.0 on Render's dynamic $PORT
CMD ["sh", "-c", "exec uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-10000}"]
