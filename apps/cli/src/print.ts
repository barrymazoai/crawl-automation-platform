/** Prints a result as indented JSON on standard output. */
export function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
