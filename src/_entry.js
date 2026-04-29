// Userscript entry point. Concatenated last by build.js; calls init() once
// the DOM is ready.
import { init } from "./ui.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => init());
} else {
  init();
}
