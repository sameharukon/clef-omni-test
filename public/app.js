import { concatChunks, downsample, encodeWav, rms, toDataUrl } from "./audio.js";

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const TARGET_SAMPLE_RATE = 16000;
const PRE_ROLL_MS = 250; // 発話開始直前も含めて送る
const SILENCE_END_MS = 350; // この長さ無音が続いたら発話終了
const MAX_UTTERANCE_MS = 1500; // 1 発話の最大長（発話前・発話後の無音を含む送信音声の長さ）
const MIN_VOICED_MS = 80; // これ未満はノイズとして捨てる

const LANES = 3;
const OBSTACLE_FALL_MS = 4500; // 障害物が画面上端から下端まで落ちる時間
const SPAWN_INTERVAL_MS = 1800;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $("game");
const ctx = canvas.getContext("2d");
const micBtn = $("micBtn");
const gameBtn = $("gameBtn");
const levelEl = $("level");
const thresholdEl = $("threshold");
const minConfEl = $("minConf");
const vadStateEl = $("vadState");
const logEl = $("log");
const rawEl = $("raw");

const settings = {
	threshold: Number(thresholdEl.value),
	minConfidence: Number(minConfEl.value),
};

function bindRange(input, outputId, key) {
	const update = () => {
		settings[key] = Number(input.value);
		$(outputId).textContent = settings[key].toFixed(key === "threshold" ? 3 : 2);
		if (key === "threshold") {
			$("thresholdMark").style.left = `${Math.min(100, (settings.threshold / 0.2) * 100)}%`;
		}
	};
	input.addEventListener("input", update);
	update();
}
bindRange(thresholdEl, "thresholdValue", "threshold");
bindRange(minConfEl, "minConfValue", "minConfidence");

// ---------------------------------------------------------------------------
// マイク入力と簡易 VAD（音量しきい値で発話区間を切り出す）
// ---------------------------------------------------------------------------
const mic = {
	stream: null,
	audioCtx: null,
	node: null,
	level: 0,
	preRoll: [],
	preRollMs: 0,
	segment: null, // 発話中: { chunks, ms, voicedMs, silenceMs }
};

async function startMic() {
	mic.stream = await navigator.mediaDevices.getUserMedia({
		audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
	});
	mic.audioCtx = new AudioContext();
	await mic.audioCtx.audioWorklet.addModule("recorder-worklet.js");
	const source = mic.audioCtx.createMediaStreamSource(mic.stream);
	mic.node = new AudioWorkletNode(mic.audioCtx, "recorder-processor");
	mic.node.port.onmessage = (e) => onChunk(e.data);
	source.connect(mic.node);
	micBtn.textContent = "マイク停止";
	micBtn.classList.add("active");
}

function stopMic() {
	mic.node?.disconnect();
	mic.stream?.getTracks().forEach((t) => t.stop());
	mic.audioCtx?.close();
	Object.assign(mic, { stream: null, audioCtx: null, node: null, level: 0, preRoll: [], preRollMs: 0, segment: null });
	micBtn.textContent = "マイク開始";
	micBtn.classList.remove("active");
	setVadState("待機中", false);
}

function onChunk(chunk) {
	const chunkMs = (chunk.length / mic.audioCtx.sampleRate) * 1000;
	const level = rms(chunk);
	mic.level = level;
	const loud = level >= settings.threshold;

	if (!mic.segment) {
		if (loud) {
			mic.segment = { chunks: [...mic.preRoll, chunk], ms: mic.preRollMs + chunkMs, voicedMs: chunkMs, silenceMs: 0 };
			mic.preRoll = [];
			mic.preRollMs = 0;
			setVadState("発話を検出中…", true);
		} else {
			mic.preRoll.push(chunk);
			mic.preRollMs += chunkMs;
			while (mic.preRollMs > PRE_ROLL_MS) {
				const dropped = mic.preRoll.shift();
				mic.preRollMs -= (dropped.length / mic.audioCtx.sampleRate) * 1000;
			}
		}
		return;
	}

	const seg = mic.segment;
	seg.chunks.push(chunk);
	seg.ms += chunkMs;
	if (loud) {
		seg.voicedMs += chunkMs;
		seg.silenceMs = 0;
	} else {
		seg.silenceMs += chunkMs;
	}

	if (seg.silenceMs >= SILENCE_END_MS || seg.ms >= MAX_UTTERANCE_MS) {
		mic.segment = null;
		setVadState("待機中", false);
		if (seg.voicedMs >= MIN_VOICED_MS) {
			sendUtterance(concatChunks(seg.chunks), mic.audioCtx.sampleRate, seg.ms);
		}
	}
}

