'use strict';
/**
 * Per-provider connection UI state (models, thinking, roundRobin, notes).
 * Secrets stay in env keys; this JSON holds structure only + optional multi-values.
 */
const DEFAULTS = {
  models: [],
  customModels: [],
  roundRobin: false,
  thinking: { enabled: false, budget: 0 },
  notes: '',
};

function readConnections() {
  try {
    const raw = process.env.PROVIDER_CONNECTIONS || '';
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeConnections(obj) {
  process.env.PROVIDER_CONNECTIONS = JSON.stringify(obj || {});
  return readConnections();
}

function getConnection(id) {
  const all = readConnections();
  return { ...DEFAULTS, ...(all[id] || {}) };
}

function setConnection(id, patch) {
  const all = readConnections();
  const prev = { ...DEFAULTS, ...(all[id] || {}) };
  const next = {
    ...prev,
    ...patch,
    thinking: { ...prev.thinking, ...(patch.thinking || {}) },
    models: Array.isArray(patch.models) ? patch.models : prev.models,
    customModels: Array.isArray(patch.customModels) ? patch.customModels : prev.customModels,
  };
  all[id] = next;
  writeConnections(all);
  return next;
}

function getAll() { return readConnections(); }
function setAll(obj) { return writeConnections(obj); }
module.exports = { readConnections, writeConnections, getConnection, setConnection, getAll, setAll, DEFAULTS };
