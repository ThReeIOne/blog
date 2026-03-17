"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SITE_NAME } from "@/lib/constants";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-all duration-300 ${
        scrolled
          ? "header-blur border-card-border shadow-sm"
          : "border-transparent bg-background"
      }`}
    >
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-lg font-bold tracking-tight">
          {SITE_NAME}
        </Link>
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            文章
          </Link>
          <Link
            href="/tags"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            标签
          </Link>
          <Link
            href="/about"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            关于
          </Link>
          <Link
            href="/feed.xml"
            className="text-muted-foreground transition-colors hover:text-accent"
            title="RSS Feed"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M3.75 3a.75.75 0 0 0-.75.75v.5c0 9.113 7.387 16.5 16.5 16.5h.5a.75.75 0 0 0 0-1.5h-.5C10.964 19.25 5.25 13.536 5.25 7.25v-.5A.75.75 0 0 0 4.5 6h-.75Zm0 6a.75.75 0 0 0-.75.75v.5a10.5 10.5 0 0 0 10.5 10.5h.5a.75.75 0 0 0 0-1.5h-.5a9 9 0 0 1-9-9v-.5A.75.75 0 0 0 3.75 9ZM6 18.75a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
            </svg>
          </Link>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
