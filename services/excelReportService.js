import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/generate_excel_report.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

function runPython(pythonExecutable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(pythonExecutable, args, options, (error, stdout, stderr) => {
      if (error) {
        error.details = (stderr || stdout || error.message).trim();
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function removeExcelArtifacts(directory) {
  if (!directory) return;
  await fs.rm(directory, { recursive: true, force: true });
}

export async function generateExcelReport(data, {
  startDate = data?.startDate || 'start',
  endDate = data?.endDate || 'end',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER
} = {}) {
  const safeStartDate = String(startDate).replace(/[^0-9A-Za-z_-]/g, '_');
  const safeEndDate = String(endDate).replace(/[^0-9A-Za-z_-]/g, '_');
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'scloud-analytics-'));
  const jsonPath = path.join(tempDirectory, 'analytics.json');
  const xlsxPath = path.join(tempDirectory, `SCloudMusic_Analytics_${safeStartDate}_${safeEndDate}.xlsx`);
  const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';

  try {
    await fs.writeFile(jsonPath, JSON.stringify(data), 'utf8');
    const processResult = await runPython(
      pythonExecutable,
      [SCRIPT_PATH, jsonPath, xlsxPath],
      {
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        shell: false
      }
    );

    const xlsxStat = await fs.stat(xlsxPath);
    if (!xlsxStat.isFile() || xlsxStat.size === 0) {
      throw new Error('Python completed without producing a non-empty XLSX file.');
    }

    return {
      directory: tempDirectory,
      xlsxPath,
      size: xlsxStat.size,
      stdout: processResult.stdout.trim(),
      cleanup: () => removeExcelArtifacts(tempDirectory)
    };
  } catch (error) {
    await removeExcelArtifacts(tempDirectory).catch(() => {});
    throw error;
  }
}
