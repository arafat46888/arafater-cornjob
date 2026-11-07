/**
 * store.js — Persistence layer
 * ------------------------------------------------------------------
 * If MONGO_URI is set  -> MongoDB (Mongoose) is used (recommended for Render,
 *                          since the free tier filesystem is ephemeral).
 * Otherwise            -> lowdb JSON file at ./data/db.json (local dev fallback).
 *
 * The exposed API is intentionally tiny and async so both backends are
 * interchangeable:
 *    await store.init()
 *    await store.listTargets()
 *    await store.getTarget(id)
 *    await store.createTarget(doc)
 *    await store.updateTarget(id, patch)     -> returns updated doc or null
 *    await store.deleteTarget(id)            -> returns true if removed
 *    await store.addLog(entry)               -> keeps last ~500 logs
 *    await store.getLogs(limit = 50)
 *    await store.bumpCounters({ sent, success, fail, totalLatency })
 *    await store.getCounters()
 */

'use strict';

const path = require('path');
const fs = require('fs');

const MAX_LOGS = 500;

/* ------------------------------ helpers ------------------------------ */

function normalizeTarget(t) {
  if (!t) return null;
  return {
    id: String(t._id || t.id),
    name: t.name,
    url: t.url,
    intervalSec: t.intervalSec,
    method: t.method || 'HEAD',
    paused: !!t.paused,
    createdAt: t.createdAt || Date.now(),
    // runtime stats (persisted so counters survive restarts)
    lastPingAt: t.lastPingAt == null ? null : t.lastPingAt,
    lastStatus: t.lastStatus == null ? null : t.lastStatus,
    lastLatencyMs: t.lastLatencyMs == null ? null : t.lastLatencyMs,
    lastError: t.lastError || null,
    okCount: t.okCount || 0,
    failCount: t.failCount || 0,
    nextRunAt: t.nextRunAt || null,
  };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ------------------------------ lowdb -------------------------------- */

async function createLowdbStore(dataDir) {
  // lowdb v7 is ESM-only -> dynamic import works in CJS on Node >= 14.
  const { Low } = await import('lowdb');
  const { JSONFile } = await import('lowdb/node');

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  const defaults = {
    targets: [],
    logs: [],
    counters: { sent: 0, success: 0, fail: 0, totalLatency: 0, latencySamples: 0 },
  };
  const adapter = new JSONFile(file);
  const db = new Low(adapter, defaults);
  await db.read();
  db.data = db.data || defaults;
  db.data.targets = db.data.targets || [];
  db.data.logs = db.data.logs || [];
  db.data.counters = Object.assign({}, defaults.counters, db.data.counters || {});

  return {
    driver: 'lowdb',
    async init() { /* already loaded */ },
    async listTargets() { return db.data.targets.map(normalizeTarget); },
    async getTarget(id) {
      const t = db.data.targets.find((x) => x.id === id);
      return t ? normalizeTarget(t) : null;
    },
    async createTarget(doc) {
      const t = Object.assign({ id: newId() }, doc);
      db.data.targets.push(t);
      await db.write();
      return normalizeTarget(t);
    },
    async updateTarget(id, patch) {
      const t = db.data.targets.find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      await db.write();
      return normalizeTarget(t);
    },
    async deleteTarget(id) {
      const idx = db.data.targets.findIndex((x) => x.id === id);
      if (idx === -1) return false;
      db.data.targets.splice(idx, 1);
      await db.write();
      return true;
    },
    async addLog(entry) {
      db.data.logs.unshift(Object.assign({ id: newId(), ts: Date.now() }, entry));
      if (db.data.logs.length > MAX_LOGS) db.data.logs.length = MAX_LOGS;
      await db.write();
    },
    async getLogs(limit = 50) {
      return db.data.logs.slice(0, limit);
    },
    async bumpCounters(d) {
      const c = db.data.counters;
      c.sent += d.sent || 0;
      c.success += d.success || 0;
      c.fail += d.fail || 0;
      if (typeof d.totalLatency === 'number') {
        c.totalLatency += d.totalLatency;
        c.latencySamples += 1;
      }
      await db.write();
    },
    async getCounters() {
      return Object.assign({ sent: 0, success: 0, fail: 0, totalLatency: 0, latencySamples: 0 }, db.data.counters);
    },
  };
}

/* ------------------------------ mongoose ----------------------------- */

async function createMongoStore(uri) {
  const mongoose = require('mongoose');
  mongoose.set('strictQuery', true);

  const TargetSchema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      url: { type: String, required: true },
      intervalSec: { type: Number, default: 300 },
      method: { type: String, enum: ['GET', 'HEAD'], default: 'HEAD' },
      paused: { type: Boolean, default: false },
      lastPingAt: Number,
      lastStatus: Number,
      lastLatencyMs: Number,
      lastError: String,
      okCount: { type: Number, default: 0 },
      failCount: { type: Number, default: 0 },
      nextRunAt: Number,
    },
    { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }, versionKey: false }
  );

  const LogSchema = new mongoose.Schema(
    {
      targetId: String,
      targetName: String,
      status: Number,
      latencyMs: Number,
      error: String,
      manual: Boolean,
      ts: { type: Number, default: () => Date.now(), index: true },
    },
    { versionKey: false }
  );

  const CounterSchema = new mongoose.Schema(
    {
      key: { type: String, unique: true, default: 'global' },
      sent: Number,
      success: Number,
      fail: Number,
      totalLatency: Number,
      latencySamples: Number,
    },
    { versionKey: false }
  );

  const Target = mongoose.model('Target', TargetSchema);
  const Log = mongoose.model('Log', LogSchema);
  const Counter = mongoose.model('Counter', CounterSchema);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  // Ensure the global counter doc exists.
  let counterDoc = await Counter.findOne({ key: 'global' }).lean();
  if (!counterDoc) {
    counterDoc = await Counter.create({ key: 'global', sent: 0, success: 0, fail: 0, totalLatency: 0, latencySamples: 0 });
  }

  return {
    driver: 'mongodb',
    async init() {},
    async listTargets() {
      const docs = await Target.find().sort({ createdAt: 1 }).lean();
      return docs.map(normalizeTarget);
    },
    async getTarget(id) {
      try {
        const doc = await Target.findById(id).lean();
        return doc ? normalizeTarget(doc) : null;
      } catch {
        return null;
      }
    },
    async createTarget(doc) {
      const created = await Target.create(doc);
      return normalizeTarget(created.toObject());
    },
    async updateTarget(id, patch) {
      try {
        const updated = await Target.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
        return updated ? normalizeTarget(updated) : null;
      } catch {
        return null;
      }
    },
    async deleteTarget(id) {
      try {
        const r = await Target.findByIdAndDelete(id);
        return !!r;
      } catch {
        return false;
      }
    },
    async addLog(entry) {
      await Log.create(Object.assign({ ts: Date.now() }, entry));
      // Trim occasionally so we don't run a delete query on every ping.
      const count = await Log.estimatedDocumentCount();
      if (count > MAX_LOGS * 2) {
        const keep = await Log.find().sort({ ts: -1 }).skip(MAX_LOGS).limit(1).select('ts').lean();
        if (keep[0]) await Log.deleteMany({ ts: { $lt: keep[0].ts } });
      }
    },
    async getLogs(limit = 50) {
      return Log.find().sort({ ts: -1 }).limit(limit).lean();
    },
    async bumpCounters(d) {
      const inc = { sent: d.sent || 0, success: d.success || 0, fail: d.fail || 0 };
      if (typeof d.totalLatency === 'number') {
        inc.totalLatency = d.totalLatency;
        inc.latencySamples = 1;
      }
      await Counter.updateOne({ key: 'global' }, { $inc: inc });
    },
    async getCounters() {
      const c = await Counter.findOne({ key: 'global' }).lean();
      return c || { sent: 0, success: 0, fail: 0, totalLatency: 0, latencySamples: 0 };
    },
  };
}

/* ------------------------------ factory ------------------------------ */

async function createStore() {
  const mongoUri = process.env.MONGO_URI && process.env.MONGO_URI.trim();
  if (mongoUri) {
    try {
      const s = await createMongoStore(mongoUri);
      console.log('[store] Using MongoDB persistence');
      return s;
    } catch (err) {
      console.error('[store] MongoDB connection failed, falling back to local JSON:', err.message);
    }
  }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const s = await createLowdbStore(dataDir);
  console.log('[store] Using lowdb JSON persistence at', path.join(dataDir, 'db.json'));
  return s;
}

module.exports = { createStore, normalizeTarget };
