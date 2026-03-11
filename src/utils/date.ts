export function getVNDateParts(): { date: string; time: string; timestamp: string } {
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { timeZone: "Asia/Ho_Chi_Minh", hour12: false };
  
  // Format to standard ISO-like strings in VN timezone
  const dateStr = now.toLocaleDateString("en-CA", opts).replace(/-/g, ""); // "YYYYMMDD"
  const timeStr = now.toLocaleTimeString("en-GB", opts).replace(/:/g, ""); // "HHMMSS"
  
  return { date: dateStr, time: timeStr, timestamp: `${dateStr}_${timeStr}` };
}
