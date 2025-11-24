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
    form.append('sep_type', 'bs_roformer'); 
    form.append('is_demo', '0');

    const headers = {
        ...form.getHeaders(),
        'Authorization': `Bearer ${MVSEP_API_KEY}`
    };

    try { // <--- ВОТ ЭТО БЫЛО ПРОПУЩЕНО
        const res = await axios.post(`${BASE_URL}/separation`, form, { headers });
        
        if (res.data && res.data.success) {
            return res.data.hash;
        } else {
            throw new Error(res.data.message || 'Ошибка загрузки на MVSEP');
        }
    } catch (error) {
        if (error.response) {
            console.error('[MVSEP API Error]', error.response.status, error.response.data);
            throw new Error(`MVSEP Error: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    }
}

// 3. Проверка статуса (Polling)
async function waitForResult(hash) {
    const maxAttempts = 60; 
    let attempts = 0;

    while (attempts < maxAttempts) {
        const res = await axios.get(`${BASE_URL}/task`, {
            params: { hash },
            headers: { 'Authorization': `Bearer ${MVSEP_API_KEY}` }
        });

        const data = res.data;
        
        if (data.status === 'done') {
            return data.files; 
        }
        
        if (data.status === 'error') {
            throw new Error('Ошибка обработки на стороне MVSEP');
        }

        await new Promise(r => setTimeout(r, 10000));
        attempts++;
    }
    throw new Error('Таймаут обработки');
}

// --- ГЛАВНАЯ ФУНКЦИЯ ---
export async function processKaraoke(fileUrl) {
    let tempFile = null;
    try {
        tempFile = await downloadToTemp(fileUrl);
        const hash = await createTask(tempFile);
        
        fs.unlink(tempFile, () => {});
        tempFile = null;

        const files = await waitForResult(hash);
        return files;
    } catch (e) {
        if (tempFile && fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        throw e;
    }
}
