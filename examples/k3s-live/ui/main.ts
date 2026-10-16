import { createApp } from "vue";
import App from "./App.vue";
import { parseArchive } from "./archive";
import type { RunArchive } from "./types";
import "./style.css";

const embedded = document.getElementById("mas-demo-archive");
let archive: RunArchive | undefined;
let archiveError: string | undefined;
if (embedded) {
  try {
    if (embedded.getAttribute("type") !== "application/json") throw new Error("Recorded run data has an unsupported script type.");
    archive = parseArchive(embedded.textContent ?? "");
  } catch (error) {
    archiveError = error instanceof Error ? error.message : "Unable to read recorded run data.";
  }
}
createApp(App, { archive, archiveError, archiveRequested: Boolean(embedded) }).mount("#app");
