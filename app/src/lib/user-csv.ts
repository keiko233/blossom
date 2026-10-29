import { toCsv } from "@/lib/csv";

export interface UserCsvRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string | null;
  banned: boolean | null;
  banReason: string | null;
  banExpires: Date | null;
  subscriptionCount: number;
  createdAt: Date;
}

export const USER_CSV_COLUMNS = [
  "id",
  "name",
  "email",
  "email_verified",
  "role",
  "banned",
  "ban_reason",
  "ban_expires",
  "subscription_count",
  "created_at",
] as const;

/** CSV text for the admin export. Never includes credentials or sessions. */
export function usersToCsv(rows: readonly UserCsvRow[]): string {
  return toCsv(
    USER_CSV_COLUMNS,
    rows.map((row) => [
      row.id,
      row.name,
      row.email,
      row.emailVerified,
      row.role ?? "user",
      Boolean(row.banned),
      row.banReason,
      row.banExpires,
      row.subscriptionCount,
      row.createdAt,
    ]),
  );
}
