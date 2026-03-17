import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="relative">
        <span className="text-[10rem] font-black leading-none text-muted/60">
          404
        </span>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl bg-card-bg px-6 py-3 shadow-lg border border-card-border">
            <p className="text-lg font-medium">页面未找到</p>
          </div>
        </div>
      </div>
      <p className="mt-6 max-w-md text-muted-foreground">
        你访问的页面不存在或已被移除，请检查链接是否正确。
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
        >
          <path
            fillRule="evenodd"
            d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
            clipRule="evenodd"
          />
        </svg>
        返回首页
      </Link>
    </div>
  );
}
