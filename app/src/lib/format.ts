import { format as formatDateFns } from "date-fns";
import { filesize } from "filesize";
import ms from "ms";

export const BYTES_PER_GB = 1024 ** 3;

export function gbToBytes(gb: number): number {
  return Math.round(gb * BYTES_PER_GB);
}

export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}

/** KB/MB/GB/TB,1024 进制,千分位跟随系统 locale。 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 KB"; // filesize 对 0 强制输出 "0 B",特判保持旧输出
  return filesize(bytes, {
    base: 2,
    standard: "jedec",
    locale: true,
    exponent: bytes < 1024 ** 2 ? 1 : -1, // <1MB 恒显示 KB
    round: bytes < BYTES_PER_GB ? 1 : 2,
    output: "string",
  }) as string;
}

/** 只输出 GB/TB(流量套餐展示),1024 进制。 */
export function formatTraffic(bytes: number): string {
  if (bytes === 0) return "0 GB"; // 同上特判
  return filesize(bytes, {
    base: 2,
    standard: "jedec",
    locale: true,
    exponent: bytes >= 1024 ** 4 ? 4 : 3,
    round: 2,
    output: "string",
  }) as string;
}

export function formatDate(value: Date | string | number): string {
  return new Date(value).toLocaleDateString();
}

export function formatDateTime(value: Date | string | number): string {
  return new Date(value).toLocaleString();
}

/** <input type="datetime-local"> 的本地墙钟值。 */
export function toDatetimeLocalValue(date: Date): string {
  return formatDateFns(date, "yyyy-MM-dd'T'HH:mm");
}

/** "500ms"/"5s"/"3m"/"2h" 等 → 毫秒;无法解析返回 undefined。 */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    return undefined; // ms 对空串/非字符串会 throw
  }
  const n = ms(value as ms.StringValue);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function centsToAmount(cents: number): number {
  return cents / 100;
}

export function amountToCents(amount: number): number {
  return Math.round(amount * 100);
}

/** 展示用,等价 (cents/100).toFixed(2)。 */
export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
