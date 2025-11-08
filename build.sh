#!/usr/bin/env bash
# exit on error
set -o errexit

# 1. Устанавливаем Node.js зависимости
echo "---> Installing Node.js dependencies..."
npm install

# 2. Устанавливаем Python зависимости из файла
echo "---> Installing Python dependencies..."
pip install -r requirements.txt

# 3. Устанавливаем yt-dlp как системную утилиту
echo "---> Installing yt-dlp globally..."
pip install yt-dlp --no-deps -U -t /usr/local/bin

echo "Build script finished."