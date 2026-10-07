export type PaletteCommand = {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  group: string;
  run: () => void;
  disabled?: boolean;
};
const text = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
export function filterCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const words = text(query.trim()).split(/\s+/).filter(Boolean);
  return commands.filter(
    (command) =>
      !command.disabled &&
      words.every((word) =>
        text(
          `${command.label} ${command.detail ?? ""} ${command.group}`,
        ).includes(word),
      ),
  );
}
