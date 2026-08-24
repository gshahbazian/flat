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
  if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) {
    return "title must be a single line without control characters";
  }
  return null;
}
