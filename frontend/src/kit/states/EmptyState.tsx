import type { ReactNode } from "react";

/** A successful zero-row response. Always offers a next step (`action`) when the user has one. */
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div data-screen-state="empty" className="flex flex-col items-start gap-2 rounded-lg border bg-card p-6">
      <p className="text-section font-semibold">{title}</p>
      {body ? <p className="text-muted-foreground">{body}</p> : null}
      {action}
    </div>
  );
}
