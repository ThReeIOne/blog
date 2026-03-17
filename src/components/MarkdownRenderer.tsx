export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div
      className="prose prose-lg prose-gray max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-accent prose-pre:p-0"
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}
