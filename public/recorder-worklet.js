// マイク入力（モノラル）を約 20ms 単位にまとめてメインスレッドへ転送する AudioWorklet
const CHUNK_SIZE = 1024;

class RecorderProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = new Float32Array(CHUNK_SIZE);
		this.filled = 0;
	}

	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel) return true;

		let offset = 0;
		while (offset < channel.length) {
			const n = Math.min(channel.length - offset, CHUNK_SIZE - this.filled);
			this.buffer.set(channel.subarray(offset, offset + n), this.filled);
			this.filled += n;
			offset += n;
			if (this.filled === CHUNK_SIZE) {
				this.port.postMessage(this.buffer, [this.buffer.buffer]);
				this.buffer = new Float32Array(CHUNK_SIZE);
				this.filled = 0;
			}
		}
		return true;
	}
}

registerProcessor("recorder-processor", RecorderProcessor);
