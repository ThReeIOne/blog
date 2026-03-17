export interface PostMeta {
  title: string;
  date: string;
  summary: string;
  tags: string[];
  slug: string;
  cover?: string;
  readingTime: number;
}

export interface Post extends PostMeta {
  content: string;
}
