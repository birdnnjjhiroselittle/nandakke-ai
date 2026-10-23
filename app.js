import { getTerm, putTerm, deleteTerm, clearTerms, allTerms } from "./db.js";
import { findTerms, explainTerm } from "./ai.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (t) => new Date(t).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const profile = () => ({ about: localStorage.getItem("about") || "", level: localStorage.getItem("level") || "ふつう" });

// ---------- タブ切り替え ----------
document.querySelectorAll("nav button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button, .tab").forEach((el) => el.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "dict") {
      renderDict();
      renderSceneOptions();
    }
  }),
);

// ---------- 解説カード ----------
function termCard(t) {
  const again = t.count > 1 ? `<span class="badge">${t.count}回目</span>` : "";
  return `
    <article class="card term" data-word="${esc(t.word)}">
      <h3>${esc(t.word)} <small>${esc(t.reading)}</small> ${again}</h3>
      <p class="explanation">${esc(t.detail || t.explanation)}</p>
      <p class="example">例）${esc(t.example)}</p>
      <div class="actions">
        <button class="ghost" data-action="known">👍 知ってた</button>
        ${t.detail ? "" : `<button class="ghost" data-action="detail">🔎 くわしく</button>`}
      </div>
    </article>`;
}

function showTerm(t) {
  $("#listen-empty").hidden = true;
  $(`#terms .term[data-word="${CSS.escape(t.word)}"]`)?.remove();
  $("#terms").insertAdjacentHTML("afterbegin", termCard(t));
  navigator.vibrate?.(40);
}

/** AIが拾った言葉をじしょに保存して表示する */
async function rememberAndShow(found, context, scene) {
  for (const f of found) {
    const old = await getTerm(f.word);
    if (old?.known) continue;
    const now = Date.now();
    // どの場面で・どんな文脈で出会ったかを記録しておく（復習ショートで使う）
    const sightings = [...(old?.sightings ?? []), { scene, at: now, context }].slice(-20);
    const term = {
      ...f,
      context,
      sightings,
      detail: old?.detail,
      count: (old?.count ?? 0) + 1,
      known: false,
      firstSeenAt: old?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    await putTerm(term);
    session.words.add(f.word);
    showTerm(term);
  }
}

// 「知ってた」「くわしく」ボタン（聞く画面とじしょ画面の両方）
document.addEventListener("click", async (e) => {
  const action = e.target.dataset?.action;
  const card = e.target.closest?.(".term");
  if (!action || !card) return;
  const term = await getTerm(card.dataset.word);
  if (!term) return;
  if (action === "known" || action === "unknown") {
    await putTerm({ ...term, known: action === "known" });
    card.remove();
  } else if (action === "detail") {
    e.target.disabled = true;
    e.target.textContent = "調べています…";
    try {
      const d = await explainTerm({ word: term.word, context: term.context, profile: profile(), detailed: true });
      const updated = { ...term, detail: d.explanation };
      await putTerm(updated);
      card.outerHTML = termCard(updated);
    } catch (err) {
      e.target.textContent = err.message;
    }
  } else if (action === "delete") {
    await deleteTerm(term.word);
    card.remove();
  }
});

// ---------- 聞く（音声認識 → 数秒ごとにAIへ） ----------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const session = { listening: false, text: "", sentUpTo: 0, lastSentAt: 0, inflight: false, words: new Set() };
let recognition, timer, wakeLock;

function setStatus(msg, error = false) {
  $("#listen-status").textContent = msg;
  $("#listen-status").className = error ? "status error" : "status";
}

function renderTranscript(interim = "") {
  const box = $("#transcript");
  box.hidden = false;
  box.innerHTML = `${esc(session.text.slice(-120))}<span class="interim">${esc(interim)}</span>`;
}

function setupRecognition() {
  const r = new SpeechRecognition();
  r.lang = "ja-JP";
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) session.text += res[0].transcript + "。";
      else interim += res[0].transcript;
    }
    renderTranscript(interim);
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopListening();
      setStatus("マイクが使えません。ブラウザの設定でマイクを許可してください。", true);
    }
  };
  // ブラウザは無音が続くと勝手に止まるので、聞いている間は自動で再開する
  r.onend = () => {
    if (session.listening) setTimeout(() => session.listening && r.start(), 250);
  };
  return r;
}

async function sendPending(force = false) {
  const newText = session.text.slice(session.sentUpTo);
  const waited = Date.now() - session.lastSentAt;
  if (session.inflight || !newText.trim()) return;
  if (!force && newText.length < 30 && waited < 10000) return;

  session.inflight = true;
  const upTo = session.text.length;
  const context = session.text.slice(Math.max(0, session.sentUpTo - 300), session.sentUpTo);
  const scene = session.scene; // 送信中に場面が変わっても、聞いたときの場面で記録する
  try {
    const known = (await allTerms()).filter((t) => t.known).slice(0, 300).map((t) => t.word);
    const found = await findTerms({ newText, context, profile: profile(), known, skip: [...session.words] });
    session.sentUpTo = upTo;
    session.lastSentAt = Date.now();
    await rememberAndShow(found, newText.slice(0, 200), scene);
    if (session.listening) setStatus("🎙 聞いています…");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    session.inflight = false;
  }
}

