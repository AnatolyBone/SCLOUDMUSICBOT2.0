#!/usr/bin/env bash
# exit on error
set -o errexit

# 1. Устанавливаем Node.js зависимости
npm install

# 2. Устанавливаем Python зависимости
pip install -r requirements.txt