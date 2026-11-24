// Checks tool arguments against the tools' input schemas. It knows the part of JSON Schema those schemas use: type,
// properties, required, additionalProperties: false, enum, minimum and maximum, minLength, maxLength and pattern, items,
// minItems, maxItems and uniqueItems. Each problem names the argument and what it must be, so the model can fix the call.

const DESCRIBE = {
  string: 'text', integer: 'a whole number', number: 'a number', boolean: 'true or false', array: 'a list', object: 'an object', null: 'null',
};

function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

const shown = (value) => JSON.stringify(value);

function check(schema, value, label, problems) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      problems.push(`${label} must be ${types.map((type) => DESCRIBE[type] ?? type).join(' or ')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${label} must be one of ${schema.enum.map(shown).join(', ')}`);
    return;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${label} must not be empty`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${label} must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      problems.push(`${label} must look like ${schema.examples?.[0] ?? schema.description ?? `the pattern ${schema.pattern}`}`);
    }
  }
  if (typeof value === 'number') {
    const low = schema.minimum;
    const high = schema.maximum;
    if ((low !== undefined && value < low) || (high !== undefined && value > high)) {
      problems.push(low !== undefined && high !== undefined ? `${label} must be from ${low} to ${high}`
        : low !== undefined ? `${label} must be at least ${low}` : `${label} must be at most ${high}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${label} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${label} takes at most ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map(shown)).size !== value.length) problems.push(`${label} must not repeat an item`);
    if (schema.items) value.forEach((item, index) => check(schema.items, item, `${label}[${index}]`, problems));
  }
  if (matchesType('object', value)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) problems.push(`${label ? `${label}.` : ''}${name} is required`);
    }
    for (const [name, item] of Object.entries(value)) {
      const child = label ? `${label}.${name}` : name;
      if (Object.hasOwn(properties, name)) {
        check(properties[name], item, child, problems);
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(properties);
        problems.push(`unknown argument ${shown(child.slice(0, 60))}${known.length ? ` (this tool takes ${known.join(', ')})` : ' (this tool takes none)'}`);
      }
    }
  }
}

/** The problems with `value` against `schema`, as sentences; empty when it is valid. */
export function validateArguments(schema, value) {
  const problems = [];
  check(schema, value, '', problems);
  return problems;
}