async function startListening() {
  if (!localStorage.getItem("apiKey")) {
    setStatus("先に設定タブでClaude APIキーを保存してください。", true);
    return;
  }
  recognition ??= setupRecognition();
  const scene = $("#scene").value.trim() || `${new Date().toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}の会話`;
  Object.assign(session, { listening: true, scene, text: "", sentUpTo: 0, lastSentAt: Date.now(), words: new Set() });
  recognition.start();
  timer = setInterval(sendPending, 3000);
  // 画面を消さない（ちらっと見られるように）
  wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
  $("#listen-toggle").textContent = "⏹ 聞くのをやめる";
  $("#listen-toggle").classList.add("on");
  setStatus("🎙 聞いています…");
}

function stopListening() {
  session.listening = false;
  recognition?.stop();
  clearInterval(timer);
  wakeLock?.release();
  wakeLock = null;
  $("#listen-toggle").textContent = "🎙 聞きはじめる";
  $("#listen-toggle").classList.remove("on");
  setStatus("");
  sendPending(true); // 最後に残った分も解説する
}

document.addEventListener("visibilitychange", async () => {
  if (session.listening && document.visibilityState === "visible") {
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
  }
});

if (!SpeechRecognition) {
  $("#listen-toggle").disabled = true;
  setStatus("このブラウザは音声認識に対応していません。AndroidやPCのChrome、iPhoneのSafariで開いてください。下の欄から言葉を直接調べることはできます。", true);
}

$("#listen-toggle").addEventListener("click", () => (session.listening ? stopListening() : startListening()));

// ---------- 直接調べる ----------
$("#lookup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const word = $("#lookup").value.trim();
  if (!word) return;
  setStatus("調べています…");
  try {
    const context = session.text.slice(-300);
    const t = await explainTerm({ word, context, profile: profile(), detailed: false });
    $("#lookup").value = "";
    await rememberAndShow([t], context, session.listening ? session.scene : "直接調べた");
    setStatus(session.listening ? "🎙 聞いています…" : "");
  } catch (err) {
    setStatus(err.message, true);
  }
});

// ---------- じしょ ----------
let dictFilter = "learning";
document.querySelectorAll("[data-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    dictFilter = b.dataset.filter;
    renderDict();
  }),
);

async function renderDict() {
  const terms = (await allTerms()).filter((t) => (dictFilter === "known" ? t.known : !t.known));
  $("#dict").innerHTML = terms.length
    ? terms
        .map(
          (t) => `
          <article class="card term" data-word="${esc(t.word)}">
            <h3>${esc(t.word)} <small>${esc(t.reading)}</small> <span class="badge">${t.count}回</span></h3>
            <p class="explanation">${esc(t.detail || t.explanation)}</p>
            <p class="example">例）${esc(t.example)}</p>
            <p class="meta">最後に聞いた：${fmt(t.lastSeenAt)}</p>
            <div class="actions">
              ${t.known
                ? `<button class="ghost" data-action="unknown">↩ 覚え中に戻す</button>`
                : `<button class="ghost" data-action="known">👍 覚えた</button>`}
              <button class="ghost" data-action="delete">🗑 削除</button>
            </div>
          </article>`,
        )
        .join("")
    : `<p class="empty">${dictFilter === "known" ? "「知ってた」にした言葉はまだありません。" : "まだ言葉がありません。「聞く」から始めましょう。"}</p>`;
}

// ---------- 🎬 復習ショート（約30秒・読み上げ付き） ----------
const SHORT_SECONDS = 30;
const TODAY = "__today__";

// 古いデータ（場面の記録がない言葉）も「場面なし」として扱う
const sightingsOf = (t) => t.sightings ?? [{ scene: "場面なし", at: t.lastSeenAt, context: t.context }];

