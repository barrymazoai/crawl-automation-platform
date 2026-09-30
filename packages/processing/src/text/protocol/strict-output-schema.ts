/**
 * OpenAI strict structured output requires every object to list all its properties as required. A property that
 * may be absent in stored answers is sent as required; it must already allow null, which the model then uses.
 */
export function strictOutputSchema<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((item: unknown) => strictOutputSchema(item)) as T;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const entries = Object.entries(schema).map(([key, value]) => [key, strictOutputSchema(value)]);
  const node = Object.fromEntries(entries) as { properties?: Record<string, unknown> };
  return (node.properties ? { ...node, required: Object.keys(node.properties) } : node) as T;
}
