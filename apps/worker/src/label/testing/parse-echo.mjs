// Returns a step's outcome: its first argument as the value, or the error it names.
export default function echo(task) {
  const [first] = task.args;
  if (first === "fail") {
    return {
      error: { message: "copy not decoded", code: "VISION.INVALID_OUTPUT", category: "PROCESSING" },
    };
  }
  return { value: { op: task.op, first } };
}
