// src/services/karaokeService.js

import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MVSEP_API_KEY } from '../config.js';

const BASE_URL = 'https://mvsep.com/api/v1';
const TEMP_DIR = path.join(os.tmpdir(), 'karaoke_tmp');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// 1. Скачивание файла от Telegram во временную папку
async function downloadToTemp(url) {
    const destPath = path.join(TEMP_DIR, `upload_${Date.now()}.mp3`);
    const writer = fs.createWriteStream(destPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(destPath));
        writer.on('error', reject);
    });
}

// 2. Создание задачи (Upload)
async function createTask(filePath) {
    const form = new FormData();
    form.append('audio_file', fs.createReadStream(filePath));
    // 'bs_roformer' - одна из лучших моделей для вокала сейчас
    // Можно поменять на 'demucs4_ht'
    form.append('sep_type', 'bs_roformer'); 
    form.append('is_demo', '0'); // 0 - полная версия

    const headers = {
        ...form.getHeaders(),
        'Authorization': `Bearer ${MVSEP_API_KEY}`
    };

    const res = await axios.post(`${BASE_URL}/separation`, form, { headers });
    if (res.data && res.data.success) {
        return res.data.hash; // ID задачи
    } else {
        throw new Error(res.data.message || 'Ошибка загрузки на MVSEP');
        }
    } catch (error) {
        // Логируем детальную ошибку от axios
        if (error.response) {
            console.error('[MVSEP API Error]', error.response.status, error.response.data);
        }
        throw error;
    }

// 3. Проверка статуса (Polling)
async function waitForResult(hash) {
    const maxAttempts = 60; // Ждем максимум 5-10 минут (60 * 5-10 сек)
    let attempts = 0;

    while (attempts < maxAttempts) {
        const res = await axios.get(`${BASE_URL}/task`, {
            params: { hash },
            headers: { 'Authorization': `Bearer ${MVSEP_API_KEY}` }
        });

        const data = res.data;
        
        if (data.status === 'done') {
            return data.files; // { "Vocals": "url...", "Instrumental": "url..." }
        }
        
        if (data.status === 'error') {
            throw new Error('Ошибка обработки на стороне MVSEP');
        }

        // Ждем 10 секунд перед следующей проверкой
        await new Promise(r => setTimeout(r, 10000));
        attempts++;
    }
    throw new Error('Таймаут обработки');
}

// --- ГЛАВНАЯ ФУНКЦИЯ ---
export async function processKaraoke(fileUrl) {
    let tempFile = null;
    try {
        // 1. Скачиваем
        tempFile = await downloadToTemp(fileUrl);
        
        // 2. Загружаем на сервис
        const hash = await createTask(tempFile);
        
        // Удаляем локальный файл, он больше не нужен
        fs.unlink(tempFile, () => {});
        tempFile = null;

        // 3. Ждем результат
        const files = await waitForResult(hash);
        
        return files; // Объект со ссылками
    } catch (e) {
        if (tempFile && fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        throw e;
    }
}
