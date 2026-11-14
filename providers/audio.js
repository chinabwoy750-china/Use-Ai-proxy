'use strict';
/**
 * Audio endpoints (9router / OmniRoute style)
 * POST /v1/audio/speech          — TTS
 * POST /v1/audio/transcriptions  — STT (API key providers)
 * GET  /v1/models/audio
 */

const { fetch: undiciFetch } = require('undici');

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function envKey(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  try {
    const all = JSON.parse(process.env.PROVIDER_CONNECTIONS || '{}');
    for (const id of Object.keys(all)) {
      for (const a of all[id].accounts || []) {
        const vals = a.values || {};
        for (const k of keys) if (vals[k]) return String(vals[k]).trim();
        if (a.key) return String(a.key).trim();
      }
    }
  } catch (_) {}
  return '';
}

const TTS_MODELS = [
  { id: 'edge/tts', kind: 'tts', provider: 'edge', auth: 'none', label: 'Microsoft Edge TTS (free)' },
  { id: 'google/tts', kind: 'tts', provider: 'google', auth: 'none', label: 'Google Translate TTS (free)' },
  { id: 'openai/tts-1', kind: 'tts', provider: 'openai', auth: 'apiKey', label: 'OpenAI TTS' },
  { id: 'elevenlabs/tts', kind: 'tts', provider: 'elevenlabs', auth: 'apiKey', label: 'ElevenLabs' },
];

const STT_MODELS = [
  { id: 'openai/whisper-1', kind: 'stt', provider: 'openai', auth: 'apiKey', label: 'OpenAI Whisper' },
  { id: 'deepgram/nova-2', kind: 'stt', provider: 'deepgram', auth: 'apiKey', label: 'Deepgram Nova-2' },
  { id: 'assemblyai/best', kind: 'stt', provider: 'assemblyai', auth: 'apiKey', label: 'AssemblyAI' },
];

function pickModel(model, list) {
  const m = String(model || '').toLowerCase();
  return list.find((x) => x.id === m) || list.find((x) => m.includes(x.provider)) || list[0];
}

/** Free Google Translate TTS → mp3 */
async function googleTts(text, voice) {
  const tl = (voice || 'en').split('-')[0] || 'en';
  const url =
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text.slice(0, 180))}`;
  const r = await undiciFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://translate.google.com/',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('Google TTS ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

/** Edge-style public TTS via speech endpoint (best-effort free) */
async function edgeTts(text, voice) {
  // Use Google as reliable free fallback when edge package unavailable
  try {
    return await googleTts(text, voice || 'en-US');
  } catch (e) {
    throw new Error('Edge/Google TTS failed: ' + (e.message || e));
  }
}

async function openaiTts(text, model, voice) {
  const key = envKey('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY required');
  const r = await undiciFetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model.includes('tts') ? model.replace(/^openai\//, '') : 'tts-1',
      input: text,
      voice: voice || 'alloy',
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('OpenAI TTS ' + r.status + ': ' + (await r.text()).slice(0, 120));
  return Buffer.from(await r.arrayBuffer());
}

async function elevenTts(text, voice) {
  const key = envKey('ELEVENLABS_API_KEY', 'ELEVEN_API_KEY');
  if (!key) throw new Error('ELEVENLABS_API_KEY required');
  const voiceId = voice || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const r = await undiciFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text, model_id: 'eleven_monolingual_v1' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('ElevenLabs ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function handleSpeech(opts, res) {
  const text = String(opts.input || opts.text || opts.prompt || '').trim();
  if (!text) return sendJson(res, 400, { error: { message: 'input text required' } });
  const meta = pickModel(opts.model, TTS_MODELS);
  const voice = opts.voice || opts.language || 'en';
  try {
    let buf;
    if (meta.provider === 'openai') buf = await openaiTts(text, meta.id, voice);
    else if (meta.provider === 'elevenlabs') buf = await elevenTts(text, voice);
    else if (meta.provider === 'google') buf = await googleTts(text, voice);
    else buf = await edgeTts(text, voice);

    const fmt = String(opts.response_format || 'mp3').toLowerCase();
    if (fmt === 'b64_json' || fmt === 'base64') {
      return sendJson(res, 200, {
        object: 'audio.speech',
        model: meta.id,
        data: buf.toString('base64'),
      });
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    return sendJson(res, 502, { error: { message: e.message || String(e) } });
  }
}

async function handleTranscription(opts, res) {
  // Minimal STT stub — requires API keys; multipart handled by server
  return sendJson(res, 501, {
    error: {
      message:
        'STT: send audio to OpenAI/Deepgram/AssemblyAI with API keys in Admin. Use model openai/whisper-1 | deepgram/nova-2 | assemblyai/best',
    },
  });
}

function listModels() {
  return { object: 'list', data: [...TTS_MODELS, ...STT_MODELS] };
}

module.exports = {
  handleSpeech,
  handleTranscription,
  listModels,
  TTS_MODELS,
  STT_MODELS,
};
