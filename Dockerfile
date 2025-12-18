# Минимальный образ Node 18 (Debian slim)
FROM node:18-slim

WORKDIR /app

# Устанавливаем зависимости системы
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем зависимости Python глобально
# --break-system-packages нужен для новых версий Debian/Ubuntu в Docker
COPY requirements.txt .
RUN pip3 install --no-cache-dir --upgrade --break-system-packages pip && \
    pip3 install --no-cache-dir --upgrade --break-system-packages -r requirements.txt && \
    pip3 install --no-cache-dir --upgrade --break-system-packages yt-dlp

# Node.js зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем исходники
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
