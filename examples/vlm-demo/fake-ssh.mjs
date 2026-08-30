// Fake `ssh` for the vlm-demo's RemoteComputerBackend: same pattern as
// packages/remote/test/fake-ssh.ts (canned responses keyed by markers in
// the remote command), extended with a tiny file-backed state machine so
// the demo's fill/click steps produce real, observable effects that
// replaySkill()'s per-step verification can check against — genuinely
// offline, no real SSH host, no real browser.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const command = process.argv[process.argv.length - 1] ?? "";
const statePath = process.env.VLM_DEMO_STATE_PATH;

function loadState() {
  if (!statePath || !existsSync(statePath)) return { month: "", submitted: false };
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { month: "", submitted: false };
  }
}

function saveState(state) {
  if (statePath) writeFileSync(statePath, JSON.stringify(state));
}

if (/\bscrot\b/.test(command)) {
  process.stdout.write("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
  process.exit(0);
}

const helperMatch = command.match(/node\s+'[^']*'\s+(snapshot|click|fill|navigate|text)\s+'([^']*)'/);
if (helperMatch) {
  const [, action, encoded] = helperMatch;
  const input = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString("utf8") || "{}") : {};
  const state = loadState();

  if (action === "navigate") {
    process.stdout.write(JSON.stringify({ ok: true }));
    process.exit(0);
  }
  if (action === "fill") {
    if (input.ref === "b1") {
      state.month = String(input.text ?? "");
      saveState(state);
    }
    process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
    process.exit(0);
  }
  if (action === "click") {
    if (input.ref === "b2") {
      state.submitted = true;
      saveState(state);
    }
    process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
    process.exit(0);
  }
  if (action === "snapshot") {
    const elements = state.submitted
      ? [{ ref: "b3", role: "link", name: "Submit another report" }]
      : [
          { ref: "b1", role: "combobox", name: "Month", value: state.month },
          { ref: "b2", role: "button", name: "Submit report" },
        ];
    process.stdout.write(
      JSON.stringify({
        title: state.submitted ? "Submission successful" : "Monthly report",
        url: state.submitted ? "http://demo.local/done" : "http://demo.local/report",
        elements,
      }),
    );
    process.exit(0);
  }
  if (action === "text") {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        text: state.submitted ? `Submission successful\nMonth: ${state.month}` : "Monthly report",
      }),
    );
    process.exit(0);
  }
}

if (/\bcurl\b/.test(command)) {
  process.stdout.write("[]");
  process.exit(0);
}

// Generic exec fallback: recordShell()'s raw shell commands (no helper
// wrapper, no "scrot") land here.
process.stdout.write(`ran: ${command}`);
process.exit(0);
