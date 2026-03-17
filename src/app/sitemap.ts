import type { MetadataRoute } from "next";
import { getAllSlugs, getAllTags } from "@/lib/posts";
import { SITE_URL } from "@/lib/constants";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllSlugs().map((slug) => ({
    url: `${SITE_URL}/posts/${slug}`,
    lastModified: new Date(),
  }));

  const tags = getAllTags().map(({ tag }) => ({
    url: `${SITE_URL}/tags/${encodeURIComponent(tag)}`,
    lastModified: new Date(),
  }));

  return [
    { url: SITE_URL, lastModified: new Date() },
    { url: `${SITE_URL}/tags`, lastModified: new Date() },
    { url: `${SITE_URL}/about`, lastModified: new Date() },
    ...posts,
    ...tags,
  ];
}
