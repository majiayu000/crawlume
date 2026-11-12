// Minimal DOM builder: every value goes through text nodes or attributes, never innerHTML.

type Child = Node | string | number | null | undefined | false;
type Attributes = Record<string, string | boolean | ((event: Event) => void) | undefined>;

export function h(tag: string, attributes: Attributes = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.replace(/^on/u, ""), value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "number" ? String(child) : child);
  }
  return element;
}

export function formatTime(value: string | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function table(headers: string[], rows: Node[][], empty: string): HTMLElement {
  if (rows.length === 0) return h("p", { class: "muted" }, empty);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, ...headers.map((header) => h("th", {}, header)))),
    h("tbody", {}, ...rows.map((cells) => h("tr", {}, ...cells.map((cell) => h("td", {}, cell))))),
  ));
}

/** A secret that is only ever shown once, with a copy button. */
export function secretBox(label: string, secret: string, extra?: Node): HTMLElement {
  const code = h("code", { class: "secret" }, secret);
  return h("div", { class: "notice" },
    h("strong", {}, label),
    h("p", {}, "Copy it now. It will not be shown again."),
    code,
    h("div", { class: "row" },
      h("button", {
        type: "button",
        onclick: () => { void navigator.clipboard.writeText(secret); },
      }, "Copy"),
      extra,
    ),
  );
}

