import { AUTHOR } from "@/lib/constants";

export function Footer() {
  return (
    <footer className="border-t border-card-border">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-sm text-muted-foreground">
        <div className="flex flex-col gap-1">
          <span>
            &copy; {new Date().getFullYear()} {AUTHOR}. All rights reserved.
          </span>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-accent"
          >
            晋ICP备2025027315号
          </a>
        </div>
        <a
          href="/feed.xml"
          className="flex items-center gap-1.5 transition-colors hover:text-accent"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path d="M3.75 3a.75.75 0 0 0-.75.75v.5c0 9.113 7.387 16.5 16.5 16.5h.5a.75.75 0 0 0 0-1.5h-.5C10.964 19.25 5.25 13.536 5.25 7.25v-.5A.75.75 0 0 0 4.5 6h-.75Zm0 6a.75.75 0 0 0-.75.75v.5a10.5 10.5 0 0 0 10.5 10.5h.5a.75.75 0 0 0 0-1.5h-.5a9 9 0 0 1-9-9v-.5A.75.75 0 0 0 3.75 9ZM6 18.75a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
          </svg>
          RSS
        </a>
      </div>
    </footer>
  );
}
