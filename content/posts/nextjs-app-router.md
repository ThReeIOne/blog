---
title: "Next.js App Router 入门指南"
date: "2026-03-15"
summary: "深入了解 Next.js App Router 的核心概念：Server Components、布局嵌套与数据获取。"
tags: ["Next.js", "React"]
---

## App Router 是什么

Next.js 13 引入了全新的 App Router，基于 React Server Components 构建。相比传统的 Pages Router，它带来了更灵活的布局系统和更好的性能。

## 核心概念

### Server Components

默认情况下，App Router 中的组件都是 Server Components，在服务端渲染：

```tsx
// 这是一个 Server Component — 无需 "use client"
export default async function PostPage() {
  const posts = await fetchPosts();
  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}
```

### 布局嵌套

通过 `layout.tsx` 文件可以创建嵌套布局，子路由共享父级布局：

```
app/
├── layout.tsx        # 根布局
├── page.tsx          # 首页
└── posts/
    ├── layout.tsx    # 文章布局
    └── [slug]/
        └── page.tsx  # 文章详情
```

### 静态生成

使用 `generateStaticParams` 可以在构建时生成静态页面：

```typescript
export async function generateStaticParams() {
  const slugs = getAllSlugs();
  return slugs.map((slug) => ({ slug }));
}
```

## 总结

App Router 是 Next.js 的未来方向，值得深入学习和使用。
