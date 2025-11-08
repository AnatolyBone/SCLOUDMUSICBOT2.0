#!/usr/bin/env bash
# exit on error
set -o errexit

# Создаем папку для наших бинарных файлов
mkdir -p bin

# 1. Устанавливаем Node.js зависимости
echo "---> Installing Node.js dependencies..."
npm install

# 2. Устанавливаем Python зависимости из файла
echo "---> Installing Python dependencies..."
pip install -r requirements.txt

# 3. Устанавливаем yt-dlp в нашу локальную папку bin
echo "---> Installing yt-dlp into ./bin directory..."
pip install yt-dlp -t ./bin

echo "Build script finished."