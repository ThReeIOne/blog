import { getPostsByTag, getAllTags } from "@/lib/posts";
import { PostCard } from "@/components/PostCard";
import type { Metadata } from "next";

type Params = Promise<{ tag: string }>;

export async function generateStaticParams() {
  return getAllTags().map(({ tag }) => ({ tag }));
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { tag } = await params;
  const decoded = decodeURIComponent(tag);
  return { title: `标签: ${decoded}` };
}

export default async function TagPage({ params }: { params: Params }) {
  const { tag } = await params;
  const decoded = decodeURIComponent(tag);
  const posts = getPostsByTag(decoded);

  return (
    <section>
      <div className="mb-8">
        <span className="inline-block rounded-full bg-accent/10 px-4 py-1.5 text-sm font-medium text-accent">
          标签
        </span>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">{decoded}</h1>
        <p className="mt-2 text-muted-foreground">
          共 {posts.length} 篇文章
        </p>
      </div>
      {posts.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground">暂无文章</p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      )}
    </section>
  );
}
