import { appendFileSync } from "fs";
import { join } from "path";
import { env } from "./env";


// Helper to get local time in GMT+7 (Vietnam)

function getVNDateParts() {
  const now = new Date();
  // Use Asia/Ho_Chi_Minh for Vietnam local time
  const opts = { timeZone: 'Asia/Ho_Chi_Minh', hour12: false };
  const dateStr = now.toLocaleDateString('vi-VN', opts).split('/').reverse().map(s => s.padStart(2, '0')).join('-');
  const timeStr = now.toLocaleTimeString('vi-VN', opts).replace(/:/g, '');
  return { date: dateStr, time: timeStr };
}

const LOG_FILE = process.env.LOG_FILE || (() => {
  const { date, time } = getVNDateParts();
  return join(env.LOG_DIR, `app_${date}_${time}.log`);
})();
if (!process.env.LOG_FILE) process.env.LOG_FILE = LOG_FILE;

export function log(level: string, msg: string) {
  const { date, time } = getVNDateParts();
  const line = `[${date} ${time}] [${level}] ${msg}`;
  console.log(line);
  try {
    const logFile = process.env.LOG_FILE || LOG_FILE;
    appendFileSync(logFile, line + "\n");
  } catch { }
}
