// Fake `ssh` for RemoteComputerBackend tests: prints canned responses
// based on markers in the remote command, and echoes the flags it was
// called with so tests can assert the connection arguments.
const command = process.argv[process.argv.length - 1] ?? "";
const lower = command.toLowerCase();
const args = process.argv.slice(2, -1);
const dump = (value: unknown) => process.stdout.write(JSON.stringify(value));
if (lower.includes("fake_shot") || lower.includes("scrot")) {
  process.stdout.write("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
} else if (lower.includes("snapshot")) {
  dump({ title: "Fake page", url: "http://fake.local/report", elements: [
    { ref: "b1", role: "combobox", name: "Month" },
    { ref: "b2", role: "textbox", name: "Report title" },
    { ref: "b3", role: "button", name: "Submit report" },
  ] });
} else if (lower.includes("text")) {
  process.stdout.write("Fake page\nMonth: August");
} else if (lower.includes("exec")) {
  if (lower.includes("fails")) {
    process.stdout.write("boom output");
    process.stderr.write("boom");
    process.exit(3);
  }
  process.stdout.write(`ran: ${command.slice(command.indexOf("EXEC") + 4)}`);
} else if (lower.includes("flags")) {
  dump(args);
} else if (lower.includes("curl")) {
  process.stdout.write(JSON.stringify([{ id: "tab-1", type: "page", title: "Fake tab", url: "http://fake.local/report" }]));
} else if (lower.includes("helper-ok")) {
  process.stdout.write("ok");
} else {
  process.stdout.write("fake-ssh: unknown command");
}
