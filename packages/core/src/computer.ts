// The computer abstraction Teach Mode records against and replays through.
//
// Three implementations today:
//   - backends/mock.ts   — an in-memory computer hosting the local demo app
//     (deterministic, no credentials, used by tests and the local demo)
//   - backends/box.ts    — the bot's cloud computer (box.ascii.dev), observed
//     through the same Chrome DevTools semantic snapshot used by the
//     computer-use MCP proxy of the host harness
//   - backends/remote.ts — any SSH-reachable Linux computer with a virtual
//     desktop (Xvfb + Chrome with loopback DevTools), e.g. a rented GPU box,
//     a VPS, or an AWS instance
//
// The interface is deliberately semantic: snapshots carry element roles,
// names and refs — never screen coordinates — so both recording and replay
// survive layout changes that pure pixel coordinates would not.
export interface ComputerElement {
  /** Backend-scoped id, valid until the next snapshot changes the DOM. */
  ref: string;
  role: string;
  name: string;
  /** Current value for text-like roles (textbox/searchbox/combobox). */
  value?: string | null;
  disabled?: boolean;
  /** The computer reports the value masked (a password input). */
  sensitive?: boolean;
  /** Checked state for checkbox/radio/switch roles. */
  checked?: boolean;
}

export interface ComputerSnapshot {
  /** Current page URL, without credentials. Null when no page is open. */
  url: string | null;
  title: string;
  /** Visible text of the current page, for verification conditions. */
  text: string;
  elements: ComputerElement[];
}

export interface ShellBackend {
  /** Run a shell command on the computer — the CLI half of GUI+CLI
   * workflows. Output is redacted by the recorder before storage. */
  exec(command: string, options?: { cwd?: string }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

/** A computer Teach Mode can record against and replay through. */
export interface ComputerBackend {
  readonly kind: string;
  snapshot(): Promise<ComputerSnapshot>;
  navigate(url: string): Promise<void>;
  /** Replace the value of one element ref from the most recent snapshot. */
  fill(ref: string, value: string): Promise<void>;
  click(ref: string): Promise<void>;
  /** Visible page text (cheap verification without a full snapshot). */
  text(): Promise<string>;
  dispose?(): Promise<void>;
}

/** A computer with both GUI and CLI channels — what most backends
 * (remote SSH boxes, cloud computers, the demo computer) provide. */
export type TeachBackend = ComputerBackend & ShellBackend;

/** Back-compatible alias for TeachBackend (v0.1 name). */
export type TeachComputerBackend = TeachBackend;

/** Find the element that best matches a semantic description in a snapshot.
 * Exact role+name match first; then same-role name-substring; then same-role
 * unnamed elements. Returns null when nothing matches — callers must treat
 * that as a failed step, not guess. */
export function findElement(
  snapshot: ComputerSnapshot,
  match: { role: string; name?: string },
): ComputerElement | null {
  const wantedRole = match.role.toLowerCase();
  const candidates = snapshot.elements.filter((element) => element.role.toLowerCase() === wantedRole);
  if (!match.name) return candidates[0] ?? null;
  const wantedName = match.name.trim().toLowerCase();
  if (!wantedName) return candidates[0] ?? null;
  return (
    candidates.find((element) => element.name.trim().toLowerCase() === wantedName) ??
    candidates.find((element) => element.name.toLowerCase().includes(wantedName)) ??
    null
  );
}

/** Normalize a URL for comparison: credentials removed, trailing slash
 * dropped. Behavior matches the host harness's browser-URL normalization but
 * stays dependency-free so the teach core keeps compiling standalone. */
export function normalizeComparisonUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}