function setVadState(text, speaking) {
	vadStateEl.textContent = text;
	vadStateEl.classList.toggle("speaking", speaking);
}

// ---------------------------------------------------------------------------
// Clef-omni への問い合わせ
// ---------------------------------------------------------------------------
async function sendUtterance(samples, sampleRate, durationMs) {
	const wav = encodeWav(downsample(samples, sampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
	const requestedAt = performance.now();
	const row = addLogRow(durationMs);

	try {
		const res = await fetch("/api/direction", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ audio: toDataUrl(wav, "audio/wav") }),
		});
		const data = await res.json();
		const roundTripMs = Math.round(performance.now() - requestedAt);
		rawEl.textContent = JSON.stringify(data, null, 2);

		if (!res.ok) {
			updateLogRow(row, { label: data.error ?? `HTTP ${res.status}`, cls: "error", roundTripMs });
			return;
		}

		const confidence = typeof data.confidence === "number" ? data.confidence : null;
		const accepted =
			(data.direction === "right" || data.direction === "left") &&
			(confidence === null || confidence >= settings.minConfidence);

		updateLogRow(row, {
			label: { right: "右", left: "左", none: "なし" }[data.direction] ?? data.direction,
			cls: accepted ? data.direction : "none",
			confidence,
			roundTripMs,
			modelMs: data.latencyMs,
			rejected: !accepted && data.direction !== "none",
		});

		if (accepted) moveCar(data.direction === "right" ? 1 : -1);
	} catch (err) {
		updateLogRow(row, { label: `通信エラー: ${err.message}`, cls: "error" });
	}
}

function addLogRow(durationMs) {
	const tr = document.createElement("tr");
	tr.innerHTML = `<td>${new Date().toLocaleTimeString()}</td><td>判定中…</td><td>-</td><td>${Math.round(durationMs)}ms</td><td>-</td>`;
	logEl.prepend(tr);
	while (logEl.children.length > 30) logEl.lastElementChild.remove();
	return tr;
}

function updateLogRow(tr, { label, cls, confidence = null, roundTripMs = null, modelMs = null, rejected = false }) {
	const [, labelTd, confTd, , latencyTd] = tr.children;
	labelTd.textContent = rejected ? `${label}（信頼度不足で無視）` : label;
	labelTd.className = cls;
	confTd.textContent = confidence === null ? "-" : confidence.toFixed(2);
	latencyTd.textContent = roundTripMs === null ? "-" : `${roundTripMs}ms` + (modelMs != null ? ` (AI ${modelMs}ms)` : "");
}

// ---------------------------------------------------------------------------
// 3 レーンの車ゲーム
// ---------------------------------------------------------------------------
const laneWidth = canvas.width / LANES;
const car = { lane: 1, x: laneWidth * 1.5, w: 46, h: 80 };
const game = { running: false, over: false, obstacles: [], score: 0, lastSpawn: 0, lastTime: 0 };

function moveCar(delta) {
	car.lane = Math.max(0, Math.min(LANES - 1, car.lane + delta));
}

function startGame() {
	Object.assign(game, { running: true, over: false, obstacles: [], score: 0, lastSpawn: 0 });
	car.lane = 1;
	gameBtn.textContent = "ゲーム停止";
	gameBtn.classList.add("active");
	$("gameState").textContent = "プレイ中";
	$("score").textContent = "0";
}

