// The sound's decoder: WebCodecs' AudioDecoder where the browser has one for
// the codec; otherwise, for AC-3 and E-AC-3 (Dolby Digital, Dolby Digital
// Plus), which no browser's WebCodecs decodes, the one built into the app
// (crates/unflash-ac3, in the decoders module), behind the same interface,
// so that the section player's sound and the export's re-encode use either
// the same way.

import { loadDecoders } from './codecs.js';

/** The codecs the built-in sound decoder reads. */
const BUILT_IN_SOUND = /^(ac-3|ec-3|mp4a\.a5|mp4a\.a6)$/i;

/** Whether the app has a decoder of its own for the sound `codec`. */
export function builtInSound(codec) {
  return BUILT_IN_SOUND.test(codec || '');
}

/**
 * A decoder for the sound configured by `cfg` ({ codec, sampleRate,
 * numberOfChannels, description }): `{ Decoder, builtIn }`, the class to
 * make it from (AudioDecoder, or BuiltInAudioDecoder, whose sound comes
 * mixed down to stereo), or null where neither can decode it.
 */
export async function soundDecoderFor(cfg) {
  if (typeof AudioDecoder !== 'undefined') {
    try {
      if ((await AudioDecoder.isConfigSupported(cfg)).supported) return { Decoder: AudioDecoder, builtIn: false };
    } catch (e) {
      /* not this way */
    }
  }
  if (builtInSound(cfg.codec) && typeof AudioData !== 'undefined' && typeof EncodedAudioChunk !== 'undefined') {
    try {
      const mod = await loadDecoders();
      if (mod.Ac3Decoder) return { Decoder: BuiltInAudioDecoder, builtIn: true };
    } catch (e) {
      /* the module did not load */
    }
  }
  return null;
}

/**
 * AC-3 or E-AC-3 decoded by the decoders module, with as much of WebCodecs'
 * AudioDecoder as the app uses: configure, decode (EncodedAudioChunk; each
 * a whole number of sync frames, as an MP4 sample or a Matroska block is),
 * flush, close, decodeQueueSize, and `output` given AudioData (f32-planar,
 * stereo, timed as the chunk was). A chunk that won't decode at all goes to
 * `error`; frames within one that are damaged come out as silence.
 */
export class BuiltInAudioDecoder {
  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.queue = [];
    this.decodeQueueSize = 0;
    this.dec = null;
    this.ready = null;
    this.running = false;
    this.closed = false;
    this.idle = []; // flush() waiting for the queue to empty
    this.damaged = 0;
  }

  configure() {
    this.ready = loadDecoders().then((mod) => {
      if (!this.closed) this.dec = new mod.Ac3Decoder(true);
    });
  }

  decode(chunk) {
    if (this.closed) throw new Error('the decoder is closed');
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    this.queue.push({ bytes, timestamp: chunk.timestamp });
    this.decodeQueueSize = this.queue.length;
    this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.ready;
      while (this.queue.length && !this.closed) {
        const c = this.queue.shift();
        this.decodeQueueSize = this.queue.length;
        let planes;
        try {
          planes = this.dec.decode(c.bytes);
        } catch (e) {
          this.error(new Error(`the built-in AC-3 decoder: ${e && e.message ? e.message : e}`));
          continue;
        }
        this.damaged += this.dec.damaged();
        const n = this.dec.samples();
        if (!n) continue;
        this.output(new AudioData({ format: 'f32-planar', sampleRate: this.dec.sample_rate(), numberOfFrames: n, numberOfChannels: this.dec.channels(), timestamp: c.timestamp, data: planes }));
        // (a long run of chunks lets the page breathe between them)
        if (this.queue.length && this.queue.length % 64 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    } catch (e) {
      this.error(e);
    } finally {
      this.running = false;
      if (!this.queue.length) for (const r of this.idle.splice(0)) r();
    }
  }

  flush() {
    if (!this.queue.length && !this.running) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
    this.decodeQueueSize = 0;
    for (const r of this.idle.splice(0)) r();
    if (this.dec) {
      this.dec.free();
      this.dec = null;
    }
  }
}
