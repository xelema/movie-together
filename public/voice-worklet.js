import { FrameAssembler } from './voice-core.js';

// One 960-byte frame per message, posted to the main thread which streams
// them on the room websocket. Nothing accumulates past a partial frame.
class VoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.assembler = new FrameAssembler(sampleRate);
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const frame of this.assembler.push(channel)) this.port.postMessage(frame, [frame]);
    return true;
  }
}
registerProcessor('voice-pcm', VoicePcmProcessor);
