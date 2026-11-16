// Probe extension: records lifecycle events. With PROBE_SLOW_INPUT set, its
// input hook holds session.prompt() in preflight for 300ms.
import { fakeProviderConfig, probeLog } from "../../fake-provider.ts";

export default function (pi: any) {
  pi.registerProvider("fake", fakeProviderConfig);
  pi.on("session_start", () => {
    probeLog().push("session_start");
  });
  pi.on("session_shutdown", async () => {
    await new Promise((r) => setTimeout(r, 50)); // async cleanup, like stopping an MCP server
    probeLog().push("session_shutdown_done");
  });
  pi.on("input", async () => {
    if (process.env.PROBE_SLOW_INPUT) {
      probeLog().push("input_hook_waiting");
      await new Promise((r) => setTimeout(r, 300));
    }
    return { action: "continue" };
  });
}
