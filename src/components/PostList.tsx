import { PostCard } from "./PostCard";
import type { PostMeta } from "@/types/post";

export function PostList({ posts }: { posts: PostMeta[] }) {
  if (posts.length === 0) {
    return (
      <p className="py-10 text-center text-muted-foreground">暂无文章</p>
    );
  }

  const [first, ...rest] = posts;

  return (
    <div className="space-y-8">
      {/* Hero featured card */}
      <PostCard post={first} featured />

      {/* Grid for remaining posts */}
      {rest.length > 0 && (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {rest.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
