import crypto from 'node:crypto';

/**
 * A tiny in-memory stand-in for the parts of the MongoDB driver this app uses.
 * Enabled with MONGO_URI=memory: handy for a first look at the dashboard and for tests.
 * Nothing is persisted — paper-day counts, the journal and open trades vanish on restart.
 */
const clone = (v) => structuredClone(v);
const cmp = (a, b) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);

function matchValue(value, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$in') return arg.some((x) => matchValue(value, x));
      if (op === '$ne') return !matchValue(value, arg);
      if (op === '$gte') return value != null && cmp(value, arg) >= 0;
      if (op === '$lte') return value != null && cmp(value, arg) <= 0;
      if (op === '$gt') return value != null && cmp(value, arg) > 0;
      if (op === '$lt') return value != null && cmp(value, arg) < 0;
      throw new Error(`memoryDb: unsupported operator ${op}`);
    });
  }
  if (value instanceof Date && cond instanceof Date) return value.getTime() === cond.getTime();
  return value === cond;
}

const matches = (doc, filter = {}) => Object.entries(filter).every(([k, c]) => matchValue(doc[k], c));

class Cursor {
  constructor(docs, projection) {
    this.docs = docs;
    this.projection = projection;
  }
  sort(spec) {
    const keys = Object.entries(spec);
    this.docs.sort((a, b) => {
      for (const [k, dir] of keys) {
        if (a[k] == null && b[k] == null) continue;
        if (a[k] == null) return -dir;
        if (b[k] == null) return dir;
        const c = typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : cmp(a[k], b[k]);
        if (c) return c * dir;
      }
      return 0;
    });
    return this;
  }
  limit(n) {
    this.docs = this.docs.slice(0, n);
    return this;
  }
  async toArray() {
    return this.docs.map((d) => {
      const out = clone(d);
      for (const [k, v] of Object.entries(this.projection || {})) if (!v) delete out[k];
      return out;
    });
  }
}

class Collection {
  constructor() {
    this.docs = new Map();
  }
  async createIndex() {}
  async insertOne(doc) {
    const d = clone(doc);
    d._id ??= crypto.randomUUID();
    if (this.docs.has(d._id)) throw new Error(`memoryDb: duplicate _id ${d._id}`);
    this.docs.set(d._id, d);
    return { insertedId: d._id };
  }
  async updateOne(filter, update, { upsert = false } = {}) {
    let doc = [...this.docs.values()].find((d) => matches(d, filter));
    if (!doc) {
      if (!upsert) return { matchedCount: 0 };
      doc = { _id: filter._id ?? crypto.randomUUID() };
      for (const [k, v] of Object.entries(filter)) if (typeof v !== 'object' || v instanceof Date) doc[k] = v;
      this.docs.set(doc._id, doc);
    }
    Object.assign(doc, clone(update.$set || {}));
    return { matchedCount: 1 };
  }
  async findOne(filter) {
    const d = [...this.docs.values()].find((x) => matches(x, filter));
    return d ? clone(d) : null;
  }
  find(filter, { projection } = {}) {
    return new Cursor([...this.docs.values()].filter((d) => matches(d, filter)), projection);
  }
  async countDocuments(filter) {
    return [...this.docs.values()].filter((d) => matches(d, filter)).length;
  }
}

export class MemoryDb {
  constructor() {
    this.cols = new Map();
  }
  collection(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Collection());
    return this.cols.get(name);
  }
  async dropDatabase() {
    this.cols.clear();
  }
}
