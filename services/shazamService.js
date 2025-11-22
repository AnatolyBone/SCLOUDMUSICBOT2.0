import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к нашему Python скрипту
const PYTHON_SCRIPT = path.join(__dirname, '../scripts/recognize.py');
const TEMP_DIR = path.join(os.tmpdir(), 'shazam_tmp');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Скачивает файл по ссылке
 */
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

/**
 * Распознает музыку через Python скрипт (shazamio)
 */
export async function identifyTrack(fileLink) {
    const tempFile = path.join(TEMP_DIR, `rec_${Date.now()}.ogg`); // Telegram часто отдает OGG или MP4
    
    try {
        // 1. Скачиваем файл
        await downloadFile(fileLink, tempFile);
        
        // 2. Запускаем Python процесс
        return await new Promise((resolve, reject) => {
            const pythonProcess = spawn('python', [PYTHON_SCRIPT, tempFile]);
            
            let resultData = '';
            let errorData = '';

            pythonProcess.stdout.on('data', (data) => {
                resultData += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                errorData += data.toString();
            });

            pythonProcess.on('close', (code) => {
                // Удаляем временный файл
                fs.unlink(tempFile, () => {});

                if (code !== 0) {
                    console.error('[Shazam] Python Error:', errorData);
                    return resolve(null);
                }

                try {
                    const json = JSON.parse(resultData);
                    if (json.error) {
                        console.error('[Shazam] Lib Error:', json.error);
                        return resolve(null);
                    }
                    
                    // Проверяем, нашлось ли что-то
                    if (!json.track || !json.track.title) {
                        return resolve(null);
                    }

                    // Формируем красивый ответ
                    resolve({
                        title: json.track.title,
                        artist: json.track.subtitle,
                        image: json.track.images?.coverart,
                        link: json.track.url
                    });
                } catch (e) {
                    console.error('[Shazam] JSON Parse Error:', e.message, resultData);
                    resolve(null);
                }
            });
        });

    } catch (e) {
        console.error('[Shazam] Global Error:', e);
        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        return null;
    }
}
