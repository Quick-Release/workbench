// In-memory doubles for the worker's runtime-free HTTP-contract suite
// (ticket #35). The D1 double mirrors the one in worker.test.mjs but
// applies every migration in worker/migrations, so the capture schema is
// present without touching the frozen ingest suite; the R2 double and the
// fake execution context are new seams this ticket's spec calls for.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function createD1Double() {
  const db = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("./migrations/", import.meta.url)).sort();
  for (const file of migrations) {
    db.exec(readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8"));
  }
  return {
    db,
    prepare(sql) {
      let params = [];
      return {
        bind(...args) {
          params = args.flat();
          return this;
        },
        async run() {
          db.prepare(sql).run(...params);
          return { success: true };
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...params) };
        },
      };
    },
  };
}

// The R2 surface the capture route uses: put(key, string) and get(key) →
// { text() } | null. The objects map doubles as the test's observation
// point, in the same spirit as the D1 double's exposed db.
export function createR2Double() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) {
      objects.set(key, String(value));
      return {};
    },
    async get(key) {
      if (!objects.has(key)) return null;
      const value = objects.get(key);
      return { text: async () => value };
    },
  };
}

// The runtime's execution context: post-response promises are collected so
// a test can await `settled()` before asserting on what capture wrote.
export function createCaptureContext() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    },
    async settled() {
      await Promise.allSettled(promises);
    },
  };
}
