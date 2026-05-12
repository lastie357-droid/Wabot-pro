FROM node:18-slim

# Install system dependencies (Debian-based — glibc, so sharp pre-built binaries work)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    git \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfiles first for better layer caching
COPY package.json package-lock.json* yarn.lock* ./

# Tell sharp to use its own bundled libvips (no system libvips needed)
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1

# Install production deps
RUN npm install --legacy-peer-deps --omit=dev

# Copy the rest of the source
COPY . .

# Ensure runtime directories exist
RUN mkdir -p session temp tmp data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s \
    CMD wget -q -O- http://localhost:3000/api/status || exit 1

CMD ["npm", "start"]
