"use client";

import Link from "next/link";

export function TagBadge({ tag }: { tag: string }) {
  return (
    <Link
      href={`/tags/${encodeURIComponent(tag)}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-block rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
    >
      {tag}
    </Link>
  );
}
