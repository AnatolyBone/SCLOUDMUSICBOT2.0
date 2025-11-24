// src/services/karaokeService.js (Исправлено по новой документации)

import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MVSEP_API_KEY } from '../config.js';

const API_BASE = 'https://mvsep.com/api/separation';
const TEMP_DIR = path.join(os.tmpdir(), 'karaoke_tmp');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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

async function createTask(filePath) {
    const form = new FormData();
    form.append('audiofile', fs.createReadStream(filePath));
    form.append('api_token', MVSEP_API_KEY); // Токен в теле запроса!
    form.append('sep_type', '40'); // BS Roformer (vocals, instrumental) - код 40 из доки
    form.append('output_format', '0'); // MP3 320kbps
    form.append('is_demo', '0');

    const requestConfig = {
        method: 'post',
        url: `${API_BASE}/create`,
        headers: { 
            ...form.getHeaders()
        },
        data: form,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    };

    try {
        const res = await axios(requestConfig);
        
        if (res.data && res.data.success) {
            return res.data.data.hash; // Хэш задачи
        } else {
            throw new Error(res.data.data?.message || 'Ошибка загрузки на MVSEP');
        }
    } catch (error) {
        if (error.response) {
            console.error('[MVSEP API Error]', error.response.status, error.response.data);
            throw new Error(`MVSEP Error ${error.response.status}: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    }
}

async function waitForResult(hash) {
    // Увеличим таймаут, так как MVSEP может быть медленным
    const maxAttempts = 120; // ~20 минут
    let attempts = 0;

    while (attempts < maxAttempts) {
        try {
            const res = await axios.get(`${API_BASE}/get`, {
                params: { hash }
            });

            const body = res.data;
            
            if (!body.success) {
                 // Хэш не найден или просрочен
                 throw new Error('Задача не найдена или удалена');
            }

            const status = body.status; // waiting, processing, done, failed
            
            if (status === 'done') {
                // Формируем объект с результатами
                // API возвращает массив файлов в data.files
                const files = body.data.files;
                const result = {};
                
                if (Array.isArray(files)) {
                    files.forEach(f => {
                        // Ищем вокал и инструмент по имени файла или описанию
                        // Обычно BS Roformer дает vocals.mp3 и instrumental.mp3
                        const lowerUrl = f.url.toLowerCase();
                        if (lowerUrl.includes('vocals')) result.Vocals = f.url;
                        else if (lowerUrl.includes('instrumental') || lowerUrl.includes('no_vocals')) result.Instrumental = f.url;
                        else if (lowerUrl.includes('music')) result.Instrumental = f.url;
                    });
                }
                
                // Если не смогли распарсить, вернем что есть (первый как инструмент, второй как вокал)
                if (!result.Vocals && files.length > 0) result.Vocals = files[0].url;
                
                return result; 
            }
            
            if (status === 'failed') {
                throw new Error('Ошибка обработки на стороне MVSEP: ' + (body.data?.message || 'Unknown error'));
            }
            
            // waiting или processing - ждем
            console.log(`[MVSEP] Status: ${status}, Queue: ${body.data?.queue_count || 0}`);

        } catch (e) {
            console.warn('[MVSEP Polling] Warning:', e.message);
            if (e.message.includes('Задача не найдена')) throw e;
        }

        await new Promise(r => setTimeout(r, 10000)); // 10 сек
        attempts++;
    }
    throw new Error('Таймаут обработки');
}

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
