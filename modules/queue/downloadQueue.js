const globalQueue = [];
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 3;

export function enqueue(ctx, userId, url) {
  return new Promise((resolve, reject) => {
    globalQueue.push({ ctx, userId, url, resolve, reject });
    processNextInQueue();
  });
}

export async function processNextInQueue() {
  if (globalQueue.length === 0 || activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return;
  }

  activeDownloads++;
  const { ctx, userId, url, resolve, reject } = globalQueue.shift();

  try {
    await ctx.reply(`⏳ Трек добавлен в очередь (#${globalQueue.length + 1})`);
    // Здесь должна быть логика обработки трека, которая была в index.js
    // Например, вызов processTrackByUrl(ctx, userId, url);
    resolve();
  } catch (error) {
    reject(error);
  } finally {
    activeDownloads--;
    processNextInQueue();
  }
}
