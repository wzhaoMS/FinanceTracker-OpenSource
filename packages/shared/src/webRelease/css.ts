import { ident, parse, walk, type CssNode, type FunctionNode } from 'css-tree';

function resource(value: string, paths: ReadonlySet<string>): boolean {
  return /^#[A-Za-z][A-Za-z0-9_-]*$/.test(value) || (value.startsWith('/assets/') && paths.has(value.slice(1)));
}

function functionName(node: FunctionNode): string {
  return ident.decode(node.name).toLowerCase();
}

function literalUrl(node: FunctionNode, paths: ReadonlySet<string>): boolean {
  const children = node.children.toArray();
  return children.length === 1 && children[0].type === 'String' && resource(children[0].value, paths);
}

function imageSet(node: FunctionNode, paths: ReadonlySet<string>): boolean {
  let needsSource = true;
  for (const child of node.children) {
    if (child.type === 'Operator' && child.value === ',') {
      if (needsSource) return false;
      needsSource = true;
    } else if (needsSource) {
      if (child.type === 'String' || child.type === 'Url') {
        if (!resource(child.value, paths)) return false;
      } else if (child.type === 'Function' && ['url', 'src'].includes(functionName(child))) {
        if (!literalUrl(child, paths)) return false;
      } else return false;
      needsSource = false;
    } else if (child.type === 'Dimension') {
      if (!['x', 'dpi', 'dpcm', 'dppx'].includes(ident.decode(child.unit).toLowerCase()) || !(Number(child.value) > 0)) return false;
    } else if (child.type === 'Function' && functionName(child) === 'type') {
      const args = child.children.toArray();
      if (args.length !== 1 || args[0].type !== 'String' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(args[0].value)) return false;
    } else return false;
  }
  return !needsSource;
}

/** No raw-text matching: identifiers and string/URL tokens obey CSS escape rules. */
export function releaseCssAllowed(text: string, paths: ReadonlySet<string>): boolean {
  try {
    const ast = parse(text, { parseCustomProperty: true, onParseError: (error) => { throw error; } });
    let allowed = true;
    walk(ast, (node: CssNode) => {
      if (node.type === 'Raw') allowed = false;
      if (node.type === 'Atrule' && ident.decode(node.name).toLowerCase() === 'import') allowed = false;
      if (node.type === 'Url' && !resource(node.value, paths)) allowed = false;
      if (node.type !== 'Function') return;
      const name = functionName(node);
      if ((name === 'url' || name === 'src') && !literalUrl(node, paths)) allowed = false;
      if ((name === 'image-set' || name === '-webkit-image-set') && !imageSet(node, paths)) allowed = false;
      // Unsupported resource construction/indirection must not hide a URL from the gate.
      if (name === 'image') allowed = false;
    });
    return allowed;
  } catch {
    return false;
  }
}
