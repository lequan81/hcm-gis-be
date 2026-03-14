import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getVNDateParts } from "./date";
import { env } from "../config";

let logFile: string;

function initLogFile() {
  const logDir = process.env.LOG_DIR || env.LOG_DIR;
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  if (process.env.LOG_FILE) {
    logFile = process.env.LOG_FILE;
  } else {
    const { timestamp } = getVNDateParts();
    logFile = join(logDir, `app_${timestamp}.log`);
    process.env.LOG_FILE = logFile; // Share with workers
  }
}

export function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
  if (!logFile) initLogFile();

  const { date, time } = getVNDateParts();
  // date is YYYYMMDD, time is HHMMSS. Reformat for readability:
  const d = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const t = `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  const line = `[${d} ${t}] [${level}] ${msg}`;
  
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write log to ${logFile}: ${message}`);
  }
}
