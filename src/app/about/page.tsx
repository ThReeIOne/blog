import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { AUTHOR } from "@/lib/constants";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "关于",
};

async function getAboutContent(): Promise<string> {
  const filePath = path.join(process.cwd(), "content/about.md");
  const fileContent = fs.readFileSync(filePath, "utf-8");
  const { content } = matter(fileContent);

  const result = await unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(content);

  return String(result);
}

export default async function AboutPage() {
  const content = await getAboutContent();

  return (
    <section className="mx-auto max-w-3xl">
      {/* Avatar card */}
      <div className="mb-10 flex flex-col items-center rounded-xl border border-card-border bg-card-bg p-8 text-center sm:flex-row sm:gap-8 sm:text-left">
        <div className="mb-4 flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-purple-500 text-3xl font-bold text-white sm:mb-0">
          {AUTHOR.charAt(0).toUpperCase()}
        </div>
        <div>
          <h1 className="text-2xl font-bold">Shengli</h1>
          <p className="mt-1 text-muted-foreground">
            个人技术博客，记录编程、架构与思考
          </p>
        </div>
      </div>

      <MarkdownRenderer content={content} />
    </section>
  );
}
