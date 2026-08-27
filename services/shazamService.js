// src/services/shazamService.js

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к скрипту: поднимаемся из services (..) и заходим в scripts
const PYTHON_SCRIPT = path.join(__dirname, '../scripts/recognize.py');
// Используем системную временную папку
const TEMP_DIR = path.join(os.tmpdir(), 'shazam_tmp');

// Создаем папку для временных файлов, если её нет
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Функция скачивания файла
async function downloadFile(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

export async function recognizeTrack(fileLink, { timeoutMs = 45000 } = {}) {
    const startedAt = Date.now();
    // Создаем уникальное имя для временного файла
    const tempFile = path.join(TEMP_DIR, `rec_${Date.now()}.mp3`); 
    
    try {
        // 1. ПРОВЕРКА: Существует ли Python скрипт вообще?
        if (!fs.existsSync(PYTHON_SCRIPT)) {
            console.error(`[Shazam] CRITICAL ERROR: Python script not found at: ${PYTHON_SCRIPT}`);
            return { ok: false, reason: 'recognizer_error', latencyMs: Date.now() - startedAt };
        }

        // 2. Скачиваем аудиофайл по ссылке из Telegram
        try {
            await downloadFile(fileLink, tempFile);
        } catch (error) {
            console.error('[Shazam] Download failed:', error.message);
            fs.unlink(tempFile, () => {});
            return { ok: false, reason: 'download_failed', latencyMs: Date.now() - startedAt };
        }
        
        // 3. Запускаем Python
        return await new Promise((resolve, reject) => {
            // Используем 'python3', так как на Render Linux
            const pythonProcess = spawn('python3', [PYTHON_SCRIPT, tempFile]);
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                fs.unlink(tempFile, () => {});
                resolve(value);
            };
            const timeout = setTimeout(() => {
                pythonProcess.kill('SIGKILL');
                finish({ ok: false, reason: 'timeout', latencyMs: Date.now() - startedAt });
            }, timeoutMs);
            
            let resultData = '';
            let errorData = ''; // Сюда будем записывать ошибки
            
            // Читаем успешный вывод (JSON)
            pythonProcess.stdout.on('data', (data) => {
                resultData += data.toString();
            });

            // Читаем ошибки (Traceback) - САМОЕ ВАЖНОЕ ДЛЯ ОТЛАДКИ
            pythonProcess.stderr.on('data', (data) => {
                errorData += data.toString();
            });

            pythonProcess.on('error', error => {
                console.error('[Shazam] Failed to start recognizer:', error.message);
                finish({ ok: false, reason: 'recognizer_error', latencyMs: Date.now() - startedAt });
            });

            pythonProcess.on('close', (code) => {
                if (settled) return;

                // Если код не 0, значит скрипт упал
                if (code !== 0) {
                    console.error(`[Shazam] Process exited with code ${code}`);
                    // Выводим в логи текст ошибки Python
                    if (errorData) {
                        console.error('⬇⬇⬇ [Shazam] PYTHON ERROR TRACEBACK ⬇⬇⬇');
                        console.error(errorData);
                        console.error('⬆⬆⬆ --------------------------------- ⬆⬆⬆');
                    }
                    const reason = /ffmpeg|convert|codec|format/i.test(errorData) ? 'conversion_failed' : 'recognizer_error';
                    return finish({ ok: false, reason, latencyMs: Date.now() - startedAt });
                }

                try {
                    // Пытаемся разобрать ответ от Python
                    const json = JSON.parse(resultData);
                    
                    if (json.error) {
                        console.error('[Shazam] Script returned error:', json.error);
                        return finish({ ok: false, reason: 'recognizer_error', latencyMs: Date.now() - startedAt });
                    }

                    if (!json.track) {
                        // Трек не найден
                        return finish({ ok: false, reason: 'no_match', latencyMs: Date.now() - startedAt });
                    }

                    // Успех!
                    finish({
                        ok: true,
                        latencyMs: Date.now() - startedAt,
                        track: {
                            title: json.track.title,
                            artist: json.track.subtitle,
                            image: json.track.images?.coverart,
                            link: json.track.url,
                            externalId: json.track.key || null
                        }
                    });
                } catch (e) {
                    console.error('[Shazam] JSON Parse Error:', e);
                    console.error('[Shazam] Raw Output was:', resultData);
                    if (errorData) console.error('[Shazam] Stderr was:', errorData);
                    finish({ ok: false, reason: 'recognizer_error', latencyMs: Date.now() - startedAt });
                }
            });
        });

    } catch (e) {
        console.error('[Shazam] General Service Error:', e);
        // Чистим мусор при ошибке
        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        return { ok: false, reason: 'other', latencyMs: Date.now() - startedAt };
    }
}

// Backwards-compatible API for callers that only need the recognized track.
export async function identifyTrack(fileLink, options) {
    const result = await recognizeTrack(fileLink, options);
    return result.ok ? result.track : null;
}
