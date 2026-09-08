export type SelectOption<T extends string> = { value: T; label: string; disabled?: boolean };

export function nextEnabledOption<T extends string>(options: ReadonlyArray<SelectOption<T>>, current: number, direction: 1 | -1) {
  if (!options.length) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}
