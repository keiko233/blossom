import type React from "react";

import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { m } from "@/paraglide/messages";
import type { UserDetail } from "@/query/users";

function providerLabel(providerId: string): string {
  switch (providerId) {
    case "credential":
      return m.admin_users_accounts_credential();
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    default:
      return providerId;
  }
}

export interface UserAccountsProps {
  accounts: UserDetail["accounts"];
}

/** Sign-in methods linked to a user. Secrets are never sent to the client. */
export function UserAccounts({
  accounts,
}: UserAccountsProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">
        {m.admin_users_accounts_title()}
      </h2>
      {accounts.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {accounts.map((account) => (
            <li key={account.id}>
              <Badge size="lg" variant="outline">
                {providerLabel(account.providerId)}
                <span className="text-xs text-muted-foreground">
                  {m.admin_users_accounts_linked({
                    date: formatDate(account.createdAt),
                  })}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {m.admin_users_accounts_empty()}
        </div>
      )}
    </div>
  );
}
