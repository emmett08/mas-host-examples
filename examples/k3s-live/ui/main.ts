import { createApp } from "vue";
import App from "./App.vue";
import { parseArchive } from "./archive";
import { archiveRuns } from "./approach";
import { verifyRevisionDigests, verifySelectedOutput } from "../shared/revision.mjs";
import type { RunArchive } from "./types";
import "./style.css";

async function mount() {
  const embedded = document.getElementById("mas-demo-archive");
  let archive: RunArchive | undefined;
  let archiveError: string | undefined;
  if (embedded) {
    try {
      if (embedded.getAttribute("type") !== "application/json") throw new Error("Recorded run data has an unsupported script type.");
      archive = parseArchive(embedded.textContent ?? "");
      for (const recording of archiveRuns(archive)) {
        const audit = recording.snapshots.at(-1)?.run.revision;
        if (audit) {
          await verifyRevisionDigests(audit);
          const output = recording.snapshots.at(-1)?.run.output;
          if (output !== undefined) await verifySelectedOutput(audit, output);
        }
      }
    } catch (error) {
      archive = undefined;
      archiveError = error instanceof Error ? error.message : "Unable to read recorded run data.";
    }
  }
  createApp(App, { archive, archiveError, archiveRequested: Boolean(embedded) }).mount("#app");
}
void mount();
