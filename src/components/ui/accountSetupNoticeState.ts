export function claimAccountSetupNotice(seen: Set<string>, key: string | undefined, accountExists: boolean | undefined) {
  if (!key || accountExists !== false || seen.has(key)) return false;
  seen.add(key);
  return true;
}
