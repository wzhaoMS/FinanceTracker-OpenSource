// The compact tree is structural vocabulary, not a financial or identity proof.
export function validateAmazonScopedReadiness(s, rules, safe, readiness) {
  const need = (ok) => { if (!ok) throw Error('invalid-amazon-capture'); };
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
  const count = (n, max = 20000) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
  const r = { ...rules.scoped, depth: s?.version === 2 ? rules.scopeDepth : rules.scoped.depth };
  need(exact(s, ['version', 'status', 'header', 'auth', 'selection', 'roots', 'relations', 'vocabulary',
    ...(s?.version === 2 ? ['identity'] : [])])
    && [1, 2].includes(s.version) && ['complete', 'truncated'].includes(s.status)
    && ['match', 'mismatch', 'absent', 'ambiguous'].includes(s.header)
    && exact(s.auth, ['password', 'email', 'captcha'])
    && Object.values(s.auth).every((v) => v === false)
    && exact(s.selection, ['summary', 'dl', 'method']) && exact(s.roots, ['summary', 'dl', 'method'])
    && exact(s.vocabulary, ['classes', 'shapes'])
    && Array.isArray(s.vocabulary.classes) && s.vocabulary.classes.length <= r.classes
    && new Set(s.vocabulary.classes).size === s.vocabulary.classes.length
    && s.vocabulary.classes.every((c) => safe('classes', c))
    && bytes(s.vocabulary.classes) <= r.classBytes
    && Array.isArray(s.vocabulary.shapes) && s.vocabulary.shapes.length <= r.shapes
    && bytes(s.vocabulary.shapes) <= r.shapeBytes
    && bytes(s) <= r.bytes);
  const { classes, shapes } = s.vocabulary;
  const tag = (n) => count(n, rules.tags.length);
  for (const shape of shapes) need(Array.isArray(shape) && shape.length === 2
    && tag(shape[0]) && Array.isArray(shape[1]) && shape[1].length <= r.classes
    && new Set(shape[1]).size === shape[1].length
    && shape[1].every((n) => count(n, classes.length - 1)));
  need(new Set(shapes.map((v) => JSON.stringify(v))).size === shapes.length);
  const shapeId = (n) => count(n, shapes.length - 1);
  const histogram = (h, valid) => {
    need(Array.isArray(h) && h.length <= (valid === tag ? rules.tags.length + 1 : r.shapes));
    const seen = new Set();
    for (const v of h) {
      need(Array.isArray(v) && v.length === 2 && valid(v[0]) && count(v[1]) && v[1] > 0 && !seen.has(v[0]));
      seen.add(v[0]);
    }
    return h.reduce((n, v) => n + v[1], 0);
  };
  let truncated = false, nodeCount = 0;
  const matched = { summary: rules.summarySelectors, dl: ['definition-list'],
    method: ['instrument-class', 'method-component', 'anchored-heading'] };
  for (const family of ['summary', 'dl', 'method']) {
    const selection = s.selection[family], roots = s.roots[family];
    need(exact(selection, ['candidates', 'selected', 'omittedRoots'])
      && Object.values(selection).every((n) => count(n)) && selection.selected <= selection.candidates
      && (selection.selected > 0) === (selection.candidates > 0)
      && Array.isArray(roots) && roots.length <= r.roots
      && roots.length + selection.omittedRoots === selection.candidates);
    const retainedSelected = roots.filter((root) => root?.relation === 'selected').length;
    need(retainedSelected <= selection.selected && selection.selected - retainedSelected <= selection.omittedRoots);
    if (selection.omittedRoots) truncated = true;
    if (family === 'summary') need(selection.candidates === readiness.summary.roots);
    if (family === 'method') need(selection.candidates === readiness.method.blocks);
    for (const root of roots) {
      need(exact(root, ['matchedBy', 'relation', 'shape', 'descendants', 'children', 'nodes',
        'omittedNodes', 'depthOmitted', 'rows', 'omittedRows', ...(family === 'dl' ? ['pairing', 'pairs'] : [])])
        && Array.isArray(root.matchedBy) && root.matchedBy.length > 0
        && new Set(root.matchedBy).size === root.matchedBy.length
        && root.matchedBy.every((m) => matched[family].includes(m))
        && ['selected', 'ancestor', 'descendant', 'disjoint', 'unselected'].includes(root.relation)
        && (selection.selected > 0 || root.relation === 'unselected')
        && shapeId(root.shape) && count(root.descendants) && count(root.omittedNodes) && count(root.depthOmitted)
        && root.descendants < readiness.elements
        && root.depthOmitted <= root.omittedNodes
        && Array.isArray(root.nodes) && root.nodes.length > 0 && root.nodes.length <= r[`${family}Nodes`]
        && root.nodes.length + root.omittedNodes === root.descendants + 1);
      const direct = histogram(root.children, tag);
      const depths = [], slots = new Set(), children = new Map();
      const ancestry = [], tagCounts = new Map();
      for (const [index, node] of root.nodes.entries()) {
        need(Array.isArray(node) && node.length === 5 && shapeId(node[1]) && count(node[2]) && count(node[3])
          && count(node[4], Number.MAX_SAFE_INTEGER)
          && (index === 0 ? node[0] === -1 && node[1] === root.shape && node[2] === 0 && node[3] === direct
            : count(node[0], index - 1) && node[2] < root.nodes[node[0]][3]));
        depths[index] = index ? depths[node[0]] + 1 : 0;
        need(depths[index] <= r.depth && !slots.has(`${node[0]}:${node[2]}`));
        if (index) {
          while (ancestry.length && ancestry.at(-1) !== node[0]) ancestry.pop();
          need(ancestry.length > 0);
          const siblings = children.get(node[0]) || [];
          need(!siblings.length || root.nodes[siblings.at(-1)][2] < node[2]);
        }
        ancestry.push(index);
        const t = shapes[node[1]][0];
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        slots.add(`${node[0]}:${node[2]}`);
        if (index) {
          if (!children.has(node[0])) children.set(node[0], []);
          children.get(node[0]).push(index);
        }
      }
      need(root.nodes.reduce((n, node) => n + node[3], 0) <= root.descendants
        && root.nodes.reduce((n, node, i) => n + (depths[i] === r.depth ? node[3] : 0), 0) <= root.depthOmitted);
      for (const [t, n] of tagCounts) need(n <= readiness.buckets[rules.tags[t] || 'other']);
      const directSeen = new Map(root.children);
      for (const index of children.get(0) || []) {
        const t = shapes[root.nodes[index][1]][0];
        need(directSeen.get(t) > 0); directSeen.set(t, directSeen.get(t) - 1);
      }
      if (!root.omittedNodes) need(root.nodes.every((n, i) => n[3] === (children.get(i) || []).length));
      need(Array.isArray(root.rows) && root.rows.length <= r.rows && count(root.omittedRows));
      const rowIds = new Set();
      for (const row of root.rows) {
        need(exact(row, ['node', 'children', 'omittedChildren']) && count(row.node, root.nodes.length - 1)
          && !rowIds.has(row.node) && count(row.omittedChildren));
        rowIds.add(row.node);
        const retained = children.get(row.node) || [], expected = new Map();
        for (const n of retained) expected.set(root.nodes[n][1], (expected.get(root.nodes[n][1]) || 0) + 1);
        need(histogram(row.children, shapeId) + row.omittedChildren === root.nodes[row.node][3]
          && row.children.length === expected.size
          && row.children.every(([id, n]) => expected.get(id) === n));
      }
      if (family !== 'summary') need(root.rows.length === 0 && root.omittedRows === 0);
      else {
        const wrappers = new Set(root.nodes.flatMap((node, i) => {
          const shape = shapes[node[1]], tag = rules.tags[shape[0]];
          const names = shape[1].map((n) => classes[n]);
          return i && (tag === 'li' || names.includes('od-line-item-row')
            || tag === 'span' && names.includes('a-list-item')) ? [i] : [];
        }));
        need(root.rows.every((row) => wrappers.has(row.node) || root.nodes[row.node][4] > 0)
          && root.omittedRows >= [...wrappers].filter((i) => !rowIds.has(i)).length);
        if (!root.omittedNodes && !root.nodes.some((node) => node[4])) {
          need(root.rows.length + root.omittedRows === wrappers.size);
        }
      }
      if (family === 'dl') {
        const p = root.pairing;
        need(exact(p, ['dt', 'dd', 'ownedDt', 'ownedDd', 'nestedDl', 'containers', 'paired',
          'nonoverlap', 'unpairedDt', 'unpairedDd', 'omittedPairs'])
          && Object.values(p).every((n) => count(n))
          && p.ownedDt <= p.dt && p.ownedDd <= p.dd && p.paired <= p.containers
          && p.nonoverlap === p.paired && p.ownedDt === p.paired + p.unpairedDt
          && p.ownedDd === p.paired + p.unpairedDd
          && p.dt <= readiness.buckets.dt && p.dd <= readiness.buckets.dd
          && p.dt + p.dd + p.nestedDl <= root.descendants
          && Array.isArray(root.pairs) && root.pairs.length <= r.pairs
          && root.pairs.length + p.omittedPairs === p.paired);
        const used = new Set();
        const containers = [];
        const ancestor = (a, b) => {
          for (let n = b; n !== -1; n = root.nodes[n][0]) if (n === a) return true;
          return false;
        };
        const tags = root.nodes.map((node) => rules.tags[shapes[node[1]][0]] || 'other');
        need(tags[0] === 'dl');
        const owners = [0], terms = [], termParents = new Set();
        const known = { dt: 0, dd: 0, ownedDt: 0, ownedDd: 0, nestedDl: 0, containers: 0 };
        for (let i = 1; i < root.nodes.length; i++) {
          const parent = root.nodes[i][0], tag = tags[i];
          owners[i] = tag === 'dl' ? i : owners[parent];
          if (tag === 'dl') known.nestedDl++;
          if (tag === 'dt' || tag === 'dd') {
            known[tag]++;
            if (owners[i] === 0) {
              known[tag === 'dt' ? 'ownedDt' : 'ownedDd']++;
              terms.push(i); termParents.add(parent);
            }
          }
        }
        known.containers = termParents.size;
        for (const [key, n] of Object.entries(known)) need(root.omittedNodes ? p[key] >= n : p[key] === n);
        if (!root.omittedNodes) {
          const owned = new Set(terms), stats = [], expected = [];
          for (let i = root.nodes.length - 1; i >= 0; i--) {
            const value = { dt: owned.has(i) && tags[i] === 'dt' ? 1 : 0,
              dd: owned.has(i) && tags[i] === 'dd' ? 1 : 0,
              firstDt: null, firstDd: null, nested: 0, paired: false };
            if (value.dt) value.firstDt = i;
            if (value.dd) value.firstDd = i;
            for (const child of children.get(i) || []) {
              const t = stats[child];
              value.dt += t.dt; value.dd += t.dd;
              value.firstDt ??= t.firstDt; value.firstDd ??= t.firstDd;
              value.nested += t.nested + (tags[child] === 'dl' ? 1 : 0);
              value.paired ||= t.paired;
            }
            if (value.dt === 1 && value.dd === 1 && !value.nested && !value.paired
              && value.firstDt !== i && value.firstDd !== i && value.firstDt < value.firstDd
              && !ancestor(value.firstDt, value.firstDd) && !ancestor(value.firstDd, value.firstDt)) {
              expected.push([value.firstDt, value.firstDd, i]); value.paired = true;
            }
            stats[i] = value;
          }
          need(p.paired === expected.length
            && root.pairs.every((pair) => expected.some((v) => v.every((n, i) => pair[i] === n))));
        }
        for (const pair of root.pairs) {
          need(Array.isArray(pair) && pair.length === 3
            && pair.every((n) => count(n, root.nodes.length - 1))
            && new Set(pair).size === 3 && !used.has(pair[0]) && !used.has(pair[1])
            && pair[0] < pair[1]
            && shapes[root.nodes[pair[0]][1]][0] === rules.tags.indexOf('dt')
            && shapes[root.nodes[pair[1]][1]][0] === rules.tags.indexOf('dd'));
          need(containers.every((n) => !ancestor(n, pair[2]) && !ancestor(pair[2], n)));
          need(terms.filter((n) => ancestor(pair[2], n)).length === 2
            && !tags.some((tag, i) => i > 0 && tag === 'dl' && ancestor(pair[2], i)));
          let common = root.nodes[pair[0]][0];
          while (common !== -1 && !ancestor(common, pair[1])) common = root.nodes[common][0];
          need(common === pair[2]);
          containers.push(pair[2]);
          for (let n = pair[2]; n > 0; n = root.nodes[n][0]) {
            need(shapes[root.nodes[n][1]][0] !== rules.tags.indexOf('dl'));
          }
          for (const n of pair.slice(0, 2)) {
            let parent = root.nodes[n][0];
            while (parent !== -1 && parent !== pair[2]) {
              need(!pair.slice(0, 2).includes(parent)
                && shapes[root.nodes[parent][1]][0] !== rules.tags.indexOf('dl'));
              parent = root.nodes[parent][0];
            }
            need(parent === pair[2]); used.add(n);
          }
        }
        if (p.omittedPairs) truncated = true;
      }
      nodeCount += root.nodes.length;
      if (root.omittedNodes || root.omittedRows || root.rows.some((row) => row.omittedChildren)
        || root.nodes.some((node) => node[4])) truncated = true;
    }
  }
  const roots = ['summary', 'dl', 'method'].flatMap((family) => s.roots[family]);
  need(Array.isArray(s.relations) && s.relations.length === roots.length * (roots.length - 1) / 2);
  let relation = 0;
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    const v = s.relations[relation++];
    need(Array.isArray(v) && v.length === 3 && v[0] === i && v[1] === j
      && ['same', 'ancestor', 'descendant', 'disjoint'].includes(v[2])
      && (v[2] !== 'same' || roots[i].shape === roots[j].shape && roots[i].descendants === roots[j].descendants)
      && (v[2] !== 'ancestor' || roots[i].descendants > roots[j].descendants)
      && (v[2] !== 'descendant' || roots[i].descendants < roots[j].descendants));
  }
  need(nodeCount <= r.nodes && s.status === (truncated ? 'truncated' : 'complete'));
  if (s.version === 2) {
    const v = s.identity;
    need(exact(v, ['status', 'distinct', 'visited', 'omitted', 'countsCapped', 'limits', 'occurrences'])
      && ['complete', 'unknown'].includes(v.status)
      && ['none', 'one', 'two-to-eight', 'over-eight', 'unknown'].includes(v.distinct)
      && count(v.visited) && count(v.omitted) && typeof v.countsCapped === 'boolean'
      && (!v.countsCapped || v.omitted === 20000)
      && Array.isArray(v.limits) && new Set(v.limits).size === v.limits.length
      && v.limits.every((n) => ['walk', 'text', 'time', 'occurrences', 'path', 'bytes', 'roots'].includes(n))
      && v.status === (v.limits.length ? 'unknown' : 'complete')
      && Array.isArray(v.occurrences) && v.occurrences.length <= 8 && bytes(v) <= 4096
      && (v.distinct !== 'none' || !v.occurrences.length && !v.omitted)
      && (v.distinct !== 'unknown' || v.limits.some((n) => ['walk', 'text', 'time'].includes(n))));
    const occurrences = v.occurrences.length + v.omitted;
    need((!v.omitted || v.limits.some((n) => ['occurrences', 'bytes'].includes(n)))
      && (v.distinct !== 'one' || occurrences >= 1 && new Set(v.occurrences.map((o) => o?.equality)).size <= 1)
      && (v.distinct !== 'two-to-eight' || occurrences >= 2)
      && (v.distinct !== 'over-eight' || occurrences >= 9));
    for (const o of v.occurrences) {
      need(exact(o, ['equality', 'label', 'landmark', 'pathStatus', 'path', 'relations'])
        && ['equal', 'different'].includes(o.equality)
        && ['order-hash', 'order-number', 'absent', 'unknown'].includes(o.label)
        && ['main', 'banner', 'navigation', 'complementary', 'contentinfo', 'article', 'section', 'body', 'unknown'].includes(o.landmark)
        && ['complete', 'unknown'].includes(o.pathStatus)
        && Array.isArray(o.path) && o.path.length <= rules.scopeDepth
        && (o.pathStatus !== 'complete' || o.path.length > 0)
        && (o.pathStatus !== 'unknown' || o.path.length === 0)
        && bytes(o.path) <= 1024 && Array.isArray(o.relations));
      for (const p of o.path) need(Array.isArray(p) && p.length === 2 && tag(p[0])
        && Array.isArray(p[1]) && p[1].length <= 4 && new Set(p[1]).size === p[1].length
        && p[1].every((c) => safe('classes', c)));
      const selected = ['summary', 'dl', 'method'].flatMap((family) =>
        s.roots[family].flatMap((root, ordinal) => root.relation === 'selected' ? [[family, ordinal]] : []));
      need(o.relations.length === selected.length);
      for (const [i, relation] of o.relations.entries()) need(Array.isArray(relation) && relation.length === 3
        && relation[0] === selected[i][0] && relation[1] === selected[i][1]
        && ['same', 'ancestor', 'descendant', 'disjoint'].includes(relation[2]));
    }
  }
}
