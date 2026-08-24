# AREE backend image — Pathway engine + FastAPI API layer.
# Pathway ships Linux/macOS wheels only, so the engine always runs in a
# container (or WSL) rather than natively on Windows.

FROM python:3.11-slim

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system dependencies (required for pdf2image + unstructured)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    build-essential \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy only requirements first (better Docker caching).
# Requirements moved to backend/ during the Next.js migration.
COPY backend/requirements.txt .

# Upgrade pip
RUN pip install --no-cache-dir --upgrade pip

# Install PyTorch CPU version first to prevent heavy CUDA dependency downloads
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# Install remaining Python dependencies
RUN pip install --no-cache-dir --default-timeout=1000 --retries 10 -r requirements.txt

# Copy remaining project files
COPY . .

# Expose port (Cloud Run injects $PORT)
EXPOSE 8080

# Serve the FastAPI layer, which imports and runs the Pathway engine in-process.
CMD ["sh", "-c", "uvicorn backend.api.main:api --host 0.0.0.0 --port ${PORT:-8080}"]
