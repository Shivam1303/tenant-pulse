"use strict";

const crypto = require("crypto");

// Values a request makes up fresh on every send, such as an order UUID or a
// primary key. Each generated field becomes a {{name}} variable.
const TYPES = ["uuid", "counter", "number", "pick", "timestamp", "text"];

const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

// Counters are shared by every tenant and VU in a run, so two sends never get
// the same number. A counter starts at its own start value, or at the current
// time in milliseconds, and never below the value the last run ended on.
class Counters {
  constructor(saved = {}) {
    this.saved = saved;
    this.next = new Map();
  }
  take(key, start) {
    let n = this.next.get(key);
    if (n == null) n = Math.max(start == null ? Date.now() : start, this.saved[key] || 0);
    this.next.set(key, n + 1);
    return n;
  }
  // Where each counter used in this run would continue from.
  snapshot() {
    return { ...this.saved, ...Object.fromEntries(this.next) };
  }
}

function one(g, requestName, counters) {
  switch (g.type) {
    case "uuid":
      return crypto.randomUUID();
    case "counter":
      return counters.take(`${requestName}::${g.name}`, g.start);
    case "number":
      return g.min + Math.floor(Math.random() * (g.max - g.min + 1));
    case "pick":
      return g.values[Math.floor(Math.random() * g.values.length)];
    case "timestamp":
      return g.format === "epoch" ? Date.now() : new Date().toISOString();
    default: {
      let out = "";
      for (let i = 0; i < g.length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
      return out;
    }
  }
}

// The variables one send of `spec` adds to the tenant's own.
function generate(spec, counters) {
  const out = {};
  for (const g of spec.generated || []) out[g.name] = String(one(g, spec.name, counters));
  return out;
}

module.exports = { TYPES, Counters, generate };
