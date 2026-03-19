"use client";
import { useEffect, useRef } from "react";

// ── 1. Floating particles (sakura/snow) ──────────────────────────────────────
function createFloatingParticles(container: HTMLElement) {
  const count = 55;
  const emojis = ["✦", "✧", "⋆", "✺", "❄", "❅", "❆", "·", "◦", "✼"];

  for (let i = 0; i < count; i++) {
    const el = document.createElement("span");
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 0;
      font-size: ${Math.random() * 18 + 10}px;
      color: hsl(${Math.random() * 60 + 200}, 80%, 72%);
      left: ${Math.random() * 100}vw;
      top: ${Math.random() * 100}vh;
      opacity: ${Math.random() * 0.55 + 0.25};
      animation: floatDrift ${Math.random() * 14 + 10}s linear infinite;
      animation-delay: -${Math.random() * 14}s;
    `;
    container.appendChild(el);
  }
}

// ── 2. Trail effect (canvas) ─────────────────────────────────────────────────
interface TrailPoint {
  x: number;
  y: number;
  life: number;
  hue: number;
  size: number;
}

// ── 3. Firework click effect ─────────────────────────────────────────────────
function spawnFirework(x: number, y: number) {
  const count = 18;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("span");
    const angle = (i / count) * Math.PI * 2;
    const dist = Math.random() * 60 + 30;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const symbols = ["★", "✦", "✧", "✺", "⬟", "●"];
    el.textContent = symbols[Math.floor(Math.random() * symbols.length)];
    const hue = Math.random() * 360;
    el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 9999;
      left: ${x}px;
      top: ${y}px;
      font-size: ${Math.random() * 10 + 8}px;
      color: hsl(${hue}, 90%, 65%);
      transform: translate(-50%, -50%);
      transition: transform 0.6s ease-out, opacity 0.6s ease-out;
      opacity: 1;
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.3)`;
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), 700);
  }
}

export function MouseEffects() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const mouseRef = useRef({ x: -999, y: -999 });
  const hueRef = useRef(200);
  const rafRef = useRef<number>(0);
  const clickingRef = useRef(false);

  useEffect(() => {
    // Hide default cursor
    document.body.style.cursor = "none";

    // Floating particles container
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;";
    document.body.prepend(container);
    createFloatingParticles(container);

    // Canvas trail
    const canvas = canvasRef.current!;
    const cursor = cursorRef.current!;
    const ctx = canvas.getContext("2d")!;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    function onMouseMove(e: MouseEvent) {
      const x = e.clientX;
      const y = e.clientY;
      mouseRef.current = { x, y };

      // Move custom cursor
      cursor.style.left = x + "px";
      cursor.style.top = y + "px";

      hueRef.current = (hueRef.current + 1.5) % 360;
      trailRef.current.push({
        x,
        y,
        life: 1,
        hue: hueRef.current,
        size: Math.random() * 4 + 2,
      });
    }

    function onMouseDown(e: MouseEvent) {
      clickingRef.current = true;
      cursor.style.transform = "translate(-50%, -50%) scale(0.6)";
      spawnFirework(e.clientX, e.clientY);
    }

    function onMouseUp() {
      clickingRef.current = false;
      cursor.style.transform = "translate(-50%, -50%) scale(1)";
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      trailRef.current = trailRef.current.filter((p) => p.life > 0.01);
      for (const p of trailRef.current) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 90%, 65%, ${p.life * 0.7})`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = `hsl(${p.hue}, 90%, 65%)`;
        ctx.fill();
        p.life -= 0.04;
        p.size += 0.1;
      }
      rafRef.current = requestAnimationFrame(draw);
    }
    draw();

    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      cancelAnimationFrame(rafRef.current);
      container.remove();
    };
  }, []);

  return (
    <>
      {/* Custom cursor circle */}
      <div
        ref={cursorRef}
        style={{
          position: "fixed",
          width: "20px",
          height: "20px",
          border: "2px solid hsl(200, 90%, 65%)",
          borderRadius: "50%",
          pointerEvents: "none",
          zIndex: 99999,
          transform: "translate(-50%, -50%) scale(1)",
          transition: "transform 0.15s ease, border-color 0.3s ease",
          mixBlendMode: "difference",
          left: "-100px",
          top: "-100px",
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 9998,
        }}
      />
    </>
  );
}
