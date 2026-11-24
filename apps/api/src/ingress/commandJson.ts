/** CLI JSON must not hide a field behind a duplicate (including escaped key names). */
export function parseCommandJson(text: string): unknown {
  if (Buffer.byteLength(text) > 1024 * 1024 || text.charCodeAt(0) === 0xfeff) throw Error('invalid output');
  const value: unknown = JSON.parse(text);
  const stack: Array<{ object: boolean; key: boolean; names: Set<string> }> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const context = stack.at(-1);
      if (context?.object && context.key) {
        const name = JSON.parse(text.slice(start, i + 1)) as string;
        if (context.names.has(name)) throw Error('duplicate key');
        context.names.add(name);
        context.key = false;
      }
    } else if (c === '{' || c === '[') {
      if (stack.length >= 64) throw Error('output too deep');
      stack.push({ object: c === '{', key: c === '{', names: new Set() });
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.at(-1)?.object) stack.at(-1)!.key = true;
  }
  return value;
}
