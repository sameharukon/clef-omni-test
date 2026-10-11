import { concatChunks, downsample, encodeWav, normalizePeak, rms, toDataUrl } from "./audio.js";

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const TARGET_SAMPLE_RATE = 16000;
const PRE_ROLL_MS = 250; // 発話開始直前も含めて送る
const SILENCE_END_MS = 350; // この長さ無音が続いたら発話終了
const MAX_UTTERANCE_MS = 1500; // 1 発話の最大長（発話前・発話後の無音を含む送信音声の長さ）
const MIN_VOICED_MS = 80; // これ未満はノイズとして捨てる
// 信頼度不足のとき、先頭に無音を足して音声トークン（約 77ms）の区切り位置をずらし再送する。
// 1/2・1/4・3/4 トークン分のずれを、設定した回数ぶん並列に送る。
const RETRY_OFFSETS_MS = [38, 19, 58];

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
const summaryEl = $("summary");
const normalizeEl = $("normalize");
const retriesEl = $("retries");
const modeEl = $("mode");
const leftThresholdEl = $("leftThreshold");

const settings = {
	threshold: Number(thresholdEl.value),
	minConfidence: Number(minConfEl.value),
	leftThreshold: Number(leftThresholdEl.value),
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
bindRange(leftThresholdEl, "leftThresholdValue", "leftThreshold");

/** 左かどうかを判定し、左でなければ右とする方式か（noul 型 / choice 型） */
function isLeftMode(mode) {
	return mode === "left" || mode === "left-choice";
}

// 判定方式ごとに関係する設定だけを表示する
function updateModeUi() {
	const left = isLeftMode(modeEl.value);
	$("leftOnly").hidden = !left;
	$("choiceOnly").hidden = left;
}
modeEl.addEventListener("change", updateModeUi);
updateModeUi();

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
	let pcm = downsample(samples, sampleRate, TARGET_SAMPLE_RATE);
	let gain = 1;
	if (normalizeEl.checked) ({ samples: pcm, gain } = normalizePeak(pcm));

	const mode = modeEl.value;
	const entry = addEntry({ durationMs, gain, normalized: normalizeEl.checked, mode });
	const requestedAt = performance.now();

	try {
		const first = await requestDirection(pcm, 0, mode);
		entry.attempts.push(first);
		if (!first.ok) {
			entry.status = "error";
			entry.error = first.error;
			return;
		}

		const retries = Number(retriesEl.value);
		// 左判定モードは常に右か左に決まるので再送しない
		if (mode === "choice" && retries > 0 && !isConfident(first)) {
			entry.retrying = true;
			render();
			const results = await Promise.all(RETRY_OFFSETS_MS.slice(0, retries).map((offset) => requestDirection(pcm, offset, mode)));
			entry.attempts.push(...results);
			entry.retrying = false;
		}

		const best = pickBest(entry.attempts);
		entry.status = "done";
		entry.direction = best.direction;
		entry.confidence = best.confidence;
		entry.pLeft = best.pLeft;
		entry.bestOffsetMs = best.offsetMs;
		entry.response = best.response;
		entry.modelMs = first.modelMs;
		entry.accepted = isAccepted(best);

		if (entry.accepted) moveCar(best.direction === "right" ? 1 : -1);
	} finally {
		entry.roundTripMs = Math.round(performance.now() - requestedAt);
		if (selectedId === entry.id) showRaw(entry);
		render();
	}
}

/** 先頭に offsetMs の無音を足した音声で 1 回問い合わせる（失敗しても例外は投げない） */
async function requestDirection(pcm, offsetMs, mode) {
	const pad = Math.round((offsetMs / 1000) * TARGET_SAMPLE_RATE);
	const shifted = pad > 0 ? concatChunks([new Float32Array(pad), pcm]) : pcm;
	const wav = encodeWav(shifted, TARGET_SAMPLE_RATE);
	const attempt = { offsetMs, mode, ok: false, direction: null, confidence: null, pLeft: null, modelMs: null, error: null, response: null };

	try {
		const res = await fetch("/api/direction", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ audio: toDataUrl(wav, "audio/wav"), mode }),
		});
		const data = await res.json();
		attempt.response = data;
		if (!res.ok) {
			attempt.error = data.error ?? `HTTP ${res.status}`;
			return attempt;
		}
		attempt.ok = true;
		if (isLeftMode(mode)) {
			// 左の確率がしきい値以上なら左、そうでなければ右
			attempt.pLeft = data.pLeft;
			attempt.direction = data.pLeft >= settings.leftThreshold ? "left" : "right";
			attempt.confidence = attempt.direction === "left" ? data.pLeft : 1 - data.pLeft;
		} else {
			attempt.direction = data.direction;
			attempt.confidence = typeof data.confidence === "number" ? data.confidence : null;
		}
		attempt.modelMs = data.latencyMs ?? null;
	} catch (err) {
		attempt.error = `通信エラー: ${err.message}`;
	}
	return attempt;
}

