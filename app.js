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
    if (btn.dataset.tab === "dict") renderDict();
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
async function rememberAndShow(found, context) {
  for (const f of found) {
    const old = await getTerm(f.word);
    if (old?.known) continue;
    const now = Date.now();
    const term = {
      ...f,
      context,
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
  try {
    const known = (await allTerms()).filter((t) => t.known).slice(0, 300).map((t) => t.word);
    const found = await findTerms({ newText, context, profile: profile(), known, skip: [...session.words] });
    session.sentUpTo = upTo;
    session.lastSentAt = Date.now();
    await rememberAndShow(found, newText.slice(0, 200));
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
  Object.assign(session, { listening: true, text: "", sentUpTo: 0, lastSentAt: Date.now(), words: new Set() });
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
    await rememberAndShow([t], context);
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
