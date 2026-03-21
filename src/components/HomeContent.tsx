"use client";
import { useState } from "react";
import { PostCard } from "./PostCard";
import type { PostMeta } from "@/types/post";

const PAGE_SIZE = 5;

export function HomeContent({ posts }: { posts: PostMeta[] }) {
  const sorted = [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const [page, setPage] = useState(1);

  const pagePosts = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <main className="mx-auto max-w-2xl px-6 py-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight mb-1">文章</h1>
        <p className="text-sm text-muted-foreground">
          一些认真写的东西，踩过坑才写。共 {sorted.length} 篇
        </p>
      </div>

      <section>
        <div>
          {pagePosts.map((post, i) => (
            <PostCard
              key={post.slug}
              post={post}
              featured={i === 0 && page === 1}
            />
          ))}
        </div>
        {sorted.length === 0 && (
          <p className="text-muted-foreground py-8 text-center">暂无文章</p>
        )}
      </section>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="mt-10 flex items-center justify-center gap-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-md text-sm border border-card-border hover:border-foreground/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ← 上一页
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={`w-8 h-8 rounded-md text-sm transition-colors ${
                p === page
                  ? "bg-foreground text-background font-medium"
                  : "border border-card-border hover:border-foreground/30"
              }`}
            >
              {p}
            </button>
          ))}

          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded-md text-sm border border-card-border hover:border-foreground/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            下一页 →
          </button>
        </div>
      )}

      {/* 页码提示 */}
      {totalPages > 1 && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          第 {page} / {totalPages} 页
        </p>
      )}
    </main>
  );
}
