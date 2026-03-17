"use client";

import { useEffect, useRef } from "react";

const TWIKOO_ENV_ID = process.env.NEXT_PUBLIC_TWIKOO_ENV_ID ?? "";

export function TwikooComments() {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!TWIKOO_ENV_ID || initialized.current || !containerRef.current) return;
    initialized.current = true;

    import("twikoo").then((twikoo) => {
      twikoo.init({
        envId: TWIKOO_ENV_ID,
        el: containerRef.current,
      });
    });
  }, []);

  if (!TWIKOO_ENV_ID) return null;

  return (
    <section className="mt-16 border-t border-card-border pt-10">
      <h2 className="mb-6 text-xl font-bold">评论</h2>
      <div ref={containerRef} />
    </section>
  );
}
