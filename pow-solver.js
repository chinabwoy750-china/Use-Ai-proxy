
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotl(x, n) {
  n %= 64;
  if (!n) return x & 0xffffffffffffffffn;
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & 0xffffffffffffffffn;
}

function keccakF23(a) {
  for (let round = 1; round < 24; round++) {
    const c0 = a[0] ^ a[5] ^ a[10] ^ a[15] ^ a[20];
    const c1 = a[1] ^ a[6] ^ a[11] ^ a[16] ^ a[21];
    const c2 = a[2] ^ a[7] ^ a[12] ^ a[17] ^ a[22];
    const c3 = a[3] ^ a[8] ^ a[13] ^ a[18] ^ a[23];
    const c4 = a[4] ^ a[9] ^ a[14] ^ a[19] ^ a[24];
    const d0 = c4 ^ rotl(c1, 1);
    const d1 = c0 ^ rotl(c2, 1);
    const d2 = c1 ^ rotl(c3, 1);
    const d3 = c2 ^ rotl(c4, 1);
    const d4 = c3 ^ rotl(c0, 1);
    a[0] ^= d0; a[5] ^= d0; a[10] ^= d0; a[15] ^= d0; a[20] ^= d0;
    a[1] ^= d1; a[6] ^= d1; a[11] ^= d1; a[16] ^= d1; a[21] ^= d1;
    a[2] ^= d2; a[7] ^= d2; a[12] ^= d2; a[17] ^= d2; a[22] ^= d2;
    a[3] ^= d3; a[8] ^= d3; a[13] ^= d3; a[18] ^= d3; a[23] ^= d3;
    a[4] ^= d4; a[9] ^= d4; a[14] ^= d4; a[19] ^= d4; a[24] ^= d4;

    const b = new Array(25);
    b[0] = a[0];
    b[1] = rotl(a[6], 44);
    b[2] = rotl(a[12], 43);
    b[3] = rotl(a[18], 21);
    b[4] = rotl(a[24], 14);
    b[5] = rotl(a[3], 28);
    b[6] = rotl(a[9], 20);
    b[7] = rotl(a[10], 3);
    b[8] = rotl(a[16], 45);
    b[9] = rotl(a[22], 61);
    b[10] = rotl(a[1], 1);
    b[11] = rotl(a[7], 6);
    b[12] = rotl(a[13], 25);
    b[13] = rotl(a[19], 8);
    b[14] = rotl(a[20], 18);
    b[15] = rotl(a[4], 27);
    b[16] = rotl(a[5], 36);
    b[17] = rotl(a[11], 10);
    b[18] = rotl(a[17], 15);
    b[19] = rotl(a[23], 56);
    b[20] = rotl(a[2], 62);
    b[21] = rotl(a[8], 55);
    b[22] = rotl(a[14], 39);
    b[23] = rotl(a[15], 41);
    b[24] = rotl(a[21], 2);

    a[0] = b[0] ^ ((~b[1]) & b[2]);
    a[1] = b[1] ^ ((~b[2]) & b[3]);
    a[2] = b[2] ^ ((~b[3]) & b[4]);
    a[3] = b[3] ^ ((~b[4]) & b[0]);
    a[4] = b[4] ^ ((~b[0]) & b[1]);
    a[5] = b[5] ^ ((~b[6]) & b[7]);
    a[6] = b[6] ^ ((~b[7]) & b[8]);
    a[7] = b[7] ^ ((~b[8]) & b[9]);
    a[8] = b[8] ^ ((~b[9]) & b[5]);
    a[9] = b[9] ^ ((~b[5]) & b[6]);
    a[10] = b[10] ^ ((~b[11]) & b[12]);
    a[11] = b[11] ^ ((~b[12]) & b[13]);
    a[12] = b[12] ^ ((~b[13]) & b[14]);
    a[13] = b[13] ^ ((~b[14]) & b[10]);
    a[14] = b[14] ^ ((~b[10]) & b[11]);
    a[15] = b[15] ^ ((~b[16]) & b[17]);
    a[16] = b[16] ^ ((~b[17]) & b[18]);
    a[17] = b[17] ^ ((~b[18]) & b[19]);
    a[18] = b[18] ^ ((~b[19]) & b[15]);
    a[19] = b[19] ^ ((~b[15]) & b[16]);
    a[20] = b[20] ^ ((~b[21]) & b[22]);
    a[21] = b[21] ^ ((~b[22]) & b[23]);
    a[22] = b[22] ^ ((~b[23]) & b[24]);
    a[23] = b[23] ^ ((~b[24]) & b[20]);
    a[24] = b[24] ^ ((~b[20]) & b[21]);

    a[0] ^= RC[round];
  }
}

function deepseekHashV1(data) {
  const rate = 136;
  const a = new Array(25).fill(0n);
  let off = 0;
  while (off + rate <= data.length) {
    for (let i = 0; i < 17; i++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v |= BigInt(data[off + i * 8 + b]) << BigInt(b * 8);
      a[i] ^= v;
    }
    keccakF23(a);
    off += rate;
  }
  const block = Buffer.alloc(rate);
  data.copy(block, 0, off);
  block[data.length - off] = 0x06;
  block[rate - 1] |= 0x80;
  for (let i = 0; i < 17; i++) {
    let v = 0n;
    for (let b = 0; b < 8; b++) v |= BigInt(block[i * 8 + b]) << BigInt(b * 8);
    a[i] ^= v;
  }
  keccakF23(a);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    let v = a[i];
    for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((v >> BigInt(b * 8)) & 0xffn);
  }
  return out;
}

function solveChallengeSync(challenge) {
  const difficulty = parseInt(challenge.difficulty, 10) || 144000;
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const target = String(challenge.challenge).toLowerCase();
  for (let answer = 0; answer < difficulty; answer++) {
    const h = deepseekHashV1(Buffer.from(prefix + String(answer), 'utf8'));
    if (h.toString('hex') === target) return answer;
  }
  throw new Error('PoW solve failed within difficulty');
}

function solveChallengeAsync(challenge) {
  if (!isMainThread) return Promise.resolve(solveChallengeSync(challenge));
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { challenge } });
    const timer = setTimeout(() => { try { worker.terminate(); } catch {} reject(new Error('PoW solve timed out')); }, 90000);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch {}
      if (msg.ok) resolve(msg.answer);
      else reject(new Error(msg.error));
    });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function buildPowHeader(answer, challengeStr, salt, signature, targetPath) {
  return Buffer.from(JSON.stringify({
    algorithm: 'DeepSeekHashV1',
    challenge: challengeStr,
    salt,
    answer: Math.floor(Number(answer)),
    signature,
    target_path: targetPath,
  })).toString('base64');
}

if (!isMainThread && workerData && workerData.challenge) {
  try {
    parentPort.postMessage({ ok: true, answer: solveChallengeSync(workerData.challenge) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.stack) || e) });
  }
}

module.exports = { solveChallengeAsync, buildPowHeader, solveChallengeSync, deepseekHashV1 };
