// Claude API 呼び出し：聞こえた文章から「この人が知らなさそうな言葉」を拾って解説する
// 公式SDK（@anthropic-ai/sdk 0.135.0, MIT）をアプリに同梱。外部サイトからコードを読み込まない
import Anthropic from "./vendor/anthropic-sdk.js";

const MODEL = "claude-opus-5-5";

function client() {
  const apiKey = localStorage.getItem("apiKey");
  if (!apiKey) throw new Error("設定タブでClaude APIキーを保存してください。");
  // 個人用アプリなので、利用者自身のキーでブラウザから直接呼び出す
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

async function askJson({ system, text, schema, maxTokens = 3000 }) {
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // 会話についていくため速さ優先
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: text }],
  });
  if (response.stop_reason === "refusal") throw new Error("AIがこの内容には回答できませんでした。");
  if (response.stop_reason === "max_tokens") throw new Error("AIの回答が途中で切れました。");
  const out = response.content.find((b) => b.type === "text")?.text;
  if (!out) throw new Error("AIから回答が返りませんでした。");
  return JSON.parse(out);
}

function profileText(profile) {
  return [
    `利用者について: ${profile.about || "（未記入。一般的な大人として扱う）"}`,
    `説明のレベル: ${profile.level || "ふつう"}`,
  ].join("\n");
}

const TERM = {
  type: "object",
  additionalProperties: false,
  required: ["word", "reading", "explanation", "example"],
  properties: {
    word: { type: "string" },
    reading: { type: "string" },
    explanation: { type: "string" },
    example: { type: "string" },
  },
};

const TERMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["terms"],
  properties: { terms: { type: "array", items: TERM } },
};

/**
 * 新しく聞こえた文章から、この利用者が知らなさそうな言葉を拾って解説する。
 * known: 利用者が「知ってた」と言った言葉 / skip: 今回すでに解説した言葉
 */
export async function findTerms({ newText, context, profile, known, skip }) {
  const { terms } = await askJson({
    system: [
      "あなたは、利用者のそばで会話・講演・動画の音声を一緒に聞いている『ことばの家庭教師』です。",
      "音声認識で文字にした文章が少しずつ届きます。その中から、この利用者が知らなさそう・意味があいまいそうな言葉（専門用語、カタカナ語、略語、法律用語、固有名詞、慣用句など）を選び、この人に合わせて解説してください。",
      profileText(profile),
      "ルール:",
      "- 『新しく聞こえた部分』に出てきた言葉だけを対象にする（前後の文脈は意味の判断に使う）。",
      "- 利用者がすでに知っている言葉と、今回すでに解説した言葉は出さない。",
      "- 日常的な言葉は出さない。該当がなければ terms は空でよい。1回に多くても3語。",
      "- 音声認識の誤変換と思われる場合は、文脈から正しい言葉を推測して word に入れる。",
      "- explanation は、ちらっと見て分かる1〜2文。文脈の中での意味を優先する。",
      "- example は、その言葉を使った短い例文か、身近なたとえ。",
      "- reading はひらがなの読み（英字略語なら読み方）。",
    ].join("\n"),
    text: [
      `利用者が知っている言葉: ${known.join("、") || "（なし）"}`,
      `今回すでに解説した言葉: ${skip.join("、") || "（なし）"}`,
      `直前の文脈: ${context || "（なし）"}`,
      `新しく聞こえた部分: ${newText}`,
    ].join("\n"),
    schema: TERMS_SCHEMA,
  });
  return terms;
}

/** 言葉をひとつ解説する（直接入力・「くわしく」用） */
export async function explainTerm({ word, context, profile, detailed }) {
  return askJson({
    system: [
      "あなたは利用者に合わせて言葉を解説する『ことばの家庭教師』です。",
      profileText(profile),
      detailed
        ? "explanation は、背景・なぜそう呼ぶのか・関連する言葉まで含めて、4〜6文で分かりやすく。"
        : "explanation は、ちらっと見て分かる1〜2文で。",
      "文脈があれば、その文脈での意味を優先してください。reading はひらがなの読み。example は短い例文か身近なたとえ。",
    ].join("\n"),
    text: `言葉: ${word}\n文脈: ${context || "（なし）"}`,
    schema: TERM,
    maxTokens: detailed ? 4000 : 2000,
  });
}
