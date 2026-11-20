import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const uploadStep = "Deploy only the prebuilt artifact";
const fingerprintPath = "viewer-deploy-fingerprint.json";
const validFingerprint = (value) => /^[a-f0-9]{64}$/.test(value || "");

// A previous commit is not evidence that its artifact reached production: its
// run may have been canceled, failed, or skipped. Consult upload receipts instead.
export async function decideViewerDeployment({ eventName, current, repository, api }) {
  if (!validFingerprint(current)) throw new Error("Invalid current viewer fingerprint.");
  if (eventName === "workflow_dispatch") return { deploy: true, reason: "Explicit production rerun." };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("Invalid GitHub repository.");
  try {
    const prefix = `repos/${repository}`;
    const response = await api(`${prefix}/actions/workflows/deploy-viewer.yml/runs?branch=main&status=completed&per_page=100`);
    const runs = response.workflow_runs;
    if (!Array.isArray(runs)) throw new Error("Missing run history.");
    // Bounded history lookup; a missing receipt costs an extra deployment,
    // never a false assertion that production already has the artifact.
    // A rerun of an older commit may be the most recent production change.
    runs.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    for (const run of runs.slice(0, 25)) {
      if (run.head_branch !== "main" || run.status !== "completed"
          || !/^[a-f0-9]{40}$/.test(run.head_sha || "") || !Number.isSafeInteger(run.id) || !Number.isFinite(Date.parse(run.updated_at))) {
        throw new Error("Unverifiable run history.");
      }
      const response = await api(`${prefix}/actions/runs/${run.id}/jobs?filter=all&per_page=100`);
      if (!Array.isArray(response.jobs) || response.total_count > response.jobs.length) {
        throw new Error("Incomplete job history.");
      }
      const uploads = response.jobs.flatMap((job) => (job.steps || []).filter((step) => step.name === uploadStep));
      const executed = uploads.filter((step) => !["skipped", null, undefined].includes(step.conclusion));
      if (!executed.length) continue;
      if (executed.length !== 1 || executed[0].conclusion !== "success") {
        return { deploy: true, reason: "The most recent upload attempt has no successful receipt." };
      }
      const file = await api(`${prefix}/contents/${fingerprintPath}?ref=${run.head_sha}`);
      if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error("Missing deployed fingerprint.");
      const previous = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).sha256;
      if (!validFingerprint(previous)) throw new Error("Invalid deployed fingerprint.");
      return {
        deploy: current !== previous,
        reason: current === previous
          ? `Artifact matches successful production upload in run ${run.id}.`
          : `Artifact differs from successful production upload in run ${run.id}.`,
        receiptRunId: run.id,
        receiptSha: run.head_sha,
      };
    }
    return { deploy: true, reason: "No verified production upload found within the bounded history." };
  } catch {
    return { deploy: true, reason: "Production upload history could not be verified; deploy conservatively." };
  }
}

async function main() {
  const decision = await decideViewerDeployment({
    eventName: process.env.GITHUB_EVENT_NAME,
    current: JSON.parse(fs.readFileSync(fingerprintPath, "utf8")).sha256,
    repository: process.env.GITHUB_REPOSITORY,
    api: (route) => JSON.parse(execFileSync("gh", ["api", route], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    })),
  });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${decision.deploy}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${decision.reason}\n`);
  console.log(JSON.stringify(decision));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Unable to decide viewer publication."); process.exitCode = 1; });
}
