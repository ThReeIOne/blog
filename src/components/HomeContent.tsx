"use client";
import Link from "next/link";
import { PostCard } from "./PostCard";
import type { PostMeta } from "@/types/post";

export function HomeContent({ posts }: { posts: PostMeta[] }) {
  const sorted = [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          文章
        </h2>
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
