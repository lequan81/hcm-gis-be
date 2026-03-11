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
  // Using standard hyphenated date and colon time for readable log lines
  const now = new Date();
  const d = now.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
  const t = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
  const line = `[${d} ${t}] [${level}] ${msg}`;
  
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch (err: any) {
    console.error(`Failed to write log to ${logFile}: ${err.message}`);
  }
}
