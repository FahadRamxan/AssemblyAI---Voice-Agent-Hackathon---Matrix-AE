/**
 * Raabta Live — embeddable widget loader.
 *
 * One line on any site:
 *   <script src="https://YOUR_HOST/embed.js" data-agent-key="pk_live_xxx" async></script>
 *
 * Mounts a floating "Talk" button that opens the voice agent bound to the
 * publishable key, in an iframe pointed at the host's own widget page (so the
 * mic + WebSocket run on the Raabta origin, and the key is all the customer's
 * page ever holds).
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute("data-agent-key");
  if (!key) {
    console.error("[raabta] embed.js: missing data-agent-key");
    return;
  }
  var origin = new URL(script.src, location.href).origin;
  var position = script.getAttribute("data-position") || "bottom-right"; // or bottom-left
  var label = script.getAttribute("data-label") || "Talk to us";
  var accent = script.getAttribute("data-accent") || "#2dd4bf";

  if (document.getElementById("raabta-embed-root")) return; // mount once

  var root = document.createElement("div");
  root.id = "raabta-embed-root";
  var side = position === "bottom-left" ? "left:20px;" : "right:20px;";

  var launcher = document.createElement("button");
  launcher.type = "button";
  launcher.setAttribute("aria-label", label);
  launcher.innerHTML =
    '<span style="font-size:18px;line-height:1">🎙️</span><span>' + escapeHtml(label) + "</span>";
  launcher.style.cssText =
    "position:fixed;bottom:20px;" +
    side +
    "z-index:2147483000;display:flex;align-items:center;gap:8px;" +
    "padding:12px 18px;border:none;border-radius:999px;cursor:pointer;" +
    "background:" +
    accent +
    ";color:#04120f;font:600 15px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.35);transition:transform .15s ease";
  launcher.onmouseenter = function () {
    launcher.style.transform = "translateY(-2px)";
  };
  launcher.onmouseleave = function () {
    launcher.style.transform = "none";
  };

  var frame = document.createElement("iframe");
  frame.title = "Raabta Live voice agent";
  frame.allow = "microphone";
  frame.src = origin + "/widget?key=" + encodeURIComponent(key);
  frame.style.cssText =
    "position:fixed;bottom:88px;" +
    side +
    "z-index:2147483000;width:380px;height:600px;max-width:calc(100vw - 32px);" +
    "max-height:calc(100vh - 120px);border:none;border-radius:16px;display:none;" +
    "box-shadow:0 20px 60px rgba(0,0,0,.5);background:#0a0e14";

  var open = false;
  launcher.addEventListener("click", function () {
    open = !open;
    frame.style.display = open ? "block" : "none";
    launcher.style.opacity = open ? "0.85" : "1";
  });

  root.appendChild(frame);
  root.appendChild(launcher);
  (document.body || document.documentElement).appendChild(root);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
