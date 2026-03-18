"use client";
import Link from "next/link";
import { PostCard } from "./PostCard";
import type { PostMeta } from "@/types/post";

export function HomeContent({ posts }: { posts: PostMeta[] }) {
  const sorted = [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const featured = sorted[0];
  const rest = sorted.slice(1);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      {/* Hero */}
      <section className="mb-16">
        <h1 className="text-3xl font-bold tracking-tight mb-4">
          Hi, I'm Shengli 👋
        </h1>
        <p className="text-muted-foreground text-lg leading-relaxed mb-6">
          后端工程师，专注于 Go、分布式系统和可观测性。这里记录我在构建真实系统时的思考与踩坑。
        </p>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/ThReeIOne"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            GitHub
          </a>
          <span className="text-card-border">·</span>
          <a
            href="/feed.xml"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <path d="M3.75 3a.75.75 0 0 0-.75.75v.5c0 9.113 7.387 16.5 16.5 16.5h.5a.75.75 0 0 0 0-1.5h-.5C10.964 19.25 5.25 13.536 5.25 7.25v-.5A.75.75 0 0 0 3.75 3Zm.75 8.25a6 6 0 0 1 6 6 .75.75 0 0 0 1.5 0 7.5 7.5 0 0 0-7.5-7.5.75.75 0 0 0 0 1.5Zm0 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
            </svg>
            RSS
          </a>
        </div>
      </section>

      {/* Writing */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
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
