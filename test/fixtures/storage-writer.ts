import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CronStorage } from "../../src/storage.js";
import type { CronJob } from "../../src/types.js";

const [workerId, projectDir, barrierDir] = process.argv.slice(2);
if (!workerId || !projectDir || !barrierDir) {
  throw new Error("usage: storage-writer <worker-id> <project-dir> <barrier-dir>");
}

function job(id: string): CronJob {
  return {
    id,
    name: id,
    schedule: "0 0 9 * * *",
    prompt: `prompt for ${id}`,
    enabled: true,
    type: "cron",
    createdAt: new Date().toISOString(),
    runCount: 0,
  };
}

async function main(): Promise<void> {
  writeFileSync(join(barrierDir, `${workerId}.ready`), "ready");
  while (!existsSync(join(barrierDir, "go"))) await delay(5);

  const storage = new CronStorage(projectDir);
  for (let index = 0; index < 200; index++) {
    storage.addJob(job(`${workerId}-job-${index}`));
  }
  if (!storage.updateJob(`toggle-${workerId}`, { enabled: false, lastStatus: "success" })) {
    throw new Error(`missing toggle-${workerId}`);
  }
  for (let index = 0; index < 200; index++) {
    if (!storage.incrementRunCount("counter")) throw new Error("missing counter");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
