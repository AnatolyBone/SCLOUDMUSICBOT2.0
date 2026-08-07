import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function removeTempPath(targetPath) {
  if (!targetPath) return false;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.warn(`[TempStorage] Cannot remove ${targetPath}: ${error.message}`);
    return false;
  }
}

export function removeTempArtifacts(directory, prefix) {
  if (!directory || !prefix || !fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith(prefix) && removeTempPath(path.join(directory, name))) removed++;
  }
  return removed;
}

function listEntries(directory) {
  if (!fs.existsSync(directory)) return [];
  const entries = [];
  for (const name of fs.readdirSync(directory)) {
    const fullPath = path.join(directory, name);
    try {
      const stats = fs.statSync(fullPath);
      const size = stats.isDirectory()
        ? listEntries(fullPath).reduce((sum, entry) => sum + entry.size, 0)
        : stats.size;
      entries.push({ fullPath, mtimeMs: stats.mtimeMs, size });
    } catch (_) {}
  }
  return entries;
}

export function cleanupTempDirectory(directory, options = {}) {
  const maxAgeMs = positiveNumber(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
  const maxBytes = positiveNumber(options.maxBytes, DEFAULT_MAX_BYTES);
  const now = options.now || Date.now();
  fs.mkdirSync(directory, { recursive: true });
  let entries = listEntries(directory);
  let removed = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (now - entry.mtimeMs <= maxAgeMs) continue;
    if (removeTempPath(entry.fullPath)) {
      removed++;
      freedBytes += entry.size;
    }
  }

  entries = listEntries(directory).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    // A recent entry can belong to an active download and is never evicted here.
    if (now - entry.mtimeMs <= maxAgeMs) continue;
    if (removeTempPath(entry.fullPath)) {
      removed++;
      freedBytes += entry.size;
      totalBytes -= entry.size;
    }
  }
  return { removed, freedBytes, totalBytes };
}

export function assertTempCapacity(directory, maxBytes = DEFAULT_MAX_BYTES) {
  const limit = positiveNumber(maxBytes, DEFAULT_MAX_BYTES);
  const totalBytes = listEntries(directory).reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes >= limit) {
    const error = new Error('TEMP_STORAGE_LIMIT');
    error.code = 'TEMP_STORAGE_LIMIT';
    error.totalBytes = totalBytes;
    error.maxBytes = limit;
    throw error;
  }
  return totalBytes;
}

export function startTempDirectoryJanitor(directory, options = {}) {
  const intervalMs = positiveNumber(options.intervalMs, 10 * 60 * 1000);
  const run = () => {
    try {
      const result = cleanupTempDirectory(directory, options);
      if (result.removed > 0) {
        console.log(`[TempStorage] Removed ${result.removed} entries from ${directory}, freed ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB`);
      }
    } catch (error) {
      console.warn(`[TempStorage] Cleanup failed for ${directory}: ${error.message}`);
    }
  };
  if (options.startupMaxAgeMs !== undefined) {
    try {
      cleanupTempDirectory(directory, { ...options, maxAgeMs: options.startupMaxAgeMs });
    } catch (error) {
      console.warn(`[TempStorage] Startup cleanup failed for ${directory}: ${error.message}`);
    }
  } else {
    run();
  }
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
