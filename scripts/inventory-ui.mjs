import { readdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const rows = [];
const compact = text => text.replace(/\s+/g, " ").trim().slice(0, 240);
const tags = new Set(["button", "input", "textarea", "select", "a", "summary", "Switch", "SelectMenu", "ModelCombobox"]);
for (const file of (await readdir("src/renderer/src")).filter(name => name.endsWith(".tsx")).sort()) {
  const path = `src/renderer/src/${file}`;
  const source = await readFile(path, "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node, owner = "module") => {
    if (ts.isFunctionDeclaration(node) && node.name) owner = node.name.text;
    if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) owner = node.name.getText(tree);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const element = node.tagName.getText(tree);
      const attrs = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map(attr => [attr.name.getText(tree), attr.initializer?.getText(tree) || "true"]));
      const handlers = [...attrs].filter(([name]) => /^on(Click|Change|KeyDown|PointerDown|MouseDown|Submit|Drop|Paste)$/.test(name));
      if (tags.has(element) || handlers.length) {
        const text = ts.isJsxElement(node.parent) ? node.parent.children.map(child => ts.isJsxText(child) || ts.isJsxExpression(child) ? child.getText(tree) : "").join(" ") : "";
        rows.push({ surface: "desktop", file: path, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, component: owner, element,
          label: compact(attrs.get("aria-label") || attrs.get("title") || attrs.get("label") || attrs.get("placeholder") || text || "Dynamic or inherited"),
          disabled: compact(attrs.get("disabled") || ""), handler: compact(handlers.map(([name, value]) => `${name}: ${value}`).join("; ")),
          coverage: "Source control site; consult the journey register and release verification scope" });
      }
    }
    ts.forEachChild(node, child => visit(child, owner));
  };
  visit(tree);
}
const phonePath = "services/sandbox-gateway/src/companion-ui.ts";
const phone = await readFile(phonePath, "utf8");
for (const match of phone.matchAll(/<(button|input|textarea|select|a|summary|img)\b([^>]*)>/g)) {
  const [, element, attrs] = match;
  const attr = name => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  const following = phone.slice(match.index + match[0].length).split("<", 1)[0];
  rows.push({ surface: "phone", file: phonePath, line: phone.slice(0, match.index).split("\n").length, component: "companion page", element,
    label: compact(attr("aria-label") || attr("placeholder") || following || attr("id") || "Dynamic"), disabled: /\bdisabled\b/.test(attrs) ? "Initially disabled" : "Dynamic in render()",
    handler: attr("id") ? `#${attr("id")}` : attr("data-key") || attr("data-scroll") || "Inline page handler", coverage: "Phone Chromium/WebKit interactions and companion integration; physical-device checks remain separate" });
}
const fields = ["id", "surface", "file", "line", "component", "element", "label", "disabled", "handler", "coverage"];
const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
const version = JSON.parse(await readFile("package.json", "utf8")).version;
await writeFile(`docs/UI-CONTROL-INVENTORY-${version}.csv`, fields.join(",") + "\n" + rows.map((row, index) => fields.map(field => quote(field === "id" ? `UI${String(index + 1).padStart(3, "0")}` : row[field])).join(",")).join("\n") + "\n");
console.log(`Mapped ${rows.length} source control sites: ${rows.filter(row => row.surface === "desktop").length} desktop, ${rows.filter(row => row.surface === "phone").length} phone. Repeated and conditional controls expand at runtime.`);
