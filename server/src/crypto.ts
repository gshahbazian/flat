export interface HmacKey {
  id: string;
  secret: string;
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return null;
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function base64urlToBytes(value: string): Uint8Array | null {
  if (!BASE64URL.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomSecret(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function randomHexSecret(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function newUlid(now = Date.now()): string {
  const random = crypto.getRandomValues(new Uint8Array(10));
  let time = BigInt(now);
  let result = "";
  for (let index = 9; index >= 0; index -= 1) {
    result = ULID_ALPHABET[Number(time & 31n)] + result;
    time >>= 5n;
  }
  let bits = 0;
  let buffer = 0;
  for (const byte of random) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ULID_ALPHABET[(buffer >> bits) & 31];
    }
  }
  return result.slice(0, 26);
}

async function importHmacKey(key: HmacKey) {
  const bytes = base64urlToBytes(key.secret);
  if (!bytes || bytes.length < 32) throw new Error(`invalid HMAC key ${key.id}`);
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function parseKeyRing(raw: string | undefined): HmacKey[] {
  if (!raw) throw new Error("server is missing FLAT_HMAC_KEYS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FLAT_HMAC_KEYS is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("FLAT_HMAC_KEYS must be a non-empty array");
  }
  const keys = parsed as HmacKey[];
  for (const key of keys) {
    if (!key || typeof key.id !== "string" || typeof key.secret !== "string") {
      throw new Error("FLAT_HMAC_KEYS contains an invalid key");
    }
  }
  return keys;
}

export async function hmacHex(key: HmacKey, value: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await importHmacKey(key), new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(mac));
}

export async function verifyHmac(key: HmacKey, value: string, expectedHex: string): Promise<boolean> {
  const expected = hexToBytes(expectedHex);
  const mac = expected ?? new Uint8Array(32);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importHmacKey(key),
    mac,
    new TextEncoder().encode(value),
  );
  return expected !== null && expected.length === 32 && valid;
}

export interface ParsedCredential {
  id: string;
  secret: string;
}

export function parseCredential(value: unknown, prefix: string): ParsedCredential | null {
  if (typeof value !== "string") return null;
  const marker = `${prefix}_`;
  if (!value.startsWith(marker)) return null;
  const idStart = marker.length;
  const id = value.slice(idStart, idStart + 26);
  if (!ULID.test(id) || value[idStart + 26] !== "_") return null;
  const secret = value.slice(idStart + 27);
  const bytes = base64urlToBytes(secret);
  if (!bytes || bytes.length < 32) return null;
  return { id, secret };
}

export function createCredential(prefix: string): { id: string; secret: string; credential: string } {
  const id = newUlid();
  const secret = randomSecret();
  return { id, secret, credential: `${prefix}_${id}_${secret}` };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalize(child);
  }
  return result;
}

export async function canonicalSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function configuredVerifier(value: string | undefined): { keyId: string; verifier: string } | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const verifier = value.slice(separator + 1);
  if (!/^[0-9a-fA-F]{64}$/.test(verifier)) return null;
  return { keyId: value.slice(0, separator), verifier };
}
