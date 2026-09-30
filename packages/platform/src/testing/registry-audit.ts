import ts from "typescript";

const CODE = /^[A-Z][A-Z0-9_]*\.[A-Z0-9_]+$/;

export interface CodeLiteral {
  file: string;
  line: number;
  code: string;
}

/** Ask TypeScript for the registry's keys, including mapped types and computed properties. */
function registryCodes(program: ts.Program): Set<string> {
  const checker = program.getTypeChecker();
  const codes = new Set<string>();
  for (const source of program.getSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "defineErrors") {
        const argument = node.arguments[0];
        if (argument) {
          for (const property of checker.getTypeAtLocation(argument).getProperties()) {
            codes.add(property.name);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return codes;
}

function isCode(node: ts.Node): node is ts.StringLiteralLike {
  if (!ts.isStringLiteralLike(node) || !CODE.test(node.text)) {
    return false;
  }
  const parent = node.parent;
  // A prefix used to inspect/translate codes is not itself an emitted error code.
  const prefixCall =
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ["startsWith", "replace"].includes(parent.expression.name.text);
  return !(prefixCall && node.text.endsWith("_"));
}

/** No source execution, imports or network calls: only syntax and registry types are read. */
export function unregisteredLiterals(program: ts.Program, files: readonly string[]): CodeLiteral[] {
  const codes = registryCodes(program);
  const missing: CodeLiteral[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) {
      throw new Error(`Audit source missing: ${file}`);
    }
    const visit = (node: ts.Node): void => {
      if (isCode(node) && !codes.has(node.text)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        missing.push({ file, line, code: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return missing;
}
