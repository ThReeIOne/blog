"use client";

import Link from "next/link";

export function TagBadge({ tag }: { tag: string }) {
  return (
    <Link
      href={`/tags/${encodeURIComponent(tag)}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-block rounded-full border border-card-border bg-muted px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-card-border"
    >
      {tag}
    </Link>
  );
}
