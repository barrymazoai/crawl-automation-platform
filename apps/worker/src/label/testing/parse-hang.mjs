// A parse step that never ends, as the 2026-11-12 serving-line regex did on a long run of spaces.
export default function hang() {
  for (;;) {
    /x/.test("y");
  }
}
