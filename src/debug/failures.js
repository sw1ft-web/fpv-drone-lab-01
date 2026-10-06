import { fetchJson } from "../assets/http.js";
import { loadImage } from "../assets/loader.js";

export function installFailureGallery(root) {
  const output = root.querySelector("#failureOutput");

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-failure]");
    if (!button) return;
    const kind = button.dataset.failure;
    output.textContent = `Running ${kind}…`;

    try {
      if (kind === "404") {
        await loadImage("/assets/sprites/does-not-exist.png", {
          attempts: 3,
          signal: AbortSignal.timeout(1500),
        });
      } else if (kind === "timeout") {
        await fetchJson("/api/slow?delay=2500", {
          signal: AbortSignal.timeout(250),
        });
      } else if (kind === "abort") {
        const controller = new AbortController();
        const request = fetchJson("/api/slow?delay=1800", {
          signal: controller.signal,
        });
        window.setTimeout(() => controller.abort(new DOMException("Manual abort", "AbortError")), 120);
        await request;
      } else if (kind === "json") {
        await fetchJson("/api/bad-json", { signal: AbortSignal.timeout(1200) });
      }
      output.textContent = `${kind}: unexpectedly completed`;
    } catch (error) {
      const safe = `${kind}: ${error.name}: ${error.message}`;
      output.textContent = `${safe}\nRecovered: app is still responsive; retry/start remains available.`;
      console.info(`[failure-gallery] ${safe}`);
    }
  });
}