/** 3 択モードでは最低信頼度以上か。左判定モードは常に確定扱い */
function isConfident(attempt) {
	if (isLeftMode(attempt.mode)) return true;
	return attempt.confidence === null || attempt.confidence >= settings.minConfidence;
}

function isAccepted(attempt) {
	return (attempt.direction === "right" || attempt.direction === "left") && isConfident(attempt);
}

/** 採用できる結果を優先し、その中で最も信頼度が高いもの */
function pickBest(attempts) {
	const ok = attempts.filter((a) => a.ok);
	const score = (a) => (isAccepted(a) ? 1 : 0) * 10 + (a.confidence ?? 0);
	return ok.reduce((best, a) => (score(a) > score(best) ? a : best));
}

// ---------------------------------------------------------------------------
// 判定ログと正解率の集計
// ---------------------------------------------------------------------------
const MAX_ENTRIES = 200;
const LABELS = { right: "右", left: "左", none: "なし" };
const TRUTH_LABELS = { right: "右", left: "左", none: "他" };
const MODE_LABELS = { left: "左判定(noul)", "left-choice": "左判定(choice)", choice: "3択" };
let entries = [];
let nextId = 1;
let selectedId = null;

function addEntry(fields) {
	const entry = {
		id: nextId++,
		time: new Date(),
		status: "pending",
		direction: null,
		confidence: null,
		accepted: false,
		roundTripMs: null,
		modelMs: null,
		error: null,
		response: null,
		truth: null,
		attempts: [],
		retrying: false,
		mode: "choice",
		pLeft: null,
		bestOffsetMs: 0,
		...fields,
	};
	entries.unshift(entry);
	if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
	render();
	return entry;
}

/** ゲームに反映された結果（不採用は none 扱い） */
function outcomeOf(e) {
	if (e.status !== "done") return null;
	return e.accepted ? e.direction : "none";
}

/** 再送しなかった場合の結果（再送したのは初回が信頼度不足だったときなので、初回だけなら不採用） */
function firstOutcomeOf(e) {
	if (e.status !== "done") return null;
	return e.attempts.length > 1 ? "none" : outcomeOf(e);
}

function retriedCount(e) {
	return Math.max(0, e.attempts.length - 1);
}

function render() {
	logEl.replaceChildren(...entries.map(renderRow));
	renderSummary();
}

function renderRow(e) {
	const tr = document.createElement("tr");
	tr.dataset.id = String(e.id);
	if (e.id === selectedId) tr.classList.add("selected");

	const cell = (text, cls) => {
		const td = document.createElement("td");
		td.textContent = text;
		if (cls) td.className = cls;
		tr.append(td);
		return td;
	};

	cell(e.time.toLocaleTimeString());

	let label = e.retrying ? "再送中…" : "判定中…";
	let cls = "";
	if (e.status === "error") {
		label = e.error;
		cls = "error";
	} else if (e.status === "done") {
		const name = LABELS[e.direction] ?? e.direction;
		const rejected = !e.accepted && e.direction !== "none";
		label = rejected ? `${name}（信頼度不足で無視）` : name;
		if (e.accepted && e.bestOffsetMs > 0) label += "（再送で判定）";
		cls = e.accepted ? e.direction : "none";
	}
	const labelTd = cell(label, cls);
	const outcome = outcomeOf(e);
	if (e.truth && outcome) labelTd.classList.add(outcome === e.truth ? "mark-ok" : "mark-ng");

	cell(e.pLeft !== null ? `P(左) ${e.pLeft.toFixed(2)}` : e.confidence === null ? "-" : e.confidence.toFixed(2));
	cell(`${Math.round(e.durationMs)}ms` + (e.gain > 1 ? ` ×${e.gain.toFixed(1)}` : ""));
	const retried = retriedCount(e);
	cell(
		e.roundTripMs === null
			? "-"
			: `${e.roundTripMs}ms` + (e.modelMs != null ? ` (AI ${e.modelMs}ms)` : "") + (retried ? ` 再送${retried}` : ""),
	);

	const truthTd = cell("");
	const group = document.createElement("div");
	group.className = "truth";
	for (const [value, text] of Object.entries(TRUTH_LABELS)) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = text;
		btn.dataset.truth = value;
		if (e.truth === value) btn.classList.add("on");
		group.append(btn);
	}
	truthTd.append(group);
	return tr;
}

