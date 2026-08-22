// Chrome DevTools helper deployed on the remote computer: semantic
// snapshot/click/fill/text/navigate over the loopback CDP endpoint.
// Derived from the computer-use helper of OpenMausBot (Apache-2.0),
// extended with textbox values, <select> fills, text and navigation.
export const CDP_HELPER_SOURCE = String.raw`const [action, encoded = ""] = process.argv.slice(2);
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8") || "{}");
const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!page) throw new Error("no debuggable browser page");
if (input.url && page.url !== input.url) throw new Error("page changed; take a new browser snapshot");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result ?? {});
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const refId = (value) => {
  const match = /^b(\d+)$/.exec(String(value ?? ""));
  if (!match) throw new Error("invalid or stale browser ref; take a new snapshot");
  return Number(match[1]);
};
if (action === "snapshot") {
  await send("Accessibility.enable");
  const { nodes = [] } = await send("Accessibility.getFullAXTree", { depth: 14 });
  const useful = new Set(["button", "checkbox", "combobox", "heading", "link", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
  const elements = [];
  for (const node of nodes) {
    const role = String(node.role?.value ?? "").toLowerCase();
    const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const backend = Number(node.backendDOMNodeId ?? 0);
    if (!backend || !useful.has(role) || (!name && role !== "textbox" && role !== "searchbox")) continue;
    const disabled = node.properties?.some((property) => property.name === "disabled" && property.value?.value === true) ?? false;
    const value = ["textbox", "searchbox", "combobox"].includes(role) ? String(node.value?.value ?? "") : undefined;
    const entry = { ref: "b" + backend, role, name: name || "unnamed", disabled };
    if (value !== undefined) entry.value = value;
    elements.push(entry);
    if (elements.length >= 250) break;
  }
  process.stdout.write(JSON.stringify({ title: String(page.title ?? "").slice(0, 200), url: page.url, elements }));
} else if (action === "click") {
  const backendNodeId = refId(input.ref);
  const { model } = await send("DOM.getBoxModel", { backendNodeId });
  const quad = model?.border ?? model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("element is not visible; take a new snapshot");
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else if (action === "fill") {
  const backendNodeId = refId(input.ref);
  const value = String(input.text ?? "");
  // A <select> cannot be typed into: pick the matching option and fire the
  // change event. Text fields fall through to the keyboard sequence.
  const { object } = await send("DOM.resolveNode", { backendNodeId });
  const { result: kind } = await send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function(value) {" +
      "if (this.tagName === 'SELECT') {" +
      "const option = Array.from(this.options).find((o) => o.value === value || o.textContent.trim() === value);" +
      "if (!option) throw new Error('no such option: ' + value);" +
      "this.value = option.value;" +
      "this.dispatchEvent(new Event('input', { bubbles: true }));" +
      "this.dispatchEvent(new Event('change', { bubbles: true }));" +
      "return 'selected';" +
      "}" +
      "return 'typed';" +
      "}",
    arguments: [{ value }],
    returnByValue: true,
  });
  if (kind?.value !== "selected") {
    await send("DOM.focus", { backendNodeId });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
    await send("Input.insertText", { text: value });
  }
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else if (action === "navigate") {
  await send("Page.navigate", { url: String(input.url ?? "") });
  process.stdout.write(JSON.stringify({ ok: true }));
} else if (action === "text") {
  const { result } = await send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true });
  process.stdout.write(JSON.stringify({ ok: true, text: String(result?.value ?? "") }));
} else {
  throw new Error("unknown browser action");
}
socket.close();`;