async function renderSceneOptions() {
  const scenes = new Map(); // 場面名 → 最後に出会った時刻
  for (const t of await allTerms()) {
    for (const s of sightingsOf(t)) scenes.set(s.scene, Math.max(scenes.get(s.scene) ?? 0, s.at));
  }
  const names = [...scenes.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  $("#short-scene").innerHTML =
    `<option value="${TODAY}">今日の分</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
}

/** 場面に合う言葉を選び、約30秒に収まるだけ並べる */
async function pickShortTerms(sceneKey) {
  const today = new Date().toDateString();
  const matches = (s) => (sceneKey === TODAY ? new Date(s.at).toDateString() === today : s.scene === sceneKey);
  const picked = [];
  let seconds = 4; // オープニングとエンディングの分
  const candidates = (await allTerms())
    .filter((t) => !t.known)
    .map((t) => ({ t, hit: sightingsOf(t).filter(matches).pop() }))
    .filter((x) => x.hit)
    .sort((a, b) => b.t.count - a.t.count); // 何度も出てきた言葉を優先
  for (const { t, hit } of candidates) {
    const cost = 2 + (t.reading.length + t.explanation.length) / 7; // 読み上げはおよそ毎秒7文字
    if (picked.length && seconds + cost > SHORT_SECONDS) continue;
    picked.push({ ...t, scene: hit.scene, snippet: snippetAround(hit.context, t.word) });
    seconds += cost;
  }
  return picked;
}

/** 文脈から、その言葉の前後だけを切り出す */
function snippetAround(context, word) {
  if (!context) return "";
  const i = context.indexOf(word);
  if (i < 0) return context.slice(0, 40) + (context.length > 40 ? "…" : "");
  const start = Math.max(0, i - 18);
  const end = Math.min(context.length, i + word.length + 18);
  return (start > 0 ? "…" : "") + context.slice(start, end) + (end < context.length ? "…" : "");
}

const short = { run: 0 };

function speak(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return setTimeout(resolve, 1500 + text.length * 120);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 1.1;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja"));
    if (voice) u.voice = voice;
    const done = () => { clearTimeout(guard); resolve(); };
    // 読み上げが止まってしまう端末のための保険
    const guard = setTimeout(done, 3000 + text.length * 250);
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function showSlide(html, progress) {
  $("#short-stage").innerHTML = `<div class="slide">${html}</div>`;
  $("#short-progress").style.width = `${progress * 100}%`;
}

async function playShort() {
  const sceneKey = $("#short-scene").value;
  const sceneLabel = sceneKey === TODAY ? "今日" : sceneKey;
  const terms = await pickShortTerms(sceneKey);
  if (!terms.length) {
    $("#short-status").textContent = "この場面で、まだ覚え中の言葉がありません。";
    return;
  }
  $("#short-status").textContent = "";
  $("#short-player").hidden = false;
  // 再生ごとに番号を振り、「もう一度」や「閉じる」で古い再生を確実に止める
  const run = ++short.run;
  const alive = () => run === short.run;
  const steps = terms.length + 2;

  showSlide(`<p class="kicker">🎬 復習ショート</p><h2>${esc(sceneLabel)}の言葉</h2><p class="sub">${terms.length}つ</p>`, 0);
  const where = sceneKey === TODAY ? "今日" : `${sceneLabel}で`;
  await speak(`${where}出会った言葉を、${terms.length}つ復習しましょう。`);

  for (const [i, t] of terms.entries()) {
    if (!alive()) return;
    showSlide(
      `<p class="kicker">${i + 1} / ${terms.length}</p>
       <h2 class="word">${esc(t.word)}</h2>
       <p class="reading">${esc(t.reading)}</p>
       <p class="meaning">${esc(t.explanation)}</p>
       ${t.snippet ? `<p class="heard">🎧 ${esc(t.scene)}で<br />「${esc(t.snippet)}」</p>` : ""}`,
      (i + 1) / steps,
    );
    await speak(`${t.reading}。${t.explanation}`);
    await wait(400);
  }
  if (!alive()) return;
  showSlide(`<h2>おつかれさま！</h2><p class="sub">覚えた言葉は、じしょで「覚えた」を押しましょう</p>`, 1);
  await speak("おつかれさまでした。");
}

function stopShort() {
  short.run++;
  window.speechSynthesis?.cancel();
}

$("#short-play").addEventListener("click", playShort);
$("#short-close").addEventListener("click", () => {
  stopShort();
  $("#short-player").hidden = true;
});
$("#short-replay").addEventListener("click", () => {
  stopShort();
  playShort();
});

// ---------- 設定 ----------
$("#about").value = localStorage.getItem("about") || "";
const lv = document.querySelector(`input[name="level"][value="${profile().level}"]`);
if (lv) lv.checked = true;

$("#save-profile").addEventListener("click", () => {
  localStorage.setItem("about", $("#about").value.trim());
  localStorage.setItem("level", document.querySelector('input[name="level"]:checked')?.value || "ふつう");
  $("#profile-status").textContent = "保存しました ✅";
});

$("#key-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("#api-key").value.trim();
  if (key) localStorage.setItem("apiKey", key);
  else localStorage.removeItem("apiKey");
  $("#api-key").value = "";
  showKeyStatus();
});

function showKeyStatus() {
  $("#key-status").textContent = localStorage.getItem("apiKey") ? "APIキー保存済み ✅" : "APIキーが未設定です";
}

$("#export").addEventListener("click", async () => {
  const blob = new Blob([JSON.stringify(await allTerms(), null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "nandakke-dictionary.json" });
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#wipe").addEventListener("click", async () => {
  if (confirm("じしょの言葉をすべて削除します。元に戻せません。よろしいですか？")) {
    await clearTerms();
    renderDict();
  }
});

showKeyStatus();
if (!localStorage.getItem("apiKey")) document.querySelector('nav [data-tab="settings"]').click();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
