// じしょ（出会った言葉）はすべてこの端末のブラウザ内（IndexedDB）に保存する
const DB_NAME = "nandakke-ai";
const STORE = "terms";

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    // 言葉そのものをキーにして、同じ言葉は1件にまとめる
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "word" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const getTerm = (word) => tx("readonly", (s) => s.get(word));
export const putTerm = (term) => tx("readwrite", (s) => s.put(term));
export const deleteTerm = (word) => tx("readwrite", (s) => s.delete(word));
export const clearTerms = () => tx("readwrite", (s) => s.clear());

/** 最後に出会った順で全件 */
export async function allTerms() {
  const list = await tx("readonly", (s) => s.getAll());
  return list.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
