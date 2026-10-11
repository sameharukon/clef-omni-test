# Clef-omni Voice Lane

[Clef-omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/)（`@cf/cloudflare/clef-omni`）の音声入力を検証するための簡易アプリです。
マイクで日本語の「右」「左」を話すと Clef-omni が方向を判定し、3 レーンを走る車が左右に移動します。

## 構成

```
public/
  index.html            画面
  app.js                マイク入力・発話区間検出(VAD)・API 呼び出し・ゲーム
  audio.js              ダウンサンプリング / WAV エンコード / base64 化
  recorder-worklet.js   マイク音声を約 20ms 単位で取り出す AudioWorklet
  style.css
src/index.js            Worker（静的ファイル配信 + POST /api/direction）
wrangler.jsonc          Workers AI バインディング(AI)と静的アセットの設定
```

## 処理の流れ

1. ブラウザでマイク音声を取得し、音量しきい値で 1 発話を切り出す（発話前 250ms を含め、無音 350ms で終了、最大 1.5 秒）
2. 16kHz / 16bit / モノラルの WAV に変換し、base64 data URL で `POST /api/direction` に送信
3. Worker が Clef-omni に `choice` 型の質問（`right` / `left` / `none`）として問い合わせ
4. 返ってきた `choice` と `confidence` を画面に表示し、信頼度がしきい値以上なら車を移動

Worker から Clef-omni へのリクエストは次の形です。

```js
await env.AI.run("@cf/cloudflare/clef-omni", {
  model: "clef-omni",
  state: "A player of a 3-lane car game spoke one Japanese voice command into the microphone.",
  audio: ["data:audio/wav;base64,..."],
  questions: {
    direction: {
      type: "choice",
      instructions: "... 「右」(migi) means right and 「左」(hidari) means left.",
      criteria: { right: "...", left: "...", none: "..." },
    },
  },
});
```

## 実行方法

Cloudflare アカウントで Workers AI が利用可能である必要があります。

```sh
npm install
npx wrangler login
npm run dev      # http://localhost:8787 （AI バインディングは常にリモートの Workers AI を使用し、課金対象）
npm run deploy   # workers.dev にデプロイ
```

マイクは安全なコンテキストでのみ使用できるため、`localhost` か HTTPS（workers.dev 等）でアクセスしてください。

## 使い方

1. 「マイク開始」を押してマイクを許可
2. 何も話していない状態でメーターが赤線（発話検出しきい値）より下になるよう、しきい値を調整
3. 「ゲーム開始」を押し、「右」「左」と話して落ちてくる障害物を避ける
   （←/→ キーでも操作できるため、音声判定と比較しながら検証できます）

判定ログには、判定結果・信頼度・送信した発話の長さ・往復遅延（括弧内は Worker で計測した Clef-omni の処理時間）が表示されます。
「直近のレスポンス (raw)」で Clef-omni の回答オブジェクトをそのまま確認できます。

## 注意事項

- `choice` 回答のうち本アプリが使うのは `choice` と `confidence` です。選択肢ごとの確率は `probabilities` として転送していますが、
  フィールド名はドキュメントで明示されていないため、実際の値は raw 表示で確認してください。
- 1 発話あたりの音声は Worker 側で 1 MiB までに制限しています（Clef-omni 自体の上限は 1 クリップ 8 MiB / 300 秒）。
- 料金は入力トークン課金（$0.15 / 100 万トークン）です。音声はトークンに換算されて課金されます。
