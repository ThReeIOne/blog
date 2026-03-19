import Link from "next/link";
import { getAllTags } from "@/lib/posts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "标签",
};

export default function TagsPage() {
  const tags = getAllTags();

  return (
    <section>
      <h1 className="text-3xl font-bold tracking-tight">标签</h1>
      {tags.length === 0 ? (
        <p className="mt-8 text-muted-foreground">暂无标签</p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tags.map(({ tag, count }) => (
            <Link
              key={tag}
              href={`/tags/${encodeURIComponent(tag)}`}
              className="group flex items-center justify-between rounded-xl border border-card-border bg-card-bg p-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg"
            >
              <span className="text-lg font-semibold transition-colors group-hover:text-accent">
                {tag}
              </span>
              <span className="rounded-full border border-card-border bg-muted px-3 py-1 text-sm font-medium text-foreground">
                {count} 篇
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
