# Минимальный образ Node 18 (Debian slim)
FROM node:18-slim

WORKDIR /app

# Устанавливаем Python и ffmpeg (для yt-dlp и shazam)
# НЕ ставим spotdl - слишком тяжёлый для бесплатного Render
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp shazamio \
    && rm -rf /var/lib/apt/lists/*

# Node.js зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем исходники
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
