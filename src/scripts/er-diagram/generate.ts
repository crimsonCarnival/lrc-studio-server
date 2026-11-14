import mongoose from 'mongoose';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENTITIES, EXPAND_BY_DEFAULT, EXTRA_EDGES, FIELD_NOTES, GROUPS, RAW } from './meta.js';

/**
 * CLI: build a zoomable ER diagram (one self-contained HTML page) from the live
 * Mongoose schemas. Imports every `*.model.ts` / `*.models.ts` under src/ and
 * reads `schema.paths` + `schema.indexes()`, so types, refs, enums, defaults and
 * indexes are what Mongoose actually registers. meta.ts adds what the schemas
 * can't say: domain groups, descriptions, and joins with no `ref` (publicId
 * string keys, polymorphic Report targets).
 *
 * No database connection is made.
 *
 * Usage (from server/):
 *   tsx src/scripts/er-diagram/generate.ts [out.html] [--bare]
 * Default out: ../er-diagram.html (the lrc-studio root, outside both git repos).
 * --bare omits the <!doctype>/<head> wrapper, for publishing as a claude.ai Artifact.
 *
 * Adding a model: the run fails until the model has an ENTITIES entry in meta.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '../../..');
const args = process.argv.slice(2);
const bare = args.includes('--bare');
const outFile = resolve(args.find((a) => !a.startsWith('--')) ?? join(serverDir, '..', 'er-diagram.html'));

type FieldNode = {
  k: string;
  path: string;
  t: string;
  ref?: string;
  refArr?: boolean;
  en?: string[];
  def?: string;
  lim?: string;
  doc?: string;
  note?: string;
  open?: boolean;
  f?: string[];
  ch?: FieldNode[];
};
type Entity = {
  name: string;
  collection: string;
  group: string;
  desc: string;
  file: string;
  timestamps: string;
  ttl: string | null;
  indexes: string[];
  fields: FieldNode[];
  raw?: boolean;
  legacy?: boolean;
};
type Edge = {
  id: number;
  from: string;
  fp: string;
  to: string;
  tp: string;
  kind: 'ref' | 'soft' | 'poly' | 'noref';
  srcMany: boolean;
  dstMany: boolean;
  note?: string;
};

// ---------- load models ----------
function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (n.endsWith('.model.ts') || n.endsWith('.models.ts')) acc.push(p);
  }
  return acc;
}

const rel = (p: string) => relative(serverDir, p).replace(/\\/g, '/');
const fileOfModel: Record<string, string> = {};
for (const f of walk(join(serverDir, 'src'))) {
  const before = new Set(mongoose.modelNames());
  await import(pathToFileURL(f).href);
  for (const m of mongoose.modelNames()) if (!before.has(m)) fileOfModel[m] = rel(f);
}

// JSDoc directly above `name:` in a model file, used as that field's tooltip.
// Interface and schema often both document a field; the longer note wins.
const docCache: Record<string, Record<string, string>> = {};
function fieldDocs(file: string): Record<string, string> {
  if (docCache[file]) return docCache[file];
  const src = readFileSync(join(serverDir, file), 'utf8');
  const docs: Record<string, string> = {};
  const re = /\/\*\*([\s\S]*?)\*\/\s*(?:readonly\s+)?['"]?([A-Za-z_]\w*)['"]?\??\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const text = m[1].replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim();
    if (!docs[m[2]] || docs[m[2]].length < text.length) docs[m[2]] = text;
  }
  return (docCache[file] = docs);
}

const human = (s: number) => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : `${s} s`);

// ---------- describe schemas ----------
const entities: Entity[] = [];
for (const name of mongoose.modelNames().sort()) {
  const model = mongoose.model(name);
  const schema = model.schema;
  const file = fileOfModel[name];
  const meta = ENTITIES[name];
  if (!meta) throw new Error(`Model ${name} (${file}) has no ENTITIES entry in meta.ts — add its group and description.`);
  const docs = fieldDocs(file);

  // Index facts per dotted path.
  const idx: Record<string, Set<string>> = {};
  const indexList: string[] = [];
  let ttl: string | null = null;
  for (const [keys, opts = {}] of schema.indexes() as [Record<string, unknown>, Record<string, unknown>?][]) {
    const ks = Object.keys(keys);
    const exp = opts.expireAfterSeconds as number | undefined;
    indexList.push(
      `{ ${ks.map((k) => `${k}: ${String(keys[k])}`).join(', ')} }` +
        (opts.unique ? ' unique' : '') +
        (opts.sparse ? ' sparse' : '') +
        (opts.partialFilterExpression ? ' partial' : '') +
        (exp !== undefined ? ` TTL ${human(exp)}` : ''),
    );
    if (exp !== undefined) ttl = `${ks[0]} + ${human(exp)}`;
    for (const k of ks) {
      const s = (idx[k] ??= new Set());
      if (ks.length === 1) {
        s.add(opts.unique ? 'UQ' : 'IX');
        if (exp !== undefined) s.add('TTL');
      } else s.add(opts.unique ? 'CU' : 'CX');
    }
  }

  // `any`: SchemaType internals (caster, embeddedSchemaType, enumValues, options.ref
  // as a function) are not in Mongoose's public typings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function describe(st: any, key: string, full: string): FieldNode {
    const o = st.options ?? {};
    const n: FieldNode = { k: key, path: full, t: st.instance };
    const flags = new Set(idx[full] ?? []);
    if (full === '_id') flags.add('PK');
    if (o.required) flags.add('REQ');
    if (o.unique) flags.add('UQ');
    if (o.index && !flags.has('UQ') && !flags.has('TTL')) flags.add('IX');
    if (o.expires !== undefined) flags.add('TTL');
    if (o.select === false) flags.add('HID');

    let ref = o.ref;
    let enumValues: unknown[] | undefined = st.enumValues?.length ? st.enumValues : Array.isArray(o.enum) ? o.enum : undefined;
    if (st.instance === 'Array') {
      const c = st.caster ?? st.embeddedSchemaType;
      ref ??= c?.options?.ref ?? o.type?.[0]?.ref;
      if (c?.enumValues?.length) enumValues = c.enumValues;
      if (st.schema) n.t = 'arr';
      else n.t = `${c?.instance ?? 'Mixed'}[]`;
    } else if (st.schema) n.t = 'obj';
    if (typeof ref === 'function') throw new Error(`${name}.${full}: function refs are not supported`);
    if (ref && typeof ref === 'object') ref = ref.modelName;
    if (ref) {
      n.ref = ref;
      n.refArr = st.instance === 'Array';
      flags.add('FK');
    }
    if (enumValues) n.en = enumValues.map((v) => (v === null ? 'null' : String(v)));
    if (typeof o.default === 'function') {
      // Named generators read well (now() for Date.now); wrappers and arrows don't.
      if (!st.schema) n.def = o.default.name && !['default', 'anon'].includes(o.default.name) ? `${o.default.name}()` : 'computed';
    } else if (o.default !== undefined && !(Array.isArray(o.default) && !o.default.length)) {
      n.def = JSON.stringify(o.default);
    }
    const lim = (['min', 'max', 'minlength', 'maxlength'] as const).filter((x) => o[x] !== undefined).map((x) => `${x} ${o[x]}`);
    if (lim.length) n.lim = lim.join(' · ');
    if (docs[key]) n.doc = docs[key];
    if (FIELD_NOTES[`${name}.${full}`]) n.note = FIELD_NOTES[`${name}.${full}`];
    if (st.schema) {
      n.ch = tree(st.schema, full, true);
      if (EXPAND_BY_DEFAULT.includes(`${name}.${full}`)) n.open = true;
    }
    if (flags.size) n.f = [...flags];
    return n;
  }

  // Mongoose reports nested plain objects as dotted paths ("title.en"); rebuild the nesting.
  function tree(s: { paths: Record<string, unknown> }, prefix: string, inSub: boolean): FieldNode[] {
    const roots: FieldNode[] = [];
    const groups = new Map<string, FieldNode>();
    for (const [path, st] of Object.entries(s.paths)) {
      if (path === '__v' || (inSub && path === '_id')) continue;
      const parts = path.split('.');
      let list = roots;
      let pfx = prefix;
      for (const part of parts.slice(0, -1)) {
        pfx = pfx ? `${pfx}.${part}` : part;
        let g = groups.get(pfx);
        if (!g) {
          g = { k: part, path: pfx, t: 'obj', ch: [] };
          groups.set(pfx, g);
          list.push(g);
        }
        list = g.ch!;
      }
      list.push(describe(st, parts[parts.length - 1], prefix ? `${prefix}.${path}` : path));
    }
    return roots;
  }

  const tsOpt = schema.get('timestamps') as boolean | Record<string, boolean> | undefined;
  const timestamps =
    tsOpt === true ? 'createdAt, updatedAt'
    : tsOpt ? Object.entries(tsOpt).filter(([, v]) => v).map(([k]) => k).join(', ') || 'off'
    : 'off';

  entities.push({ name, collection: model.collection.collectionName, group: meta[0], desc: meta[1], file: `server/${file}`, timestamps, ttl, indexes: indexList, fields: tree(schema, '', false) });
}

for (const r of RAW) {
  entities.push({
    name: r.name, collection: r.collection, group: r.group, desc: r.desc, file: `server/${r.file}`,
    timestamps: '—', ttl: r.name.startsWith('socket') ? 'createdAt' : null, indexes: [], raw: true, legacy: !!r.legacy,
    fields: r.fields.map((f) => ({ k: f.p, path: f.p, t: f.t, f: f.f })),
  });
}
const stale = Object.keys(ENTITIES).filter((n) => !entities.some((e) => e.name === n));
if (stale.length) throw new Error(`meta.ts describes models that no longer exist: ${stale.join(', ')}`);

// ---------- relationships ----------
const byName = Object.fromEntries(entities.map((e) => [e.name, e]));
function find(entity: string, path: string): FieldNode | undefined {
  const w = (ns: FieldNode[]): FieldNode | undefined => {
    for (const n of ns) {
      if (n.path === path) return n;
      const r = n.ch && w(n.ch);
      if (r) return r;
    }
  };
  return byName[entity] && w(byName[entity].fields);
}
const isOne = (n: FieldNode) => (n.f ?? []).some((x) => x === 'UQ' || x === 'PK');

const edges: Edge[] = [];
for (const e of entities) {
  const w = (ns: FieldNode[], inArr: boolean) => {
    for (const n of ns) {
      if (n.ref) {
        if (!byName[n.ref]) throw new Error(`${e.name}.${n.path} refs unknown model ${n.ref}`);
        edges.push({ id: edges.length, from: e.name, fp: n.path, to: n.ref, tp: '_id', kind: 'ref', srcMany: !(isOne(n) && !inArr), dstMany: !!n.refArr });
      }
      if (n.ch) w(n.ch, inArr || n.t === 'arr');
    }
  };
  w(e.fields, false);
}
for (const x of EXTRA_EDGES) {
  const [fe, ...fp] = x.from.split('.');
  const [te, ...tp] = x.to.split('.');
  const fn = find(fe, fp.join('.'));
  if (!fn) throw new Error(`EXTRA_EDGES: no field ${x.from} — was it renamed?`);
  if (!find(te, tp.join('.'))) throw new Error(`EXTRA_EDGES: no field ${x.to} — was it renamed?`);
  edges.push({ id: edges.length, from: fe, fp: fp.join('.'), to: te, tp: tp.join('.'), kind: x.kind, srcMany: !isOne(fn), dstMany: !!x.many, note: x.note });
}

// ---------- provenance + output ----------
const git = (...a: string[]) => {
  try {
    return execFileSync('git', a, { cwd: serverDir, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const dirty = git('status', '--porcelain', '--', 'src')
  .split('\n')
  .map((l) => l.slice(3))
  .filter((p) => /\.models?\.ts$/.test(p))
  .map((p) => p.split('/').pop()!);

const data = {
  generated: { date: new Date().toISOString().slice(0, 10), branch: git('rev-parse', '--abbrev-ref', 'HEAD') || '?', commit: git('rev-parse', '--short', 'HEAD') || '?', dirty },
  groups: GROUPS,
  entities,
  edges,
};
// `<` escaped so no string in the data can close the <script> it is inlined into.
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const page = readFileSync(join(here, 'template.html'), 'utf8').replace('/*__DATA__*/null', json);
const wrapped = bare
  ? page
  : '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<style>body{margin:0;font:14px system-ui,sans-serif}[hidden]{display:none!important}</style>\n' +
    page + '\n</html>\n';
writeFileSync(outFile, wrapped);

const soft = edges.filter((e) => e.kind !== 'ref').length;
console.log(`✓ ${entities.length} entities, ${edges.length} relationships (${soft} without ref) → ${outFile}`);
process.exit(0); // model imports can leave handles open (timers, listeners)