/** 判定方式ごとの AI 処理時間（初回の問い合わせ、中央値と 1 秒超の件数） */
function latencyByMode() {
	return Object.entries(MODE_LABELS)
		.map(([value, text]) => {
			const ms = entries
				.filter((e) => e.status === "done" && e.mode === value && e.modelMs != null)
				.map((e) => e.modelMs)
				.sort((a, b) => a - b);
			if (ms.length === 0) return null;
			const mid = Math.floor(ms.length / 2);
			const median = ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2);
			const slow = ms.filter((v) => v > 1000).length;
			return `${text} 中央値 ${median}ms・1秒超 ${slow}/${ms.length} 件`;
		})
		.filter(Boolean)
		.join(" / ");
}

function renderSummary() {
	const labeled = entries.filter((e) => e.truth && e.status === "done");
	const latency = latencyByMode();
	if (labeled.length === 0) {
		summaryEl.textContent = latency ? `AI 処理時間: ${latency}` : "正解ラベル付きの判定はまだありません";
		return;
	}

	const pct = (n, d) => (d === 0 ? "-" : `${((n / d) * 100).toFixed(0)}%`);
	const correct = labeled.filter((e) => outcomeOf(e) === e.truth).length;
	const misfire = labeled.filter((e) => outcomeOf(e) !== "none" && outcomeOf(e) !== e.truth).length;
	const missed = labeled.filter((e) => e.truth !== "none" && outcomeOf(e) === "none").length;
	// しきい値を無視し、モデルの判定そのものが合っていたか（しきい値調整の参考）
	const rawCorrect = labeled.filter((e) => e.direction === e.truth).length;

	const perTruth = Object.entries(TRUTH_LABELS)
		.map(([value, text]) => {
			const group = labeled.filter((e) => e.truth === value);
			const ok = group.filter((e) => outcomeOf(e) === value).length;
			return group.length ? `${text} ${ok}/${group.length}` : null;
		})
		.filter(Boolean)
		.join("　");

	const avgConf = (list) => {
		const values = list.map((e) => e.confidence).filter((c) => c !== null);
		return values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : "-";
	};
	const retriedEntries = labeled.filter((e) => retriedCount(e) > 0);
	const rescued = retriedEntries.filter((e) => e.accepted);
	const rescuedCorrect = rescued.filter((e) => e.direction === e.truth).length;
	const firstCorrect = labeled.filter((e) => firstOutcomeOf(e) === e.truth).length;

	const rawOk = labeled.filter((e) => e.direction === e.truth);
	const rawNg = labeled.filter((e) => e.direction !== e.truth);

	const modeCounts = Object.entries(MODE_LABELS)
		.map(([value, text]) => [text, labeled.filter((e) => e.mode === value).length])
		.filter(([, n]) => n > 0)
		.map(([text, n]) => `${text} ${n} 件`)
		.join(" / ");

	summaryEl.innerHTML = "";
	const lines = [
		[`判定方式`, modeCounts, ""],
		[`正解率`, `${pct(correct, labeled.length)}`, `（${correct}/${labeled.length} 件、判定時の設定を適用）`],
		[`誤判定（逆方向・他を右左と判定）`, `${misfire} 件`, ""],
		[`取りこぼし（右左を不採用・なし）`, `${missed} 件`, ""],
		[`再送`, `${retriedEntries.length} 件 → 採用 ${rescued.length} 件（うち正解 ${rescuedCorrect} 件）`, ""],
		[`再送なしの場合の正解率`, pct(firstCorrect, labeled.length), `（初回の問い合わせだけで判定した場合）`],
		[`内訳`, perTruth, ""],
		[`モデル判定そのものの正解率`, pct(rawCorrect, labeled.length), `（しきい値無視）`],
		[`平均信頼度`, `正解時 ${avgConf(rawOk)} / 不正解時 ${avgConf(rawNg)}`, `（しきい値無視）`],
		[`AI 処理時間`, latency, `（ラベルなしも含む）`],
	];
	for (const [head, value, tail] of lines) {
		const div = document.createElement("div");
		const strong = document.createElement("strong");
		strong.textContent = value;
		div.append(`${head}: `, strong, tail);
		summaryEl.append(div);
	}
}

