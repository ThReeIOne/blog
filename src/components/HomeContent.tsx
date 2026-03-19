"use client";
import Link from "next/link";
import { PostCard } from "./PostCard";
import type { PostMeta } from "@/types/post";

export function HomeContent({ posts }: { posts: PostMeta[] }) {
  const sorted = [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-10">
        <h1 className="text-2xl font-bold tracking-tight mb-1">文章</h1>
        <p className="text-sm text-muted-foreground">一些认真写的东西，踩过坑才写。</p>
      </div>
      <section>
        <div>
          {sorted.map((post, i) => (
            <PostCard key={post.slug} post={post} featured={i === 0} />
          ))}
        </div>
        {posts.length === 0 && (
          <p className="text-muted-foreground py-8 text-center">暂无文章</p>
        )}
      </section>
    </main>
  );
}
