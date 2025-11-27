// src/services/lyricsService.js
import puppeteer from 'puppeteer';

export async function getLyrics(artist, title) {
    let browser = null;
    try {
        // 1. Чистим запрос (удаляем мусор)
        const query = `${artist} ${title}`
            .replace(/\(Instrumental\)/gi, '')
            .replace(/\(Minus\)/gi, '')
            .replace(/\(Karaoke\)/gi, '') // Убираем слово Караоке
            .replace(/Karaoke/gi, '')     // На всякий случай без скобок
            .trim();

        console.log(`[Lyrics] Searching for: ${query}`);

        // 2. Запускаем браузер
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Нужно для Render
        });
        const page = await browser.newPage();
        
        // Притворяемся обычным пользователем
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 3. Идем в Google (лайфхак: ищем "genius.com + название песни")
        // Это работает лучше, чем поиск на самом Genius
        await page.goto(`https://www.google.com/search?q=site:genius.com+${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });

        // Ищем первую ссылку на genius.com в выдаче
        const linkSelector = 'a[href*="genius.com"]';
        await page.waitForSelector(linkSelector, { timeout: 5000 }); // Ждем 5 сек
        
        const songUrl = await page.$eval(linkSelector, el => el.href);
        
        if (!songUrl) {
            console.log('[Lyrics] Not found in Google');
            return null;
        }
        console.log(`[Lyrics] Found URL: ${songUrl}`);

        // 4. Идем на страницу песни
        await page.goto(songUrl, { waitUntil: 'domcontentloaded' });

        // 5. Парсим текст (ищем контейнеры с текстом)
        const lyrics = await page.evaluate(() => {
            // Скрипт выполняется ВНУТРИ страницы
            let text = '';
            const containers = document.querySelectorAll('[data-lyrics-container="true"]');
            
            if (containers.length > 0) {
                containers.forEach(div => {
                    // Заменяем <br> на \n для сохранения переносов
                    div.innerHTML = div.innerHTML.replace(/<br\s*\/?>/gi, '\n');
                    text += div.innerText + '\n\n';
                });
            } else {
                // Старый дизайн
                const oldDiv = document.querySelector('.lyrics');
                if (oldDiv) {
                    oldDiv.innerHTML = oldDiv.innerHTML.replace(/<br\s*\/?>/gi, '\n');
                    text = oldDiv.innerText;
                }
            }
            return text.trim();
        });

        // Парсим заголовок и картинку
        const meta = await page.evaluate(() => {
            const titleEl = document.querySelector('h1');
            const imgEl = document.querySelector('meta[property="og:image"]');
            return {
                title: titleEl ? titleEl.innerText : 'Unknown',
                image: imgEl ? imgEl.content : null
            };
        });

        if (!lyrics) return null;

        return {
            text: lyrics,
            title: meta.title, // Берем реальное название с сайта
            artist: artist,    // Артиста оставляем нашего (для простоты)
            image: meta.image,
            url: songUrl
        };

    } catch (e) {
        console.error(`[Lyrics] Puppeteer Error: ${e.message}`);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}
