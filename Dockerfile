FROM node:18-alpine

RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    git \
    wget \
    curl

WORKDIR /app

COPY package.json package-lock.json* yarn.lock* ./

RUN npm install --legacy-peer-deps --omit=dev

COPY . .

RUN mkdir -p session temp tmp data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s \
    CMD wget -q -O- http://localhost:3000/api/status || exit 1

CMD ["npm", "start"]