function stopGame(over) {
	game.running = false;
	game.over = over;
	gameBtn.textContent = "ゲーム開始";
	gameBtn.classList.remove("active");
	$("gameState").textContent = over ? "ゲームオーバー" : "停止中";
}

function update(now) {
	const dt = game.lastTime ? now - game.lastTime : 0;
	game.lastTime = now;

	// 車はターゲットレーンへ滑らかに移動
	const targetX = laneWidth * (car.lane + 0.5);
	car.x += (targetX - car.x) * Math.min(1, dt / 80);

	if (game.running) {
		if (now - game.lastSpawn > SPAWN_INTERVAL_MS) {
			game.lastSpawn = now;
			game.obstacles.push({ lane: Math.floor(Math.random() * LANES), y: -60, h: 50 });
		}
		const speed = (canvas.height + 60) / OBSTACLE_FALL_MS;
		const carTop = canvas.height - car.h - 16;
		for (const o of game.obstacles) {
			o.y += speed * dt;
			const ox = laneWidth * (o.lane + 0.5);
			const overlapY = o.y + o.h > carTop && o.y < carTop + car.h;
			if (overlapY && Math.abs(ox - car.x) < car.w * 0.8) {
				stopGame(true);
				break;
			}
		}
		const before = game.obstacles.length;
		game.obstacles = game.obstacles.filter((o) => o.y < canvas.height);
		game.score += before - game.obstacles.length;
		$("score").textContent = String(game.score);
	}

	draw();
	updateMeter();
	requestAnimationFrame(update);
}

function draw() {
	ctx.fillStyle = "#3a3f4a";
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	// レーン区切り
	ctx.strokeStyle = "#e6e9ef";
	ctx.setLineDash([20, 16]);
	ctx.lineWidth = 3;
	for (let i = 1; i < LANES; i++) {
		ctx.beginPath();
		ctx.moveTo(laneWidth * i, 0);
		ctx.lineTo(laneWidth * i, canvas.height);
		ctx.stroke();
	}
	ctx.setLineDash([]);

	// 障害物
	ctx.fillStyle = "#c0392b";
	for (const o of game.obstacles) {
		const ox = laneWidth * (o.lane + 0.5);
		ctx.fillRect(ox - 30, o.y, 60, o.h);
	}

	// 車
	const top = canvas.height - car.h - 16;
	ctx.fillStyle = "#f6821f";
	ctx.fillRect(car.x - car.w / 2, top, car.w, car.h);
	ctx.fillStyle = "#1d2330";
	ctx.fillRect(car.x - car.w / 2 + 6, top + 12, car.w - 12, 18); // フロントガラス
	ctx.fillRect(car.x - car.w / 2 - 4, top + 8, 6, 18); // タイヤ
	ctx.fillRect(car.x + car.w / 2 - 2, top + 8, 6, 18);
	ctx.fillRect(car.x - car.w / 2 - 4, top + car.h - 26, 6, 18);
	ctx.fillRect(car.x + car.w / 2 - 2, top + car.h - 26, 6, 18);

	if (!game.running) {
		ctx.fillStyle = "rgba(0,0,0,0.45)";
		ctx.fillRect(0, canvas.height / 2 - 30, canvas.width, 60);
		ctx.fillStyle = "#fff";
		ctx.font = "bold 20px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.fillText(game.over ? `GAME OVER  スコア ${game.score}` : "「ゲーム開始」を押してください", canvas.width / 2, canvas.height / 2 + 7);
	}
}

function updateMeter() {
	levelEl.style.width = `${Math.min(100, (mic.level / 0.2) * 100)}%`;
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------
micBtn.addEventListener("click", async () => {
	if (mic.stream) {
		stopMic();
		return;
	}
	try {
		await startMic();
	} catch (err) {
		alert(`マイクを開始できませんでした: ${err.message}`);
		stopMic();
	}
});

gameBtn.addEventListener("click", () => (game.running ? stopGame(false) : startGame()));

window.addEventListener("keydown", (e) => {
	if (e.key === "ArrowLeft") moveCar(-1);
	if (e.key === "ArrowRight") moveCar(1);
});

requestAnimationFrame(update);
