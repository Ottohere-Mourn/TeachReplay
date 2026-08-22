// In-memory computer backend hosting the local Teach Mode demo app.
//
// The "demo app" is a tiny model of a report-submission site: a form page
// and a success page. It exists so the whole Teach Mode pipeline —
// demonstrate → record → compile → replay → verify — runs locally with no
// cloud computer, no credentials and no network, and so automated tests
// get a computer whose behavior is fully deterministic.
//
// The same instance is shared between the REST demo endpoints (the person
// demonstrates by clicking in the app's demo panel) and the recorder/replay
// (which observe and drive this state the way they would a real computer).
import { randomUUID } from "node:crypto";

import type { ComputerElement, ComputerSnapshot, TeachBackend } from "@teachreplay/core";

export const DEMO_APP = "openmausbot-demo-app" as const;
export const REPORT_PAGE = "http://demo.local/report";
export const DONE_PAGE = "http://demo.local/done";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

interface Field {
  ref: string;
  role: "combobox" | "textbox" | "searchbox";
  label: string;
  value: string;
  options?: readonly string[];
  sensitive?: boolean;
}

interface Button {
  ref: string;
  role: "button" | "link";
  label: string;
}

interface Page {
  path: string;
  title: string;
  heading: string;
  fields: Field[];
  buttons: Button[];
  /** Extra lines of visible text (the success page's receipt). */
  summary?: string[];
}

function reportPage(): Page {
  return {
    path: REPORT_PAGE,
    title: "Monthly report",
    heading: "Monthly report",
    fields: [
      {
        ref: "f-month",
        role: "combobox",
        label: "Month",
        value: "",
        options: MONTHS,
      },
      { ref: "f-title", role: "textbox", label: "Report title", value: "" },
      { ref: "f-recipient", role: "textbox", label: "Recipient email", value: "" },
      { ref: "f-notes", role: "textbox", label: "Notes", value: "" },
      { ref: "f-secret", role: "textbox", label: "Access code", value: "", sensitive: true },
    ],
    buttons: [{ ref: "b-submit", role: "button", label: "Submit report" }],
  };
}

function donePage(values?: Record<string, string>): Page {
  return {
    path: DONE_PAGE,
    title: "Submission successful",
    heading: "Submission successful",
    fields: [],
    buttons: [{ ref: "b-again", role: "link", label: "Submit another report" }],
    summary: [
      `Month: ${values?.["f-month"] ?? ""}`,
      `Title: ${values?.["f-title"] ?? ""}`,
      `Recipient: ${values?.["f-recipient"] ?? ""}`,
    ],
  };
}

/** Test hook: rename an element so replay must recover or fail — simulates
 * the demo site's UI drifting between recording and replay. */
export interface MockPerturbation {
  renameElement?: { ref: string; label: string };
  removeElement?: { ref: string };
}

export class MockComputer implements TeachBackend {
  readonly kind = "mock" as const;
  readonly id = randomUUID();
  private page: Page = reportPage();
  private submitted: Array<Record<string, string>> = [];
  /** Applied at snapshot time until reset() — makes elements unmatchable. */
  private perturbations: MockPerturbation[] = [];

  perturb(perturbation: MockPerturbation) {
    this.perturbations.push(perturbation);
  }

  reset() {
    this.page = reportPage();
    this.perturbations = [];
    this.submitted = [];
  }

  /** What the demo panel renders: the current page plus the submission log. */
  demoState() {
    return {
      app: DEMO_APP,
      url: this.page.path,
      title: this.page.title,
      heading: this.page.heading,
      fields: this.page.fields.map(({ ref, role, label, value, options, sensitive }) => ({
        ref, role, label, value, options, sensitive,
      })),
      buttons: this.page.buttons.map(({ ref, role, label }) => ({ ref, role, label })),
      submitted: this.submitted,
    };
  }

  private findElement(ref: string): Field | Button | null {
    return (
      this.page.fields.find((field) => field.ref === ref) ??
      this.page.buttons.find((button) => button.ref === ref) ??
      null
    );
  }

  private applyPerturbations() {
    for (const perturbation of this.perturbations) {
      if (perturbation.renameElement) {
        for (const element of [...this.page.fields, ...this.page.buttons]) {
          if (element.ref === perturbation.renameElement.ref) {
            (element as { label: string }).label = perturbation.renameElement.label;
          }
        }
      }
      if (perturbation.removeElement) {
        const target = perturbation.removeElement.ref;
        this.page.fields = this.page.fields.filter((field) => field.ref !== target);
        this.page.buttons = this.page.buttons.filter((button) => button.ref !== target);
      }
    }
  }

  async snapshot(): Promise<ComputerSnapshot> {
    this.applyPerturbations();
    const elements: ComputerElement[] = [
      ...this.page.fields.map((field) => ({
        ref: field.ref,
        role: field.role,
        name: field.label,
        value: field.value,
        sensitive: field.sensitive ? true : undefined,
      })),
      ...this.page.buttons.map((button) => ({
        ref: button.ref,
        role: button.role,
        name: button.label,
      })),
    ];
    return { url: this.page.path, title: this.page.title, text: await this.text(), elements };
  }

  async navigate(url: string): Promise<void> {
    if (url.startsWith(REPORT_PAGE)) this.page = reportPage();
    else if (url.startsWith(DONE_PAGE)) this.page = donePage();
    else throw new Error(`no such demo page: ${url}`);
  }

  async fill(ref: string, value: string): Promise<void> {
    const element = this.findElement(ref);
    if (!element || !("value" in element)) throw new Error(`no fillable demo element "${ref}"`);
    (element as Field).value = value;
  }

  async click(ref: string): Promise<void> {
    const element = this.findElement(ref);
    if (!element) throw new Error(`no demo element "${ref}"`);
    if (element.ref === "b-submit") {
      this.applyPerturbations();
      const values = Object.fromEntries(this.page.fields.map((field) => [field.ref, field.value]));
      this.submitted.push(values);
      this.page = donePage(values);
      return;
    }
    if (element.ref === "b-again") {
      this.page = reportPage();
      return;
    }
    throw new Error(`demo element "${ref}" is not clickable`);
  }

  async text(): Promise<string> {
    const lines = [this.page.heading, ...(this.page.summary ?? [])];
    for (const field of this.page.fields) {
      const shown = field.sensitive && field.value ? "«masked»" : field.value;
      lines.push(`${field.label}: ${shown}`);
    }
    for (const button of this.page.buttons) lines.push(`[${button.label}]`);
    return lines.join("\n");
  }

  /** The demo computer's shell: a tiny fake that echoes the command and
   * "processes" the latest submission. Deterministic for tests. */
  async exec(command: string, _options?: { cwd?: string }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    if (/^\s*exit\s+(\d+)/.test(command)) {
      const code = Number(command.match(/^\s*exit\s+(\d+)/)![1]);
      return { exitCode: code, stdout: "", stderr: `exited ${code}` };
    }
    const latest = this.submitted[this.submitted.length - 1];
    return {
      exitCode: 0,
      stdout: latest ? `processed ${latest["f-month"] ?? ""} report` : `ran: ${command}`,
      stderr: "",
    };
  }
}

/** One shared demo computer per server process — the panel, recorder and
 * replay must all see the same state. */
let sharedDemoComputer: MockComputer | null = null;

export function demoComputer(): MockComputer {
  sharedDemoComputer ??= new MockComputer();
  return sharedDemoComputer;
}
