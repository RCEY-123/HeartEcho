import { one, run } from "./db.mjs";
/** Older reflections have only a scope; accept them only with an unambiguous session owner. */
export function ownsReflection(row, accountId) {
  const owner = one("select account_id from reflection_owners where reflection_id=?", [row.id]);
  if (owner) return owner.account_id === String(accountId);
  const session = one("select qq_account_id from sessions where scope_key=?", [row.scope_key]);
  return session?.qq_account_id === String(accountId);
}
export function recordReflectionOwner(id, accountId) {
  run("insert or replace into reflection_owners values(?,?)", [id, String(accountId)]);
}
