import Link from "next/link";
import Image from "next/image";
import { TagBadge } from "./TagBadge";
import type { PostMeta } from "@/types/post";

const GRADIENTS = [
  "gradient-cover-1",
  "gradient-cover-2",
  "gradient-cover-3",
  "gradient-cover-4",
  "gradient-cover-5",
  "gradient-cover-6",
];

function getGradient(slug: string) {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = slug.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

export function PostCard({
  post,
  featured = false,
}: {
  post: PostMeta;
  featured?: boolean;
}) {
  return (
    <article
      className={`group relative overflow-hidden rounded-xl border border-card-border bg-card-bg transition-all duration-300 hover:-translate-y-1 hover:shadow-lg ${
        featured ? "md:grid md:grid-cols-2" : ""
      }`}
    >
      {/* Clickable overlay link */}
      <Link
        href={`/posts/${post.slug}`}
        className="absolute inset-0 z-0"
        aria-label={post.title}
      />

      {/* Cover image or gradient placeholder */}
      <div
        className={`relative overflow-hidden ${
          featured ? "aspect-[16/9] md:aspect-auto md:min-h-full" : "aspect-[16/9]"
        }`}
      >
        {post.cover ? (
          <Image
            src={post.cover}
            alt={post.title}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div
            className={`h-full w-full ${getGradient(post.slug)} transition-transform duration-500 group-hover:scale-105`}
          />
        )}
      </div>

      {/* Content */}
      <div className={`p-5 ${featured ? "md:flex md:flex-col md:justify-center md:p-8" : ""}`}>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <time>{post.date}</time>
          <span className="inline-flex items-center gap-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z"
                clipRule="evenodd"
              />
            </svg>
            {post.readingTime} 分钟
          </span>
        </div>
        <h2
          className={`mt-2 font-bold leading-snug transition-colors group-hover:text-accent ${
            featured ? "text-2xl md:text-3xl" : "text-lg"
          }`}
        >
          {post.title}
        </h2>
        {post.summary && (
          <p
            className={`mt-2 text-muted-foreground ${
              featured ? "line-clamp-3" : "line-clamp-2 text-sm"
            }`}
          >
            {post.summary}
          </p>
        )}
        {post.tags.length > 0 && (
          <div className="relative z-10 mt-3 flex flex-wrap gap-2">
            {post.tags.map((tag) => (
              <TagBadge key={tag} tag={tag} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
