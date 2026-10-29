import { toCsv } from "@/lib/csv";

export const REDEEM_CODES_CSV_COLUMNS = ["code", "batch"] as const;

/**
 * CSV of freshly generated plaintext codes, for the one-time reveal dialog.
 * Built in the browser from the server response; nothing here is persisted.
 */
export function redeemCodesToCsv(
  codes: readonly string[],
  batchName: string,
): string {
  return toCsv(
    REDEEM_CODES_CSV_COLUMNS,
    codes.map((code) => [code, batchName]),
  );
}

export interface RedemptionCsvRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  codePrefix: string;
  subscriptionId: string | null;
  createdAt: Date;
}

export const REDEMPTION_CSV_COLUMNS = [
  "id",
  "user_id",
  "user_name",
  "user_email",
  "code_prefix",
  "subscription_id",
  "redeemed_at",
] as const;

/** CSV text for the admin redemptions export. Codes appear as prefix only. */
export function redemptionsToCsv(rows: readonly RedemptionCsvRow[]): string {
  return toCsv(
    REDEMPTION_CSV_COLUMNS,
    rows.map((row) => [
      row.id,
      row.userId,
      row.userName,
      row.userEmail,
      row.codePrefix,
      row.subscriptionId,
      row.createdAt,
    ]),
  );
}
