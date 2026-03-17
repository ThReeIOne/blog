import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypePrettyCode from "rehype-pretty-code";
import type { PostMeta, Post } from "@/types/post";

const postsDirectory = path.join(process.cwd(), "content/posts");

/**
 * Calculate reading time based on content.
 * Chinese: ~300 chars/min, English: ~200 words/min.
 */
function calculateReadingTime(text: string): number {
  // Count Chinese characters
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  // Count English words (sequences of latin letters)
  const englishWords = (
    text.replace(/[\u4e00-\u9fff]/g, "").match(/[a-zA-Z]+/g) || []
  ).length;

  const minutes = chineseChars / 300 + englishWords / 200;
  return Math.max(1, Math.ceil(minutes));
}

export function getAllPostMetas(): PostMeta[] {
  const files = fs
    .readdirSync(postsDirectory)
    .filter((f) => f.endsWith(".md"));

  const posts = files.map((filename) => {
    const slug = filename.replace(/\.md$/, "");
    const filePath = path.join(postsDirectory, filename);
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(fileContent);

    return {
      slug,
      title: data.title ?? slug,
      date: data.date ?? "1970-01-01",
      summary: data.summary ?? "",
      tags: data.tags ?? [],
      cover: data.cover ?? undefined,
      readingTime: calculateReadingTime(content),
    } satisfies PostMeta;
  });

  return posts.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const filePath = path.join(postsDirectory, `${slug}.md`);

  if (!fs.existsSync(filePath)) return null;

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const { data, content: rawContent } = matter(fileContent);

  const result = await unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypePrettyCode, { theme: "github-dark-default" })
    .use(rehypeStringify)
    .process(rawContent);

  return {
    slug,
    title: data.title ?? slug,
    date: data.date ?? "1970-01-01",
    summary: data.summary ?? "",
    tags: data.tags ?? [],
    cover: data.cover ?? undefined,
    readingTime: calculateReadingTime(rawContent),
    content: String(result),
  };
}

export function getAllTags(): { tag: string; count: number }[] {
  const posts = getAllPostMetas();
  const tagMap = new Map<string, number>();

  for (const post of posts) {
    for (const tag of post.tags) {
      tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
    }
  }

  return Array.from(tagMap.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

export function getPostsByTag(tag: string): PostMeta[] {
  return getAllPostMetas().filter((post) => post.tags.includes(tag));
}

export function getAllSlugs(): string[] {
  return fs
    .readdirSync(postsDirectory)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
