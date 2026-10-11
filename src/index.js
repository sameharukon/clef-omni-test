// Clef-omni 音声方向判定 Worker
// POST /api/direction  { audio: "data:audio/wav;base64,..." }
//   -> { direction: "right" | "left" | "none", confidence, probabilities, latencyMs, raw }

const MODEL = "@cf/cloudflare/clef-omni";
const MAX_AUDIO_BYTES = 1024 * 1024; // 1 発話あたり 1 MiB まで（16kHz/16bit/mono で約 30 秒）
const AUDIO_DATA_URL = /^data:audio\/(wav|x-wav|wave|mpeg);base64,[A-Za-z0-9+/]+=*$/;

const DIRECTION_QUESTION = {
	type: "choice",
	instructions:
		"The audio is one short Japanese voice command spoken to steer a car in a 3-lane game. " +
		"Which direction did the speaker say? 「右」(migi) means right and 「左」(hidari) means left.",
	criteria: {
		right: "The speaker said 「右」/「みぎ」 (migi, right), possibly with words like 右へ or 右に",
		left: "The speaker said 「左」/「ひだり」 (hidari, left), possibly with words like 左へ or 左に",
		none: "Neither direction was said: silence, background noise, or other words",
	},
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/direction") {
			if (request.method !== "POST") {
				return json({ error: "Method Not Allowed" }, 405);
			}
			return handleDirection(request, env);
		}

		return env.ASSETS.fetch(request);
	},
};

async function handleDirection(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "JSON ボディが不正です" }, 400);
	}

	const audio = body?.audio;
	if (typeof audio !== "string" || !AUDIO_DATA_URL.test(audio)) {
		return json({ error: "audio には WAV/MP3 の base64 data URL を指定してください" }, 400);
	}
	const base64Length = audio.length - audio.indexOf(",") - 1;
	if (base64Length * 0.75 > MAX_AUDIO_BYTES) {
		return json({ error: "音声が大きすぎます" }, 413);
	}

	const started = Date.now();
	let result;
	try {
		result = await env.AI.run(MODEL, {
			model: "clef-omni",
			state: "A player of a 3-lane car game spoke one Japanese voice command into the microphone.",
			audio: [audio],
			questions: { direction: DIRECTION_QUESTION },
		});
	} catch (err) {
		return json({ error: `Clef-omni の呼び出しに失敗しました: ${err?.message ?? err}` }, 502);
	}
	const latencyMs = Date.now() - started;

	const answer = result?.answers?.direction ?? {};
	return json({
		direction: answer.choice ?? "none",
		confidence: answer.confidence ?? null,
		probabilities: answer.probabilities ?? null,
		latencyMs,
		usage: result?.usage ?? null,
		raw: answer,
	});
}

function json(data, status = 200) {
	return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
