// Local Docker must permit the nested user/PID namespaces used inside Cloudflare's Sandbox.
// Keep the bridge's uid drop and process isolation enabled; do not use --privileged.
export const sandboxRunArgs = [
  "--security-opt",
  "seccomp=unconfined",
  "--security-opt",
  "apparmor=unconfined",
]
