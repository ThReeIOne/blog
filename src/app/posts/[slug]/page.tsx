import { notFound } from "next/navigation";
import Image from "next/image";
import { getPostBySlug, getAllSlugs } from "@/lib/posts";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { TagBadge } from "@/components/TagBadge";
import { TwikooComments } from "@/components/TwikooComments";
import type { Metadata } from "next";

type Params = Promise<{ slug: string }>;

export async function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return {};

  return {
    title: post.title,
    description: post.summary,
    openGraph: {
      title: post.title,
      description: post.summary,
      type: "article",
      publishedTime: post.date,
      ...(post.cover ? { images: [{ url: post.cover }] } : {}),
    },
  };
}

export default async function PostPage({ params }: { params: Params }) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);

  if (!post) notFound();

  return (
    <article className="mx-auto max-w-3xl">
      {/* Cover image */}
      {post.cover && (
        <div className="relative mb-8 aspect-[2/1] overflow-hidden rounded-xl">
          <Image
            src={post.cover}
            alt={post.title}
            fill
            className="object-cover"
            priority
          />
        </div>
      )}

      <header className="mb-8">
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
            {post.readingTime} 分钟阅读
          </span>
        </div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
          {post.title}
        </h1>
        {post.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {post.tags.map((tag) => (
              <TagBadge key={tag} tag={tag} />
            ))}
          </div>
        )}
      </header>
      <MarkdownRenderer content={post.content} />
      <TwikooComments />
    </article>
  );
}
