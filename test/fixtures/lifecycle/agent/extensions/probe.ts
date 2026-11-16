// Probe extension: records lifecycle events. PROBE_SLOW_INPUT holds
// session.prompt() in preflight for 300ms; PROBE_BAD_RESOURCES makes
// bindExtensions throw after session_start.
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
  pi.on("resources_discover", () => {
    // Malformed paths make bindExtensions throw after session_start was delivered.
    if (process.env.PROBE_BAD_RESOURCES) return { skillPaths: [42] };
  });
  pi.on("input", async () => {
    if (process.env.PROBE_SLOW_INPUT) {
      probeLog().push("input_hook_waiting");
      await new Promise((r) => setTimeout(r, 300));
    }
    return { action: "continue" };
  });
}
