# Минимальный образ Node 18 (Debian slim)
FROM node:18-slim

WORKDIR /app

# Устанавливаем зависимости системы
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Создаем venv для Python и устанавливаем зависимости
COPY requirements.txt .
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip3 install --no-cache-dir --upgrade pip && \
    pip3 install --no-cache-dir -r requirements.txt && \
    pip3 install --no-cache-dir yt-dlp

# Node.js зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем исходники
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
