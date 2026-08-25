const KEY = "[A-Z][A-Z0-9]{1,7}-\\d+";
const KEY_CASE_INSENSITIVE = "[A-Za-z][A-Za-z0-9]{1,7}-\\d+";
const VALID_KEY = new RegExp(`^${KEY}$`);
const KEY_AT_START = new RegExp(`^(${KEY})(?=$|[\\s,.;:!?)\\] }])`);
const PHRASE = new RegExp(
  `\\b(?:close|closes|closed|closing|fix|fixes|fixed|fixing|resolve|resolves|resolved|resolving|complete|completes|completed|completing)(?::)?[ \\t]+(${KEY_CASE_INSENSITIVE})(?=$|[\\s,.;:!?)\\] }])`,
  "gi",
);

function stripMarkdown(value: string): string {
  let text = value.replace(/<!--[\s\S]*?-->/g, "");
  const lines = text.split(/\r?\n/);
  let fence: "`" | "~" | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      kept.push("");
      continue;
    }
    if (fence !== null || /^(?: {4,}|\t)/.test(line) || /^\s*>/.test(line)) {
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  text = kept.join("\n");
  text = text.replace(/!\[[^\]]*\]\([^\n)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\([^\n)]*\)/g, "$1");
  text = text.replace(/`+[^`\n]*`+/g, "");
  return text;
}

function keysInField(value: string): string[] {
  const text = stripMarkdown(value);
  const keys: string[] = [];
  for (const match of text.matchAll(PHRASE)) {
    if (!VALID_KEY.test(match[1])) continue;
    keys.push(match[1]);
    let rest = text.slice((match.index ?? 0) + match[0].length);
    while (true) {
      const separator = rest.match(/^(?:(?:[ \t]*,[ \t]*(?:and[ \t]+)?)|(?:[ \t]+and[ \t]+))+/i);
      if (!separator) break;
      rest = rest.slice(separator[0].length);
      const next = rest.match(KEY_AT_START);
      if (!next) break;
      keys.push(next[1]);
      rest = rest.slice(next[1].length);
    }
  }
  return keys;
}

export function closingTicketKeys(title: string, body: string | null): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const key of [...keysInField(title), ...keysInField(body ?? "")]) {
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export async function verifyGithubSignature(
  secret: string,
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-fA-F]{64}$/.test(header)) return false;
  const expected = Uint8Array.from(header.slice(7).match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, expected, body);
}

export interface GithubPullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    merged?: boolean;
    html_url?: string;
    base?: { ref?: string };
  };
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
}
