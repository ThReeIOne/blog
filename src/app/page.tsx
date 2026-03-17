import { getAllPostMetas } from "@/lib/posts";
import { HomeContent } from "@/components/HomeContent";

export default function HomePage() {
  const posts = getAllPostMetas();

  return <HomeContent posts={posts} />;
}
