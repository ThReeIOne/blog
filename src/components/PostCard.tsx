"use client";
import Link from "next/link";
import { TagBadge } from "./TagBadge";
import type { PostMeta } from "@/types/post";

export function PostCard({
  post,
  featured = false,
}: {
  post: PostMeta;
  featured?: boolean;
}) {
  return (
    <article className={`group ${featured ? "mb-12" : ""}`}>
      <Link href={`/posts/${post.slug}`} className="block space-y-2 py-5 border-b border-card-border hover:border-foreground/20 transition-colors duration-200">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <time>{post.date}</time>
          {featured && (
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
              精选
            </span>
          )}
        </div>
        <h2 className={`font-semibold tracking-tight transition-colors group-hover:text-muted-foreground ${featured ? "text-2xl" : "text-lg"}`}>
          {post.title}
        </h2>
        {post.summary && (
          <p className="text-muted-foreground text-sm leading-relaxed line-clamp-2">
            {post.summary}
          </p>
        )}
        {post.tags && post.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {post.tags.map((tag) => (
              <TagBadge key={tag} tag={tag} />
            ))}
          </div>
        )}
      </Link>
    </article>
  );
}
