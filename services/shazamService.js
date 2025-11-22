// src/services/shazamService.js

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к скрипту. Поднимаемся из services (..) и заходим в scripts
const PYTHON_SCRIPT = path.join(__dirname, '../scripts/recognize.py');
const TEMP_DIR = path.join(os.tmpdir(), 'shazam_tmp');

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

// Главная функция
export async function identifyTrack(fileLink) {
    // Telegram часто отдает файлы без расширения или в ogg, mp4.
    // ShazamIO всеяден, но лучше дать расширение.
    const tempFile = path.join(TEMP_DIR, `rec_${Date.now()}.mp3`); 
    
    try {
        await downloadFile(fileLink, tempFile);
        
        return await new Promise((resolve, reject) => {
            const pythonProcess = spawn('python3', [PYTHON_SCRIPT, tempFile]);
            
            let resultData = '';
            
            pythonProcess.stdout.on('data', (data) => {
                resultData += data.toString();
            });

            pythonProcess.on('close', (code) => {
                // Удаляем файл после обработки
                fs.unlink(tempFile, () => {});

                if (code !== 0) {
                    console.error('[Shazam] Python process exited with code', code);
                    return resolve(null);
                }

                try {
                    const json = JSON.parse(resultData);
                    if (json.error || !json.track) return resolve(null);

                    resolve({
                        title: json.track.title,
                        artist: json.track.subtitle,
                        image: json.track.images?.coverart,
                        link: json.track.url
                    });
                } catch (e) {
                    console.error('[Shazam] JSON Parse Error:', e);
                    resolve(null);
                }
            });
        });

    } catch (e) {
        console.error('[Shazam] Error:', e);
        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => {});
        return null;
    }
}
