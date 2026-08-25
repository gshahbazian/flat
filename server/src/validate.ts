// Mirrors `flat_schema::validate_title` (schema/src/lib.rs): non-empty,
// single line, no control characters. A newline would corrupt the markdown
// frontmatter every client materializes. Rust checks `char::is_control()`
// (Unicode Cc = U+0000..U+001F and U+007F..U+009F); the regex below is that
// exact range, and schema/fixtures/titles.json is run against both
// implementations in CI so they can't drift apart.
export function invalidTitle(title: string): string | null {
  if (title.trim().length === 0) {
    return "title must not be empty";
  }
  // oxlint-disable-next-line eslint/no-control-regex -- This intentionally matches Unicode control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) {
    return "title must be a single line without control characters";
  }
  return null;
}

const ASCII_TRIM = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;

export function invalidEmail(value: unknown): string | null {
  if (typeof value !== "string" || /[^\x00-\x7f]/.test(value)) return null;
  const email = value.replace(ASCII_TRIM, "").toLowerCase();
  if (/[\x00-\x20\x7f]/.test(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0].length === 0) return null;
  const labels = parts[1].split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;
  return email;
}

export function invalidTenantName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length === 0 || Array.from(name).length > 80) return null;
  return name;
}

export function invalidTokenName(name: string): boolean {
  return !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}
