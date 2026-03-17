"use client";

import { useState } from "react";
import { PostCard } from "./PostCard";
import { PostList } from "./PostList";
import type { PostMeta } from "@/types/post";

export function HomeContent({ posts }: { posts: PostMeta[] }) {
  const [query, setQuery] = useState("");

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? posts.filter(
        (p) =>
          p.title.toLowerCase().includes(trimmed) ||
          p.summary.toLowerCase().includes(trimmed)
      )
    : [];

  return (
    <section>
      {/* Search */}
      <div className="relative mb-8">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
            clipRule="evenodd"
          />
        </svg>
        <input
          type="text"
          placeholder="搜索文章标题或摘要..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-xl border border-card-border bg-card-bg py-3 pl-12 pr-4 text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition-all"
        />
      </div>

      {/* Results or full list */}
      {trimmed ? (
        filtered.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </div>
        ) : (
          <p className="py-10 text-center text-muted-foreground">
            没有找到匹配的文章
          </p>
        )
      ) : (
        <PostList posts={posts} />
      )}
    </section>
  );
}
