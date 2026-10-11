// 音声処理ユーティリティ（ブラウザ / Node どちらでも動く純粋関数のみ）

/** Float32Array の配列を 1 本に連結する */
export function concatChunks(chunks) {
	const length = chunks.reduce((sum, c) => sum + c.length, 0);
	const out = new Float32Array(length);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

/** 二乗平均平方根（音量の目安） */
export function rms(samples) {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / samples.length);
}

/** 区間平均による簡易ダウンサンプリング（fromRate >= toRate を想定） */
export function downsample(samples, fromRate, toRate) {
	if (toRate >= fromRate) return samples;
	const ratio = fromRate / toRate;
	const length = Math.floor(samples.length / ratio);
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
		let sum = 0;
		for (let j = start; j < end; j++) sum += samples[j];
		out[i] = sum / (end - start);
	}
	return out;
}

/** モノラル 16bit PCM の WAV バイト列を作る */
export function encodeWav(samples, sampleRate) {
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);
	const writeString = (offset, s) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};

	writeString(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	writeString(8, "WAVE");
	writeString(12, "fmt ");
	view.setUint32(16, 16, true); // fmt チャンクサイズ
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // モノラル
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // バイトレート
	view.setUint16(32, 2, true); // ブロックアライン
	view.setUint16(34, 16, true); // ビット深度
	writeString(36, "data");
	view.setUint32(40, samples.length * 2, true);

	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return new Uint8Array(buffer);
}

/** バイト列を base64 data URL に変換する */
export function toDataUrl(bytes, mime) {
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}
