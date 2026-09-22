// PCM pipeline for a prise de parole: native-rate Float32 blocks in, 30 ms
// signed 16-bit mono 16 kHz frames out (960 bytes each). The assembler stays
// pure so node tests cover conversion and framing without a microphone.
export const VOICE_RATE = 16000, VOICE_FRAME_SAMPLES = 480, VOICE_FRAME_BYTES = 960;

// Linear interpolation is enough for speech that a recognizer will read.
export class FrameAssembler {
  constructor(inputRate) {
    this.ratio = inputRate / VOICE_RATE;
    this.pending = new Float32Array(0);
    this.cursor = 0;
  }
  push(block) {
    const merged = new Float32Array(this.pending.length + block.length);
    merged.set(this.pending);
    merged.set(block, this.pending.length);
    this.pending = merged;
    const frames = [], span = VOICE_FRAME_SAMPLES * this.ratio;
    while (this.cursor + span <= this.pending.length - 1) {
      const pcm = new Int16Array(VOICE_FRAME_SAMPLES);
      for (let j = 0; j < VOICE_FRAME_SAMPLES; j++) {
        const x = this.cursor + j * this.ratio, low = Math.floor(x), frac = x - low;
        const s = this.pending[low] * (1 - frac) + this.pending[low + 1] * frac;
        pcm[j] = s <= -1 ? -32768 : s >= 1 ? 32767 : Math.round(s * 32767);
      }
      frames.push(pcm.buffer);
      this.cursor += span;
    }
    const consumed = Math.floor(this.cursor);
    if (consumed > 1) {
      this.pending = this.pending.slice(consumed - 1);
      this.cursor -= consumed - 1;
    }
    return frames;
  }
}
