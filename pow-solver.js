'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

// Resolve WASM relative to this module. Prefer sibling assets/, then ../assets/
const CANDIDATE_WASM = [
  path.join(__dirname, 'assets', 'sha3_wasm_bg.wasm'),
  path.join(__dirname, '..', 'assets', 'sha3_wasm_bg.wasm'),
  path.join(__dirname, 'sha3_wasm_bg.wasm'),
];
const WASM_PATH = CANDIDATE_WASM.find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
}) || CANDIDATE_WASM[0];

let wasmInstance = null;
let wasmMemory = null;

async function initWasm() {
  if (wasmInstance) return;
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(`WASM not found. Tried: ${CANDIDATE_WASM.join(', ')}`);
  }
  const wasmBytes = fs.readFileSync(WASM_PATH);
  const result = await WebAssembly.instantiate(wasmBytes);
  wasmInstance = result.instance;
  wasmMemory = wasmInstance.exports.memory;
}

function solveChallenge(challenge) {
  if (!wasmInstance) throw new Error('WASM not initialized — call initWasm() first');
  const exports = wasmInstance.exports;
  const memory = exports.memory;
  const wasm_solve = exports.wasm_solve;
  if (typeof wasm_solve !== 'function') {
    throw new Error('wasm_solve export missing — WASM binary outdated or wrong');
  }
  const add_to_stack_pointer = exports.__wbindgen_add_to_stack_pointer;
  const alloc = exports.__wbindgen_export_0;
  const free = exports.__wbindgen_export_2;

  const challengeStr = String(challenge.challenge || '');
  const salt = String(challenge.salt || '');
  const expireAt = challenge.expire_at;
  const prefix = `${salt}_${expireAt}_`;
  // Accept difficulty from several possible keys; default matches ds2api
  const difficulty = Number(
    challenge.difficulty ?? challenge.diff ?? challenge.target ?? 144000
  );
  if (!isFinite(difficulty) || difficulty <= 0) {
    throw new Error(
      `Invalid PoW difficulty: ${challenge.difficulty} (keys: ${Object.keys(challenge || {}).join(',')})`
    );
  }

  const challengeBytes = Buffer.from(challengeStr, 'utf-8');
  const challengePtr = alloc(challengeBytes.length, 1);
  new Uint8Array(memory.buffer, challengePtr, challengeBytes.length).set(challengeBytes);

  const prefixBytes = Buffer.from(prefix, 'utf-8');
  const prefixPtr = alloc(prefixBytes.length, 1);
  new Uint8Array(memory.buffer, prefixPtr, prefixBytes.length).set(prefixBytes);

  const stackRetPtr = add_to_stack_pointer(-16);

  try {
    wasm_solve(
      stackRetPtr,
      challengePtr,
      challengeBytes.length,
      prefixPtr,
      prefixBytes.length,
      difficulty
    );
    // memory may have grown; re-acquire view
    const memView = new DataView(exports.memory.buffer);
    const status = memView.getInt32(stackRetPtr, true);
    if (status === 0) throw new Error('WASM did not find a PoW solution within difficulty');
    const answer = memView.getFloat64(stackRetPtr + 8, true);
    if (!isFinite(answer)) throw new Error(`Invalid answer: ${answer}`);
    return answer;
  } finally {
    add_to_stack_pointer(16);
    try { free(challengePtr, challengeBytes.length, 1); } catch {}
    try { free(prefixPtr, prefixBytes.length, 1); } catch {}
  }
}

function solveChallengeAsync(challenge) {
  return new Promise((resolve, reject) => {
    const workerSrc = `
      const { parentPort } = require('worker_threads');
      const { initWasm, solveChallenge } = require(${JSON.stringify(__filename)});
      parentPort.on('message', async (challenge) => {
        try {
          await initWasm();
          const answer = solveChallenge(challenge);
          parentPort.postMessage({ ok: true, answer });
        } catch (err) {
          parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
        }
      });
    `;
    const worker = new Worker(workerSrc, { eval: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch {}
      reject(new Error('PoW solve timed out'));
    }, 45000);
    const done = () => { settled = true; clearTimeout(timer); };
    worker.once('message', (msg) => {
      if (settled) return;
      done();
      try { worker.terminate(); } catch {}
      if (msg.ok) resolve(msg.answer);
      else reject(new Error(msg.error));
    });
    worker.once('error', (err) => {
      if (settled) return;
      done();
      try { worker.terminate(); } catch {}
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      done();
      reject(new Error(code !== 0
        ? 'PoW worker exited with code ' + code
        : 'PoW worker exited before producing an answer'));
    });
    worker.postMessage(challenge);
  });
}

function buildPowHeader(answer, challengeStr, salt, signature, targetPath) {
  const obj = {
    algorithm: 'DeepSeekHashV1',
    challenge: challengeStr,
    salt: salt,
    answer: Math.floor(Number(answer)),
    signature: signature,
    target_path: targetPath || '/api/v0/chat/completion',
  };
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

module.exports = {
  solveChallenge,
  solveChallengeAsync,
  buildPowHeader,
  initWasm,
  WASM_PATH,
};
