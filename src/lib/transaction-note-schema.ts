export const TRANSACTION_NOTE_SCHEMA_WARNING =
  "Some transaction notes are unavailable because the database is missing a note column. Apply db/migrate.sql to restore complete note history and saving.";

export function isMissingTransactionNoteColumn(
  error:
    | string
    | {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        hint?: unknown;
      }
): boolean {
  const fields =
    typeof error === "string"
      ? [error]
      : [error.message, error.details, error.hint].filter(
          (field): field is string => typeof field === "string"
        );
  const message = fields.join(" ");
  const mentionsMissingNoteColumn =
    /column\s+(?:"?[\w]+"?\.)?"?note"?\s+does not exist/i.test(message) ||
    /column\s+["'][\w]+\.note["']\s+does not exist/i.test(message) ||
    /column\b[\s\S]*\bnote\b[\s\S]*\bdoes not exist\b/i.test(message);

  return mentionsMissingNoteColumn ||
    (typeof error !== "string" &&
      error.code === "42703" &&
      /\bnote\b/i.test(message));
}
