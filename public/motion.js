/**
 * motion.js — a tiny, dependency-free motion helper with a Framer-Motion-style
 * API, built on the Web Animations API. No React, no bundler, offline-safe.
 * (Motion One is the literal vanilla port of Framer Motion if you ever want the
 * real library — this covers the same feel: spring entrances, stagger, count-up.)
 *
 * Everything respects prefers-reduced-motion: with it on, animations are skipped
 * and elements simply appear in their final state.
 */
(function () {
  const reduce = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Easings — a smooth "out" for entrances and a gentle overshoot "spring" for pops.
  const OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
  const SPRING = "cubic-bezier(0.34, 1.4, 0.5, 1)";

  function enter(el, opts = {}) {
    if (!el || reduce()) return;
    const { y = 10, x = 0, dur = 420, delay = 0, scale = 1 } = opts;
    el.animate(
      [
        { opacity: 0, transform: `translate(${x}px, ${y}px) scale(${scale === 1 ? 0.985 : scale})` },
        { opacity: 1, transform: "translate(0,0) scale(1)" },
      ],
      { duration: dur, delay, easing: OUT, fill: "both" },
    );
  }

  function stagger(list, opts = {}) {
    if (reduce()) return;
    const { step = 45, ...rest } = opts;
    [...list].forEach((el, i) => enter(el, { ...rest, delay: (rest.delay || 0) + i * step }));
  }

  /** Cascade the main blocks of a freshly-rendered view in, in document order. */
  function reveal(root) {
    if (!root || reduce()) return;
    const blocks = root.querySelectorAll(".view-head, .tile, .panel, .empty, .live-card, .setup");
    stagger(blocks, { y: 12, step: 40, dur: 440 });
  }

  /** A quick spring "pop" — for badges, toggles, toasts. */
  function pop(el) {
    if (!el || reduce()) return;
    el.animate([{ transform: "scale(0.6)", opacity: 0.4 }, { transform: "scale(1)", opacity: 1 }], {
      duration: 340,
      easing: SPRING,
      fill: "both",
    });
  }

  /** Animate a number from 0 → `to`, writing `prefix + value(decimals) + suffix`. */
  function countUp(el, to, opts = {}) {
    const { dur = 850, decimals = 0, suffix = "", prefix = "" } = opts;
    const write = (v) => (el.textContent = prefix + v.toFixed(decimals) + suffix);
    if (!isFinite(to)) return;
    if (reduce() || to === 0) return write(to);
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    function frame(now) {
      const p = Math.min(1, (now - start) / dur);
      write(to * ease(p));
      if (p < 1) requestAnimationFrame(frame);
      else write(to);
    }
    requestAnimationFrame(frame);
  }

  /** Count up every [data-count] element under root (declarative KPI animation). */
  function countUpAll(root) {
    if (!root) return;
    root.querySelectorAll("[data-count]").forEach((el) =>
      countUp(el, parseFloat(el.dataset.count), {
        decimals: Number(el.dataset.decimals || 0),
        suffix: el.dataset.suffix || "",
        prefix: el.dataset.prefix || "",
      }),
    );
  }

  window.RM = { reduce, enter, stagger, reveal, pop, countUp, countUpAll, OUT, SPRING };
})();
