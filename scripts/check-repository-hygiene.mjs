import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "node_modules",
  "out",
  "output",
  "release",
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const exactTextFiles = new Set([".gitignore"]);

const rules = [
  {
    label: "an absolute macOS home-directory path",
    pattern: /\/Users\/[A-Za-z0-9._-]+\//,
  },
  {
    label: "an absolute Linux home-directory path",
    pattern: /\/home\/[A-Za-z0-9._-]+\//,
    allow: (value) => value.includes("/home/example/"),
  },
  {
    label: "an absolute Windows home-directory path",
    pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/,
  },
  {
    label: "a private tailnet hostname",
    pattern: /\b[a-z0-9-]+\.ts\.net\b/i,
  },
  {
    label: "private-key material",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    label: "a credential-shaped OpenAI key",
    pattern: /\bsk-(?!or-v1-)[A-Za-z0-9_-]{24,}\b/,
  },
  {
    label: "a credential-shaped OpenRouter key",
    pattern: /\bsk-or-v1-[A-Za-z0-9_-]{24,}\b/,
  },
  {
    label: "an em dash",
    pattern: /\u2014/,
  },
];

async function filesIn(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) output.push(...await filesIn(pathname));
      continue;
    }
    if (entry.isFile() && (textExtensions.has(extname(entry.name)) || exactTextFiles.has(entry.name))) output.push(pathname);
  }
  return output;
}

const failures = [];
for (const pathname of await filesIn(root)) {
  const content = await readFile(pathname, "utf8");
  for (const rule of rules) {
    if (rule.pattern.test(content) && !rule.allow?.(content)) {
      failures.push(`${relative(root, pathname)} contains ${rule.label}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`Repository hygiene failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Repository hygiene passed.\n");
}
