/** Split oversized originals without acknowledging text that was never submitted. */
export function archiveBatch(rows, state, maxChars = 6000) {
  const messages = [];
  let remaining = maxChars,
    upto = Number(state?.upto) || 0;
  for (const row of rows) {
    const offset = row.id === Number(state?.partialMessageId) ? Number(state.partialOffset) || 0 : 0;
    const text = String(row.body || "").slice(offset);
    const part = text.slice(0, remaining);
    messages.push({ ...row, body: part });
    remaining -= part.length + 35;
    if (part.length < text.length) {
      upto = row.id - 1;
      const partialOffset = offset + part.length;
      return { messages, cursor: { upto, partialMessageId: row.id, partialOffset } };
    }
    upto = row.id;
    if (remaining <= 100) break;
  }
  return { messages, cursor: { upto, partialMessageId: null, partialOffset: 0 } };
}
