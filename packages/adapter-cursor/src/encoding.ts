let reverse: Map<string, number[]> | null = null;

/** Every GBK character → its two bytes, built once by decoding all GBK codes. */
function gbkBytes(): Map<string, number[]> {
  if (reverse) return reverse;
  const decoder = new TextDecoder("gbk");
  reverse = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== "�" && !reverse.has(ch)) reverse.set(ch, [lead, trail]);
    }
  }
  return reverse;
}

/**
 * Undoes what Windows PowerShell does to a hook's stdin on a Chinese system:
 * Cursor pipes the UTF-8 payload through `$input`, which decodes it as GBK and
 * re-encodes it as UTF-8 with a BOM. Encoding back to GBK recovers the original
 * bytes, except where a character's last byte was paired with the next ASCII
 * byte and both became "?". That loses one character (shown as U+FFFD) and, when
 * the swallowed byte was a closing quote, breaks the JSON: inside a string, a
 * "?" right after a damaged character and before a structural character is
 * taken to be that quote.
 */
export function repairPowerShellInput(text: string): string {
  const map = gbkBytes();
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else bytes.push(...(map.get(ch) ?? [0x3f]));
  }
  const s = Buffer.from(bytes).toString("utf8");
  let fixed = "";
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString && c === "\\") {
      fixed += c + (s[++i] ?? "");
      continue;
    }
    if (inString && c === "�" && s[i + 1] === "?" && /[,}\]:\s]/.test(s[i + 2] ?? "}")) {
      fixed += '�"';
      inString = false;
      i++;
      continue;
    }
    if (c === '"') inString = !inString;
    fixed += c;
  }
  return fixed;
}

/**
 * Parses a Cursor hook's stdin. A leading BOM means it went through Windows
 * PowerShell; then the text is repaired first, unless it already parses and
 * contains no sign of mangling.
 */
export function parseHookInput(raw: string): any {
  if (!raw.startsWith("﻿")) return JSON.parse(raw);
  const text = raw.slice(1);
  if (/^[\x00-\x7f]*$/.test(text)) return JSON.parse(text);
  return JSON.parse(repairPowerShellInput(text));
}

/** JSON with every non-ASCII character escaped, so it survives the way back through PowerShell. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