function showRaw(e) {
	rawEl.textContent = JSON.stringify(
		{
			id: e.id,
			time: e.time.toLocaleTimeString(),
			mode: e.mode,
			gain: e.gain,
			truth: e.truth,
			error: e.error,
			bestOffsetMs: e.bestOffsetMs,
			response: e.response,
			attempts: e.attempts.map((a) => ({ offsetMs: a.offsetMs, error: a.error, answer: a.response?.raw ?? a.response })),
		},
		null,
		2,
	);
}

logEl.addEventListener("click", (ev) => {
	const tr = ev.target.closest("tr");
	if (!tr) return;
	const entry = entries.find((e) => e.id === Number(tr.dataset.id));
	if (!entry) return;

	const btn = ev.target.closest("button[data-truth]");
	if (btn) {
		entry.truth = entry.truth === btn.dataset.truth ? null : btn.dataset.truth;
	} else {
		selectedId = entry.id;
		$("rawDetails").open = true;
	}
	showRaw(entry);
	render();
});

$("clearBtn").addEventListener("click", () => {
	if (entries.length && !confirm("判定ログと集計を消去しますか？")) return;
	entries = [];
	selectedId = null;
	rawEl.textContent = "-";
	render();
});

const EXPORT_HEADER = [
	"time", "direction", "confidence", "accepted", "outcome", "truth", "correct",
	"duration_ms", "gain", "round_trip_ms", "model_ms", "error", "answer_json",
	"first_direction", "first_confidence", "first_outcome", "retries", "best_offset_ms", "attempts_json",
	"mode", "p_left",
];

/** 古い順のエクスポート用行データ */
function exportRows() {
	return [...entries].reverse().map((e) => {
		const outcome = outcomeOf(e);
		return [
			e.time.toISOString(), e.direction, e.confidence, e.accepted, outcome, e.truth,
			e.truth && outcome ? outcome === e.truth : "",
			Math.round(e.durationMs), e.gain.toFixed(2), e.roundTripMs, e.modelMs, e.error,
			e.response?.raw ? JSON.stringify(e.response.raw) : "",
			e.attempts[0]?.direction, e.attempts[0]?.confidence, firstOutcomeOf(e), retriedCount(e), e.bestOffsetMs,
			e.attempts.length > 1
				? JSON.stringify(e.attempts.map((a) => ({ offset: a.offsetMs, choice: a.direction, confidence: a.confidence, probabilities: a.response?.probabilities, error: a.error ?? undefined })))
				: "",
			e.mode, e.pLeft,
		];
	});
}

const str = (v) => (v === null || v === undefined ? "" : String(v));

$("csvBtn").addEventListener("click", () => {
	const escape = (v) => {
		const s = str(v);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const csv = [EXPORT_HEADER, ...exportRows()].map((r) => r.map(escape).join(",")).join("\n");
	const blob = new Blob(["﻿" + csv], { type: "text/csv" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `clef-omni-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
	a.click();
	URL.revokeObjectURL(a.href);
});

$("copyBtn").addEventListener("click", async (ev) => {
	const summaryText = [...summaryEl.children].map((div) => div.textContent).join("\n") || summaryEl.textContent;
	const tsv = [EXPORT_HEADER, ...exportRows()].map((r) => r.map((v) => str(v).replace(/[\t\n]/g, " ")).join("\t")).join("\n");
	const text = `${summaryText}\n\n${tsv}`;
	const btn = ev.currentTarget;
	try {
		await navigator.clipboard.writeText(text);
		btn.textContent = "コピーしました";
	} catch {
		btn.textContent = "コピーに失敗しました";
	}
	setTimeout(() => (btn.textContent = "ログをコピー"), 1500);
});

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
		ctx.font = "bold 16px system-ui, sans-serif";
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
