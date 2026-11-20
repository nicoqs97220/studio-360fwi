"use strict";
/* Studio 360FWI — moteur du studio dans le navigateur.
   Remplace le serveur : stockage (IndexedDB), catalogue, moteurs gratuits, lots, versions.
   Tout reste sur l'appareil ; seuls les textes et références d'un plan partent vers les moteurs choisis. */
const Core = (() => {
  const VERSION = "0.2.0";
  const CA = { "Client-Agent": "Studio360FWI:0.2:web" };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => new Date().toISOString();
  const newId = (p = "") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = o => JSON.parse(JSON.stringify(o));
  const safeName = s => String(s || "fichier").normalize("NFKD").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(0, 80) || "fichier";
  class HttpErr extends Error { constructor(msg, code) { super(msg); this.code = code; } }
  class EngineError extends Error { constructor(msg, kind = "échec") { super(msg); this.kind = kind; } }

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((ok, ko) => {
      const rq = indexedDB.open("studio360fwi", 1);
      rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore("kv"); d.createObjectStore("projects", { keyPath: "id" }); d.createObjectStore("files"); };
      rq.onsuccess = () => ok(rq.result); rq.onerror = () => ko(rq.error);
    });
    return dbp;
  }
  async function idb(store, mode, fn) {
    const d = await db();
    return new Promise((ok, ko) => { const t = d.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => ok(r && "result" in r ? r.result : undefined); t.onerror = () => ko(t.error); t.onabort = () => ko(t.error); });
  }
  const kvGet = k => idb("kv", "readonly", s => s.get(k));
  const kvSet = (k, v) => idb("kv", "readwrite", s => s.put(v, k));
  const fileGet = k => idb("files", "readonly", s => s.get(k));
  const filePut = (k, b) => idb("files", "readwrite", s => s.put(b, k));
  const fileDel = k => idb("files", "readwrite", s => s.delete(k));

  /* ---------- état ---------- */
  let settings = { keys: {}, autoLaunch: true, excluded: [] };
  let catalog = { checkedAt: null, engines: {}, history: [] };
  const projects = new Map();
  const timers = new Map();
  function save(p) {
    p.updated = now(); clearTimeout(timers.get(p.id));
    timers.set(p.id, setTimeout(() => { timers.delete(p.id); idb("projects", "readwrite", s => s.put(clone(p))).catch(e => console.error(e)); }, 250));
  }
  window.addEventListener("pagehide", () => { for (const [pid] of timers) { const p = projects.get(pid); if (p) idb("projects", "readwrite", s => s.put(clone(p))); } });

  /* ---------- médias : URL locales ---------- */
  const urls = new Map();
  const fkey = (pid, rel) => pid + "/" + rel;
  async function preload(p) {
    const rels = new Set();
    for (const pl of p.plans) { pl.refs.forEach(r => rels.add(r.file)); pl.lots.forEach(l => l.tasks.forEach(t => t.file && rels.add(t.file))); if (pl.favorite) rels.add(pl.favorite.file); }
    p.assets.forEach(a => rels.add(a.file));
    await Promise.all([...rels].map(async rel => { const k = fkey(p.id, rel); if (!urls.has(k)) { const b = await fileGet(k); if (b) urls.set(k, URL.createObjectURL(b)); } }));
  }
  function mediaUrl(pid, rel) { return urls.get(fkey(pid, rel)) || ""; }
  async function storeFile(pid, rel, blob) { await filePut(fkey(pid, rel), blob); const k = fkey(pid, rel); if (urls.has(k)) URL.revokeObjectURL(urls.get(k)); urls.set(k, URL.createObjectURL(blob)); }
  async function download(pid, rel) {
    const b = await fileGet(fkey(pid, rel)); if (!b) throw new Error("Fichier introuvable sur cet appareil");
    const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = rel.split("/").pop(); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  const blobToDataUrl = b => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(b); });

  /* ---------- files d'attente ---------- */
  class Lane {
    constructor() { this.chain = Promise.resolve(); this.next = 0; }
    run(fn, gap) { const p = this.chain.then(async () => { const w = this.next - Date.now(); if (w > 0) await sleep(w); try { return await fn(); } finally { this.next = Math.max(this.next, Date.now() + gap); } }); this.chain = p.catch(() => {}); return p; }
  }
  const lanes = { pollImg: new Lane(), pollTxt: new Lane(), agnesImg: new Lane(), agnesVid: new Lane(), hf: new Lane(), horde: new Lane() };
  async function readJson(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } }
  function errFrom(status, d) {
    const m = (d && (d.error && (d.error.message || d.error) || d.detail || d.message || d.raw)) || "HTTP " + status;
    const t = typeof m === "string" ? m : JSON.stringify(m);
    return new EngineError(t.slice(0, 300), status === 429 || status === 402 || /quota|limit|exceeded|FREE_LIMIT|kudos/i.test(t) ? "quota atteint" : "échec");
  }
  const DIMS = { "9:16": [576, 1024], "16:9": [1024, 576], "1:1": [768, 768], "4:5": [640, 800], "4:3": [896, 672], "3:4": [672, 896] };

  /* ---------- moteurs ---------- */
  const pollinations = {
    id: "pollinations", kind: "image", name: "Pollinations", provider: "Pollinations.ai", model: "Modèle classique (non communiqué)", family: "pollinations-classic",
    access: "API publique sans clé", quota: "1 image toutes les 45 s par connexion Internet", inputs: "Texte seulement", lang: "en", maxImages: 0,
    limits: "≈ 768×768 px de surface, petit logo dans le coin", commercial: "Selon les conditions de Pollinations (à vérifier pour la publicité)",
    source: "https://github.com/pollinations/pollinations/blob/master/APIDOCS.md",
    async check() { const r = await fetch("https://image.pollinations.ai/prompt/ping?width=64&height=64&seed=1", { method: "HEAD" }); return { ok: r.status < 500, detail: r.status === 200 ? "Disponible" : r.status === 429 || r.status === 402 ? "Disponible (fenêtre de 45 s en cours)" : "Réponse " + r.status }; },
    async run(t, ctx) {
      const [w, h] = DIMS[t.sent.ratio] || DIMS["9:16"]; t.sent.params = { width: w, height: h, seed: t.sent.seed };
      return lanes.pollImg.run(async () => {
        for (let i = 0; i < 4; i++) {
          ctx.update("en cours", i ? "Nouvel essai après la limite de 45 s" : "Envoyé à Pollinations");
          const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(t.sent.prompt)}?width=${w}&height=${h}&seed=${t.sent.seed}`);
          const ct = r.headers.get("content-type") || "";
          if (r.ok && ct.startsWith("image")) return ctx.saveBlob(await r.blob(), ct.includes("png") ? "png" : "jpg");
          const d = await readJson(r); const ra = Number(r.headers.get("retry-after")) || 0;
          if (r.status === 402 && ra && i < 3) { ctx.update("en attente", `Limite gratuite : départ dans ${ra} s`); await sleep(ra * 1000 + 500); continue; }
          if (/Turnstile/i.test(JSON.stringify(d))) throw new EngineError("Pollinations refuse les pages ouvertes depuis localhost : ouvre le studio depuis son adresse en ligne ou le fichier.");
          throw errFrom(r.status, d);
        }
        throw new EngineError("Limite gratuite toujours atteinte", "quota atteint");
      }, 46000);
    },
  };
  function horde(id, model, label, family) {
    return {
      id, kind: "image", name: "AI Horde · " + label, provider: "AI Horde (réseau communautaire de bénévoles)", model, family,
      access: "API publique, clé anonyme ou compte gratuit", quota: "Gratuit ; en anonyme, priorité basse et ≈ 600×600 px de surface", inputs: "Texte + 1 image de base (rôle « Scène / image de base »)", lang: "en",
      maxImages: 1, imageRoles: ["Scène / image de base"], limits: "Attente variable selon les bénévoles connectés", commercial: "Licence du modèle à vérifier selon l'usage", source: "https://aihorde.net/api/",
      async check() { const d = await (await fetch("https://aihorde.net/api/v2/status/models?type=image&model_state=known", { headers: CA })).json(); const m = d.find(x => x.name === model); return m ? { ok: m.count > 0, detail: `${m.count} serveur(s) bénévole(s), attente estimée ${m.eta || 0} s` } : { ok: false, detail: "Modèle absent du réseau en ce moment" }; },
      async run(t, ctx) {
        const [w, h] = DIMS[t.sent.ratio] || DIMS["9:16"]; const big = /XL/i.test(model); const anon = !settings.keys.horde;
        const k = Math.sqrt((anon ? 360000 : big ? 1048576 : 589824) / (w * h)); const W = Math.floor(w * k / 64) * 64, H = Math.floor(h * k / 64) * 64;
        const body = { prompt: t.sent.prompt, params: { width: W, height: H, steps: anon ? 20 : big ? 25 : 22, n: 1, sampler_name: "k_euler_a", cfg_scale: big ? 5 : 6.5, seed: String(t.sent.seed) }, models: [model], r2: true, nsfw: false, censor_nsfw: true };
        const base = ctx.refImages[0];
        if (base) { body.source_image = base.dataUrl.split(",")[1]; body.source_processing = "img2img"; body.params.denoising_strength = 0.62; t.sent.refs = [base.mention + " (image de base)"]; }
        t.sent.params = { ...body.params, model };
        let id = t.remote && t.remote.id;
        if (!id) {
          // Le réseau accepte au plus 2 demandes par seconde : envois espacés, nouvel essai si refus de fréquence.
          id = await lanes.horde.run(async () => {
            for (let i = 0; i < 4; i++) {
              const r = await fetch("https://aihorde.net/api/v2/generate/async", { method: "POST", headers: { "Content-Type": "application/json", apikey: settings.keys.horde || "0000000000", ...CA }, body: JSON.stringify(body) });
              const d = await readJson(r); if (r.ok && d.id) return d.id;
              if ((r.status === 429 || /per 1 second|too many/i.test(JSON.stringify(d))) && i < 3) { await sleep(1500 * (i + 1)); continue; }
              throw errFrom(r.status, d);
            }
          }, 1200);
          t.remote = { id }; ctx.persist();
        }
        const t0 = Date.now();
        while (Date.now() - t0 < 20 * 60000) {
          if (ctx.cancelled()) throw new EngineError("Annulé", "annulé");
          const st = await readJson(await fetch("https://aihorde.net/api/v2/generate/check/" + id, { headers: CA }));
          if (st.faulted) throw new EngineError("Le serveur bénévole a échoué");
          if (st.is_possible === false) throw new EngineError("Aucun serveur bénévole ne peut traiter ces réglages");
          if (st.done) break;
          ctx.update("en cours", st.processing ? "Calcul chez un bénévole" : `En file : position ${st.queue_position ?? "?"}, ≈ ${st.wait_time ?? "?"} s`);
          await sleep(6000);
        }
        const fin = await readJson(await fetch("https://aihorde.net/api/v2/generate/status/" + id, { headers: CA }));
        const g = fin.generations && fin.generations[0]; if (!g || !g.img) throw new EngineError("Délai dépassé ou image absente"); if (g.censored) throw new EngineError("Image filtrée par le réseau");
        const r = await fetch(g.img); if (!r.ok) throw new EngineError("Téléchargement du résultat impossible");
        t.sent.params.worker = g.worker_name; return ctx.saveBlob(await r.blob(), "webp");
      },
    };
  }
  const hfFlux = {
    id: "hf-flux-schnell", kind: "image", name: "Hugging Face · FLUX.1 schnell", provider: "Hugging Face Spaces (ZeroGPU), Space de Black Forest Labs", model: "FLUX.1 [schnell]", family: "flux-schnell",
    access: "API Gradio publique ; jeton Hugging Face gratuit facultatif", quota: "Quota GPU quotidien (quelques minutes ; plus avec un compte gratuit)", inputs: "Texte seulement", lang: "en", maxImages: 0,
    limits: "4 étapes, rapide (≈ 9 s mesuré le 20/11/2026)", commercial: "Licence FLUX.1 schnell : Apache 2.0", source: "https://huggingface.co/spaces/black-forest-labs/FLUX.1-schnell",
    async check() { const d = await (await fetch("https://huggingface.co/api/spaces/black-forest-labs/FLUX.1-schnell")).json(); const s = d.runtime && d.runtime.stage; return { ok: /RUNNING/.test(s || ""), detail: "État du Space : " + (s || "inconnu") }; },
    async run(t, ctx) {
      const [w, h] = DIMS[t.sent.ratio] || DIMS["9:16"]; t.sent.params = { width: w, height: h, seed: t.sent.seed, steps: 4 };
      const base = "https://black-forest-labs-flux-1-schnell.hf.space/gradio_api"; const auth = settings.keys.hf ? { Authorization: "Bearer " + settings.keys.hf } : {};
      return lanes.hf.run(async () => {
        ctx.update("en cours", "Envoyé au Space Hugging Face");
        const r = await fetch(base + "/call/infer", { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ data: [t.sent.prompt, t.sent.seed, false, w, h, 4] }) });
        const d = await readJson(r); if (!r.ok || !d.event_id) throw errFrom(r.status, d);
        const s = await (await fetch(base + "/call/infer/" + d.event_id, { headers: auth })).text();
        const ev = [...s.matchAll(/event: (\w+)\ndata: (.*)/g)]; const last = ev[ev.length - 1];
        if (!last || last[1] !== "complete") { const m = last ? last[2] : s.slice(0, 200); if (/quota|GPU|exceeded/i.test(m) || (last && last[1] === "error" && /^\s*null\s*$/.test(m))) throw new EngineError("Quota GPU gratuit épuisé pour aujourd'hui" + (settings.keys.hf ? "" : " (un jeton Hugging Face gratuit l'augmente)"), "quota atteint"); throw new EngineError("Le Space a répondu : " + String(m).slice(0, 200)); }
        const url = (last[2].match(/"url":\s*"([^"]+)"/) || [])[1]; if (!url) throw new EngineError("Pas d'image dans la réponse");
        const img = await fetch(url, { headers: auth }); if (!img.ok) throw new EngineError("Téléchargement du résultat impossible");
        return ctx.saveBlob(await img.blob(), "webp");
      }, 2000);
    },
  };
  const AGNES = "https://apihub.agnes-ai.com";
  async function agnes(path, body) {
    const r = await fetch(AGNES + path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + settings.keys.agnes, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const d = await readJson(r); if (!r.ok) throw errFrom(r.status, d); return d;
  }
  const agnesImage = {
    id: "agnes-image", kind: "image", name: "Agnes Image 2.5 Flash", provider: "Agnes AI", model: "agnes-image-2.5-flash", family: "agnes-image",
    access: "API officielle, clé gratuite", quota: "≈ 10 images/min en 1K (offre gratuite « durée limitée »)", inputs: "Texte (lit le chinois) + jusqu'à 10 images de référence", lang: "zh", maxImages: 10, imageRoles: "all", needsKey: "agnes",
    limits: "1K à 4K", commercial: "Conditions Agnes AI à vérifier pour la publicité", source: "https://agnes-ai.com/en/docs/agnes-image-25-flash",
    async check() { if (!settings.keys.agnes) return { ok: false, detail: "Clé Agnes à ajouter dans Réglages", needsKey: true }; await agnes("/v1/models"); return { ok: true, detail: "Clé valide" }; },
    async run(t, ctx) {
      const body = { model: "agnes-image-2.5-flash", prompt: t.sent.prompt, size: "1K", ratio: t.sent.ratio || "9:16", extra_body: { response_format: "url" } };
      if (ctx.refImages.length) { body.extra_body.image = ctx.refImages.map(i => i.dataUrl); t.sent.refs = ctx.refImages.map(i => i.mention); }
      t.sent.params = { model: body.model, size: "1K", ratio: body.ratio };
      return lanes.agnesImg.run(async () => {
        ctx.update("en cours", "Envoyé à Agnes");
        const d = await agnes("/v1/images/generations", body); const x = d.data && d.data[0];
        if (x && x.b64_json) return ctx.saveBlob(await (await fetch("data:image/png;base64," + x.b64_json)).blob(), "png");
        if (x && x.url) { const r = await fetch(x.url); if (!r.ok) throw new EngineError("Téléchargement du résultat impossible"); return ctx.saveBlob(await r.blob(), "png"); }
        throw new EngineError("Réponse inattendue d'Agnes");
      }, 6500);
    },
  };
  const agnesVideo = {
    id: "agnes-video", kind: "video", name: "Agnes Video 2.5 Flash", provider: "Agnes AI", model: "agnes-video-2.5-flash", family: "agnes-video",
    access: "API officielle, clé gratuite", quota: "1 vidéo/min, 720p, 4 à 12 s (gratuit « durée limitée »)", inputs: "Texte (lit le chinois) ; les images de référence exigent un lien public", lang: "zh", maxImages: 0, needsKey: "agnes",
    limits: "720p uniquement", commercial: "Conditions Agnes AI à vérifier pour la publicité", source: "https://agnes-ai.com/en/docs/agnes-video-25-flash",
    async check() { return agnesImage.check(); },
    async run(t, ctx) {
      const body = { model: "agnes-video-2.5-flash", prompt: t.sent.prompt, seconds: String(Math.min(12, Math.max(4, t.sent.seconds || 5))), mode: "text", size: "720P", aspect_ratio: t.sent.ratio || "9:16" };
      t.sent.params = { model: body.model, seconds: body.seconds, size: "720P", aspect_ratio: body.aspect_ratio };
      let vid = t.remote && t.remote.id;
      if (!vid) { const d = await lanes.agnesVid.run(() => { ctx.update("en cours", "Envoyé à Agnes"); return agnes("/v1/videos", body); }, 61000); vid = d.video_id || d.id || d.task_id; if (!vid) throw new EngineError("Pas d'identifiant de vidéo"); t.remote = { id: vid }; ctx.persist(); }
      const t0 = Date.now();
      while (Date.now() - t0 < 30 * 60000) {
        if (ctx.cancelled()) throw new EngineError("Annulé", "annulé");
        const d = await agnes("/agnesapi?video_id=" + encodeURIComponent(vid) + "&model_name=agnes-video-2.5-flash");
        if (d.status === "completed" && d.url) { const r = await fetch(d.url); if (!r.ok) throw new EngineError("Téléchargement du clip impossible"); return ctx.saveBlob(await r.blob(), "mp4"); }
        if (d.status === "failed") throw new EngineError((d.error && (d.error.message || d.error)) || "La génération a échoué");
        ctx.update("en cours", "Calcul du clip " + (d.progress ? d.progress + " %" : "")); await sleep(4000);
      }
      throw new EngineError("Délai dépassé (30 min)");
    },
  };
  const ENGINES = [pollinations, horde("horde-dreamshaper", "Dreamshaper", "DreamShaper", "dreamshaper"), horde("horde-juggernaut-xl", "Juggernaut XL", "Juggernaut XL", "juggernaut-xl"),
    horde("horde-albedobase-xl", "AlbedoBase XL (SDXL)", "AlbedoBase XL", "albedobase-xl"), horde("horde-deliberate", "Deliberate", "Deliberate", "deliberate"), hfFlux, agnesImage, agnesVideo];
  const engineById = id => ENGINES.find(e => e.id === id);
  const fiche = e => { const { run, check, ...f } = e; return f; };

  async function refreshCatalog() {
    const before = clone(catalog.engines);
    await Promise.all(ENGINES.map(async e => {
      try { catalog.engines[e.id] = { ...(await e.check()), checkedAt: now() }; }
      catch (err) { catalog.engines[e.id] = { ok: false, networkError: true, detail: "Contrôle impossible : " + String(err.message || err).slice(0, 140), checkedAt: now(), lastOk: before[e.id] && before[e.id].ok ? before[e.id].checkedAt : (before[e.id] || {}).lastOk || null }; }
      const b = before[e.id], a = catalog.engines[e.id];
      if (b && b.ok !== a.ok) catalog.history.unshift({ at: now(), engine: e.name, change: a.ok ? "redevenu disponible" : "devenu indisponible : " + a.detail });
    }));
    catalog.history = catalog.history.slice(0, 50); catalog.checkedAt = now(); await kvSet("catalog", catalog);
  }
  function catalogView() { return { checkedAt: catalog.checkedAt, history: catalog.history, engines: ENGINES.map(e => ({ ...fiche(e), status: catalog.engines[e.id] || null, excluded: settings.excluded.includes(e.id), keyMissing: !!(e.needsKey && !settings.keys[e.needsKey]) })) }; }

  /* ---------- texte et recherche ---------- */
  const cleanTxt = t => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  async function llm(messages) {
    if (settings.keys.agnes) { const d = await agnes("/v1/chat/completions", { model: "agnes-3.0-flash", messages }); return { text: cleanTxt(d.choices[0].message.content), via: "Agnes 3.0 Flash" }; }
    return lanes.pollTxt.run(async () => {
      for (let i = 0; i < 5; i++) {
        const r = await fetch("https://text.pollinations.ai/openai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }) });
        const d = await readJson(r);
        if (r.ok && d.choices) return { text: cleanTxt(d.choices[0].message.content), via: "Pollinations (gratuit, 1 réponse / 45 s)" };
        const ra = Number(r.headers.get("retry-after")) || (r.status === 503 ? 10 : 0);
        if ((r.status === 402 || r.status === 503 || r.status === 429) && ra && i < 4) { await sleep(ra * 1000 + 500); continue; }
        throw errFrom(r.status, d);
      }
      throw new EngineError("Le service de texte gratuit est saturé. Réessaie dans une minute, ou ajoute ta clé Agnes gratuite dans Réglages.", "quota atteint");
    }, 46000);
  }
  const STOP = new Set("un une des le la les de du d l au aux et ou en dans sur sous avec pour par qui que quoi dont fait faire fais font est sont a ont il elle ils elles je tu on nous vous mon ma mes ton ta tes son sa ses ce cet cette ces se leur leurs plus très trop comme veux voudrais voir".split(" "));
  async function research(text) {
    const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).map(w => w.replace(/^[ld]'/, "")).filter(w => w && !STOP.has(w));
    const queries = [], found = [], seen = new Set();
    const search = async q => { const d = await (await fetch(`https://fr.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=3&prop=extracts|info&exintro=1&explaintext=1&exsentences=2&inprop=url&format=json&origin=*`)).json(); return Object.values((d.query && d.query.pages) || {}).sort((a, b) => a.index - b.index); };
    const norm = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ");
    // Une page n'est retenue que si son titre reprend vraiment les mots cherchés (évite les résultats hors sujet).
    const relevant = (pages, ws) => pages.filter(pg => { const t = " " + norm(pg.title) + " "; const hits = ws.filter(w => t.includes(" " + norm(w).trim() + " ") || t.includes(norm(w).trim())).length; return hits >= Math.min(2, ws.length) || (ws.length === 1 && norm(pg.extract || "").includes(norm(ws[0]).trim())); });
    let rest = words.slice();
    for (let g = 0; rest.length && g < 4; g++) {
      let hit = null, used = 0;
      for (let n = Math.min(rest.length, 4); n >= 1; n--) { const ws = rest.slice(0, n); const q = ws.join(" "); queries.push(q); const pages = relevant(await search(q), ws); if (pages.length) { hit = pages; used = n; break; } }
      if (hit) for (const p of hit.slice(0, 2)) if (!seen.has(p.title)) { seen.add(p.title); found.push({ query: rest.slice(0, used).join(" "), title: p.title, url: p.fullurl, extract: p.extract || "" }); }
      rest = rest.slice(Math.max(used, 1));
    }
    return { queries, sources: found };
  }

  /* ---------- projets et plans ---------- */
  function newPlan(p, title) {
    const num = p.plans.reduce((m, x) => Math.max(m, x.num), 0) + 1;
    const pl = { id: newId("pl"), num, code: "P" + String(num).padStart(2, "0"), title: title || "Plan " + num, mode: "image", objective: "", description: "", func: "", action: "", framing: "", camera: "", light: "", constraints: "", ratio: "9:16", seconds: 5,
      refs: [], research: null, summary: { text: "", status: "brouillon" }, promptFr: "", promptZh: "", promptEn: "", versions: [], version: 0, lots: [], favorite: null, state: "brouillon", created: now(), hold: false };
    p.plans.push(pl); p.activePlanId = pl.id; return pl;
  }
  const KIND = { image: /\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i, video: /\.(mp4|mov|webm|m4v|mkv|avi)$/i, audio: /\.(mp3|wav|m4a|aac|ogg|flac)$/i };
  const kindOf = (name, type = "") => KIND.image.test(name) || type.startsWith("image/") ? "image" : KIND.video.test(name) || type.startsWith("video/") ? "video" : KIND.audio.test(name) || type.startsWith("audio/") ? "audio" : "doc";
  function renumber(pl) { const c = { image: 0, video: 0, audio: 0, doc: 0 }, l = { image: "Image", video: "Video", audio: "Audio", doc: "Doc" }; for (const r of pl.refs) { c[r.kind]++; r.mention = "@" + l[r.kind] + c[r.kind]; } }
  const PLAN_FIELDS = ["title", "code", "mode", "objective", "description", "func", "action", "framing", "camera", "light", "constraints", "ratio", "seconds", "promptFr", "promptZh", "promptEn", "hold"];
  function planContext(p, pl) {
    const b = p.brief || {};
    const refs = pl.refs.map(r => `${r.mention} — ${r.original} — rôle : ${r.role}${r.required ? " (obligatoire)" : ""} — visible : ${r.description || "non décrit"}`).join("\n") || "aucune";
    return [`Projet : ${p.name}${p.client ? " (client " + p.client + ")" : ""}`, b.produit ? `Produit : ${b.produit}` : "", b.da ? `Direction artistique : ${b.da}` : "", b.concept ? `Concept retenu : ${b.concept}` : "",
      `Plan ${pl.code} « ${pl.title} » — ${pl.mode === "video" ? "vidéo " + pl.seconds + " s" : "image"} — format ${pl.ratio}`, pl.objective ? `Objectif visuel : ${pl.objective}` : "", `Demande : ${pl.description}`,
      pl.func ? `Fonction dans la séquence : ${pl.func}` : "", pl.action ? `Action : ${pl.action}` : "", pl.framing ? `Cadrage : ${pl.framing}` : "", pl.camera ? `Caméra : ${pl.camera}` : "", pl.light ? `Lumière : ${pl.light}` : "", pl.constraints ? `Contraintes : ${pl.constraints}` : "",
      `Références dans l'ordre d'envoi :\n${refs}`].filter(Boolean).join("\n");
  }
  function snapshot(pl, label) {
    pl.version += 1;
    pl.versions.push({ n: pl.version, date: now(), label: label || "Version " + pl.version, summary: pl.summary.text, promptFr: pl.promptFr, promptZh: pl.promptZh, promptEn: pl.promptEn,
      fields: Object.fromEntries(["objective", "description", "func", "action", "framing", "camera", "light", "constraints", "ratio", "seconds", "mode"].map(k => [k, pl[k]])),
      refs: pl.refs.map(r => ({ mention: r.mention, original: r.original, file: r.file, role: r.role, required: r.required, description: r.description })) });
  }

  /* ---------- lots ---------- */
  function eligibility(e, pl) {
    if (settings.excluded.includes(e.id)) return { eligible: false, reason: "Exclu par toi dans le catalogue" };
    if (e.needsKey && !settings.keys[e.needsKey]) return { eligible: false, reason: "Clé gratuite à ajouter dans Réglages" };
    const c = catalog.engines[e.id]; if (c && c.ok === false && !c.networkError) return { eligible: false, reason: "Indisponible au dernier contrôle : " + c.detail };
    const req = pl.refs.filter(r => r.required);
    const refused = req.filter(r => r.kind !== "image" || !e.maxImages || (e.imageRoles !== "all" && !(e.imageRoles || []).includes(r.role)));
    if (refused.length) return { eligible: false, reason: "N'accepte pas " + refused.map(r => `${r.mention} (${r.role})`).join(", ") + ", marqué obligatoire" };
    if (req.length > (e.maxImages || 0)) return { eligible: false, reason: `Accepte ${e.maxImages} image(s), ${req.length} obligatoire(s)` };
    return { eligible: true, reason: "" };
  }
  const imageRefs = (e, pl) => !e.maxImages ? [] : pl.refs.filter(r => r.kind === "image" && (e.imageRoles === "all" || (e.imageRoles || []).includes(r.role))).slice(0, e.maxImages);
  const running = new Map();
  function createLot(p, pl, only) {
    const fam = new Map();
    const engines = ENGINES.filter(e => e.kind === pl.mode).map(e => {
      let el = eligibility(e, pl);
      if (el.eligible && only && !only.includes(e.id)) el = { eligible: false, reason: "Retiré de ce lot" };
      if (el.eligible && fam.has(e.family)) el = { eligible: false, reason: "Doublon du même modèle que " + fam.get(e.family) };
      if (el.eligible) fam.set(e.family, e.name);
      return { engineId: e.id, name: e.name, model: e.model, ...el };
    });
    const lot = { id: newId("l"), n: pl.lots.length + 1, version: pl.version, mode: pl.mode, created: now(), target: pl.mode === "image" ? 6 : null, engines, tasks: [], favoriteTaskId: null };
    const seed = Math.floor(Math.random() * 2 ** 31);
    for (const x of engines.filter(x => x.eligible)) {
      const e = engineById(x.engineId); const zh = e.lang === "zh" && pl.promptZh.trim();
      let prompt = zh ? pl.promptZh : (pl.promptEn.trim() || pl.promptFr); if (!zh) prompt = prompt.replace(/@(Image|Video|Audio|Doc)\d+/g, "").replace(/\s{2,}/g, " ").trim();
      lot.tasks.push({ id: newId("t"), engineId: e.id, engineName: e.name, model: e.model, status: "en attente", note: "En file",
        sent: { prompt, lang: zh ? "chinois (validé)" : pl.promptEn.trim() ? "anglais (adaptation pour ce moteur)" : "français (aucune adaptation)", ratio: pl.ratio, seconds: pl.seconds, seed, refs: imageRefs(e, pl).map(r => r.mention), params: {} },
        remote: null, file: null, error: null, started: null, ended: null });
    }
    pl.lots.push(lot); pl.state = "en cours"; save(p);
    lot.tasks.forEach(t => runTask(p, pl, lot, t));
    return lot;
  }
  async function runTask(p, pl, lot, t) {
    if (running.has(t.id)) return; const ctl = { cancel: false }; running.set(t.id, ctl);
    const e = engineById(t.engineId);
    const ctx = {
      refImages: [], update(st, note) { if (ctl.cancel) return; t.status = st; t.note = note || ""; t.started = t.started || now(); save(p); }, persist() { save(p); }, cancelled: () => ctl.cancel,
      async saveBlob(blob, ext) { const rel = `results/${pl.code}_v${lot.version}_L${lot.n}_${e.id}_${t.id}.${ext}`; await storeFile(p.id, rel, blob); return { rel, size: blob.size }; },
    };
    try {
      if (!e) throw new EngineError("Moteur retiré de cette version");
      for (const r of imageRefs(e, pl)) { const b = await fileGet(fkey(p.id, r.file)); if (b) ctx.refImages.push({ mention: r.mention, dataUrl: await blobToDataUrl(b) }); }
      const out = await e.run(t, ctx);
      if (!out || !out.size) throw new EngineError("Fichier reçu vide");
      if (ctl.cancel) t.status = "annulé"; else { t.file = out.rel; t.status = "disponible"; t.note = ""; }
    } catch (err) { t.status = ctl.cancel ? "annulé" : (err.kind || "échec"); t.error = String(err.message || err).slice(0, 400); }
    finally { t.ended = now(); running.delete(t.id); if (!pl.lots.some(l => l.tasks.some(x => running.has(x.id))) && pl.state === "en cours") pl.state = pl.favorite ? "choisi" : "résultats"; save(p); }
  }

  /* ---------- routes (mêmes adresses que la version serveur) ---------- */
  const routes = [];
  const on = (m, re, fn) => routes.push({ m, re, fn });
  const getP = id => { const p = projects.get(id); if (!p) throw new HttpErr("Projet introuvable", 404); return p; };
  const getPl = (p, id) => { const pl = p.plans.find(x => x.id === id); if (!pl) throw new HttpErr("Plan introuvable", 404); return pl; };
  const mask = () => Object.fromEntries(Object.entries(settings.keys).filter(([, v]) => v).map(([k, v]) => [k, "…" + String(v).slice(-4)]));
  async function out(p) { await preload(p); return clone(p); }
  function dossier(p, pl) {
    const v = pl.versions[pl.versions.length - 1];
    return [`DOSSIER — ${p.name}${p.client ? " / " + p.client : ""} — plan ${pl.code} « ${pl.title} »${v ? " — version " + v.n : ""}`, "", planContext(p, pl), "",
      "Résumé " + (pl.summary.status === "validé" ? "validé" : "(non validé)") + " :", pl.summary.text || "—", "", "Prompt français :", pl.promptFr || "—", "", "Prompt chinois :", pl.promptZh || "—", "",
      "Pièces à joindre dans le chat, dans cet ordre :", ...pl.refs.map(r => `${r.mention} : ${r.original} (${r.role})`)].join("\n");
  }

  on("GET", /^\/api\/state$/, async () => {
    const list = [...projects.values()].sort((a, b) => b.updated.localeCompare(a.updated));
    for (const p of list) { const f = p.plans.find(x => x.favorite); if (f) { const k = fkey(p.id, f.favorite.file); if (!urls.has(k)) { const b = await fileGet(k); if (b) urls.set(k, URL.createObjectURL(b)); } } }
    return { version: VERSION, keys: mask(), autoLaunch: settings.autoLaunch, projects: list.map(p => ({ id: p.id, name: p.name, client: p.client, free: !!p.free, updated: p.updated, plans: p.plans.length, thumb: (p.plans.find(x => x.favorite) || {}).favorite || null })), catalog: catalogView() };
  });
  on("POST", /^\/api\/settings$/, async (b) => {
    if (b.keys) for (const [k, v] of Object.entries(b.keys)) if (["agnes", "hf", "horde"].includes(k)) settings.keys[k] = String(v || "").trim();
    if (typeof b.autoLaunch === "boolean") settings.autoLaunch = b.autoLaunch;
    if (Array.isArray(b.excluded)) settings.excluded = b.excluded.filter(engineById);
    await kvSet("settings", settings); if (b.keys) refreshCatalog().catch(() => {});
    return { keys: mask(), autoLaunch: settings.autoLaunch, catalog: catalogView() };
  });
  on("POST", /^\/api\/catalog\/refresh$/, async () => { await refreshCatalog(); return catalogView(); });
  on("POST", /^\/api\/projects$/, async (b) => {
    const p = { id: newId("p"), name: (b.name || "").trim() || "Nouveau projet", client: (b.client || "").trim(), free: !!b.free, created: now(), updated: now(), brief: {}, folders: ["Sélection"], assets: [], plans: [], activePlanId: null, avis: [] };
    projects.set(p.id, p); newPlan(p, ""); save(p); return out(p);
  });
  on("GET", /^\/api\/projects\/(\w+)$/, async (b, m) => out(getP(m[1])));
  on("PATCH", /^\/api\/projects\/(\w+)$/, async (b, m) => {
    const p = getP(m[1]); for (const k of ["name", "client", "activePlanId"]) if (k in b) p[k] = b[k];
    if (b.brief) p.brief = { ...p.brief, ...b.brief }; if (Array.isArray(b.folders)) p.folders = [...new Set(b.folders.map(s => String(s).trim()).filter(Boolean))];
    save(p); return out(p);
  });
  on("DELETE", /^\/api\/projects\/(\w+)$/, async (b, m) => {
    const p = getP(m[1]); if (p.plans.some(pl => pl.lots.some(l => l.tasks.some(t => running.has(t.id))))) throw new HttpErr("Des générations sont en cours dans ce projet", 409);
    const keys = await idb("files", "readonly", s => s.getAllKeys()); await Promise.all(keys.filter(k => k.startsWith(p.id + "/")).map(fileDel));
    projects.delete(p.id); await idb("projects", "readwrite", s => s.delete(p.id)); return { ok: true };
  });
  on("POST", /^\/api\/projects\/(\w+)\/plans$/, async (b, m) => { const p = getP(m[1]); newPlan(p, b.title); save(p); return out(p); });
  on("PATCH", /^\/api\/projects\/(\w+)\/plans\/(\w+)$/, async (b, m) => { const p = getP(m[1]); const pl = getPl(p, m[2]); for (const k of PLAN_FIELDS) if (k in b) pl[k] = b[k]; save(p); return out(p); });
  on("DELETE", /^\/api\/projects\/(\w+)\/plans\/(\w+)$/, async (b, m) => {
    const p = getP(m[1]); const pl = getPl(p, m[2]); if (pl.lots.some(l => l.tasks.some(t => running.has(t.id)))) throw new HttpErr("Des générations sont en cours sur ce plan", 409);
    p.plans = p.plans.filter(x => x !== pl); p.activePlanId = p.plans[0] ? p.plans[0].id : null; save(p); return out(p);
  });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/move$/, async (b, m) => { const p = getP(m[1]); const pl = getPl(p, m[2]); const i = p.plans.indexOf(pl), j = Math.max(0, Math.min(p.plans.length - 1, Number(b.to))); p.plans.splice(i, 1); p.plans.splice(j, 0, pl); save(p); return out(p); });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/refs$/, async (file, m, url) => {
    const p = getP(m[1]); const pl = getPl(p, m[2]);
    const original = url.searchParams.get("name") || (file && file.name) || "fichier"; const rid = newId("r"); const rel = `refs/${rid}_${safeName(original)}`;
    await storeFile(p.id, rel, file);
    const kind = kindOf(original, file.type || "");
    const role = kind === "video" ? "Mouvement (vidéo)" : kind === "audio" ? "Son / rythme" : kind === "doc" ? "Document" : (pl.refs.some(r => r.kind === "image") ? "Fiche personnage" : "Scène / image de base");
    pl.refs.push({ id: rid, kind, original, file: rel, description: "", role, required: false, batch: url.searchParams.get("batch"), added: now() }); renumber(pl); save(p); return { ok: true };
  });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/refs\/commit$/, async (b, m) => {
    const p = getP(m[1]); const pl = getPl(p, m[2]); const count = pl.refs.filter(r => r.batch === b.batch).length; let lot = null;
    if (count && settings.autoLaunch && !pl.hold && pl.summary.status === "validé" && (pl.promptZh || pl.promptEn || pl.promptFr)) { snapshot(pl, "Références ajoutées (" + count + ")"); lot = createLot(p, pl); }
    save(p); return { project: await out(p), lotId: lot && lot.id, count };
  });
  on("PATCH", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/refs\/(\w+)$/, async (b, m) => { const p = getP(m[1]); const r = getPl(p, m[2]).refs.find(x => x.id === m[3]); if (!r) throw new HttpErr("Référence introuvable", 404); for (const k of ["description", "role", "required"]) if (k in b) r[k] = b[k]; save(p); return out(p); });
  on("DELETE", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/refs\/(\w+)$/, async (b, m) => { const p = getP(m[1]); const pl = getPl(p, m[2]); pl.refs = pl.refs.filter(x => x.id !== m[3]); renumber(pl); save(p); return out(p); });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/refs\/order$/, async (b, m) => { const p = getP(m[1]); const pl = getPl(p, m[2]); pl.refs.sort((x, y) => b.ids.indexOf(x.id) - b.ids.indexOf(y.id)); renumber(pl); save(p); return out(p); });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/understand$/, async (b, m) => {
    const p = getP(m[1]); const pl = getPl(p, m[2]); if (typeof b.description === "string") pl.description = b.description;
    if (!pl.description.trim()) throw new HttpErr("Décris d'abord le plan (texte ou dictée).", 400);
    if (b.skipWeb) pl.research = { text: pl.description, queries: [], sources: [], date: now(), status: "ignorée", error: null };
    else { try { pl.research = { text: pl.description, ...(await research(pl.description)), date: now(), status: "ok", error: null }; } catch (e) { pl.research = { text: pl.description, queries: [], sources: [], date: now(), status: "indisponible", error: String(e.message || e) }; save(p); return { project: await out(p), webError: pl.research.error }; } }
    const src = (pl.research.sources || []).map((s, i) => `[${i + 1}] ${s.title} — ${s.extract}`).join("\n") || "aucune source trouvée";
    const s = await llm([{ role: "system", content: "Tu aides un créateur martiniquais à vérifier sa demande avant une génération d'image ou de vidéo. Réponds en français, en 3 à 6 phrases courtes, en le tutoyant. Commence par « Tu veux… ». Dis ce que tu as identifié grâce aux sources (cite [1], [2]), puis le lieu, le cadrage ou le format s'ils sont précisés, puis ce qui reste à son choix. Sépare les faits vérifiés des propositions artistiques. Si un doute changerait l'image, termine par une seule question de clarification. N'invente aucun fait." }, { role: "user", content: planContext(p, pl) + "\n\nSources Web :\n" + src }]);
    pl.summary = { text: s.text, status: "à valider", via: s.via, date: now() }; save(p); return { project: await out(p) };
  });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/validate$/, async (b, m) => {
    const p = getP(m[1]); const pl = getPl(p, m[2]); if (typeof b.summary === "string") pl.summary.text = b.summary;
    pl.summary.status = "validé"; pl.summary.validatedAt = now();
    const long = pl.mode === "video" ? "Pour la vidéo, le chinois ne dépasse pas 2 500 caractères (préférence Kling) et suit la timeline." : "";
    const src = (pl.research && pl.research.sources || []).map(s => `${s.title} : ${s.extract}`).join("\n");
    const r = await llm([{ role: "system", content: (src ? "Faits vérifiés sur le Web :\n" + src + "\n\n" : "") + "Tu écris des prompts de génération. Rends UNIQUEMENT un objet JSON {\"fr\":\"…\",\"zh\":\"…\",\"en\":\"…\"}. fr et zh décrivent exactement le même plan, dans le même ordre : sujet, action, cadrage, position de caméra, lumière, décor, contraintes. N'utilise QUE les mentions listées dans « Références dans l'ordre d'envoi » (@Image1, @Video1…), à chaque action concernée, à l'identique dans fr et zh ; s'il n'y a aucune référence, n'écris aucune mention @. Ne commence pas par « Plan 1 » et n'invente ni race, ni couleur, ni détail absent de la demande, du résumé ou des sources. zh est en chinois simplifié et traduit fidèlement les noms locaux (ex. « chien fer » : chien martiniquais à peau nue, pas un « chien de fête »). en est une adaptation anglaise pour les moteurs qui ne lisent ni le chinois ni les références : aucune mention @, décris en mots ce que montrent les références, 900 caractères maximum. Les paramètres techniques (format, durée) ne vont pas dans les prompts. " + long }, { role: "user", content: planContext(p, pl) + "\n\nRésumé validé :\n" + pl.summary.text }]);
    const mm = r.text.match(/\{[\s\S]*\}/); if (!mm) throw new HttpErr("Le service de texte n'a pas rendu de prompts lisibles. Réessaie.", 502);
    let j; try { j = JSON.parse(mm[0]); } catch { throw new HttpErr("Prompts illisibles, réessaie.", 502); }
    pl.promptFr = String(j.fr || "").trim(); pl.promptZh = String(j.zh || "").trim(); pl.promptEn = String(j.en || "").trim(); pl.promptsVia = r.via; pl.state = "validé";
    snapshot(pl, "Résumé validé"); let lot = null; if (settings.autoLaunch && !pl.hold && !b.hold) lot = createLot(p, pl);
    save(p); return { project: await out(p), lotId: lot && lot.id };
  });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/lots$/, async (b, m) => {
    const p = getP(m[1]); const pl = getPl(p, m[2]); if (!(pl.promptZh || pl.promptEn || pl.promptFr).trim()) throw new HttpErr("Valide d'abord le résumé pour obtenir les prompts.", 400);
    if (b.newVersion) snapshot(pl, b.label || "Prompts modifiés"); const lot = createLot(p, pl, Array.isArray(b.engines) && b.engines.length ? b.engines : null); return { project: await out(p), lotId: lot.id };
  });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/tasks\/(\w+)\/cancel$/, async (b, m) => { const p = getP(m[1]); for (const l of getPl(p, m[2]).lots) for (const t of l.tasks) if (t.id === m[3]) { const c = running.get(t.id); if (c) c.cancel = true; t.status = "annulé"; t.ended = now(); } save(p); return out(p); });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/choose$/, async (b, m) => {
    const p = getP(m[1]); const pl = getPl(p, m[2]); const lot = pl.lots.find(l => l.id === b.lotId); const t = lot && lot.tasks.find(x => x.id === b.taskId);
    if (!t || !t.file) throw new HttpErr("Résultat introuvable", 404); const done = [];
    if (b.favorite) { pl.favorite = { lotId: lot.id, taskId: t.id, file: t.file, engine: t.engineName, version: lot.version, date: now() }; lot.favoriteTaskId = t.id; pl.state = "choisi"; done.push("plan"); }
    let target = null;
    if (b.newProject) { target = { id: newId("p"), name: String(b.newProject).trim() || "Nouveau projet", client: "", free: false, created: now(), updated: now(), brief: {}, folders: ["Sélection"], assets: [], plans: [], activePlanId: null, avis: [] }; projects.set(target.id, target); newPlan(target, ""); }
    else if (b.project) target = getP(b.project);
    if (target) {
      const folder = String(b.folder || "Sélection").trim() || "Sélection"; if (!target.folders.includes(folder)) target.folders.push(folder);
      const rel = `dossiers/${safeName(folder)}/${pl.code}_v${lot.version}_${safeName(t.engineName)}_${t.id}.${t.file.split(".").pop()}`;
      const blob = await fileGet(fkey(p.id, t.file)); if (!blob) throw new HttpErr("Fichier du résultat absent de cet appareil", 404);
      await storeFile(target.id, rel, blob);
      target.assets.push({ id: newId("a"), folder, file: rel, planId: target === p ? pl.id : null, plan: pl.code, from: target === p ? null : (p.free ? "Créations libres" : p.name) + " · " + pl.code + " " + pl.title,
        lotId: lot.id, taskId: t.id, engine: t.engineName, model: t.model, prompt: t.sent.prompt, promptFr: pl.promptFr, promptZh: pl.promptZh, refs: pl.refs.map(r => r.mention + " " + r.original), params: t.sent.params, date: now(), validated: !!b.favorite });
      save(target); done.push(target === p ? "dossier" : "projet"); done.target = target.name;
    }
    save(p); return { project: await out(p), done, targetName: target && target.name, targetId: target && target.id };
  });
  on("POST", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/restore$/, async (b, m) => { const p = getP(m[1]); const pl = getPl(p, m[2]); const v = pl.versions.find(x => x.n === b.n); if (!v) throw new HttpErr("Version introuvable", 404); Object.assign(pl, v.fields, { promptFr: v.promptFr, promptZh: v.promptZh, promptEn: v.promptEn }); pl.summary = { ...pl.summary, text: v.summary }; save(p); return out(p); });
  on("GET", /^\/api\/projects\/(\w+)\/plans\/(\w+)\/dossier$/, async (b, m) => { const p = getP(m[1]); return { text: dossier(p, getPl(p, m[2])) }; });
  on("POST", /^\/api\/projects\/(\w+)\/avis$/, async (b, m) => { const p = getP(m[1]); p.avis.unshift({ id: newId("v"), planId: b.planId || null, author: b.author || "Assistant", question: b.question || "", answer: b.answer || "", date: now(), kept: false }); save(p); return out(p); });
  on("PATCH", /^\/api\/projects\/(\w+)\/avis\/(\w+)$/, async (b, m) => { const p = getP(m[1]); const a = p.avis.find(x => x.id === m[2]); if (a && "kept" in b) a.kept = !!b.kept; save(p); return out(p); });
  on("DELETE", /^\/api\/projects\/(\w+)\/avis\/(\w+)$/, async (b, m) => { const p = getP(m[1]); p.avis = p.avis.filter(x => x.id !== m[2]); save(p); return out(p); });

  /* ---------- export / import d'un projet (sauvegarde, passage PC ↔ téléphone) ---------- */
  async function exportProject(pid) {
    const p = getP(pid); const keys = (await idb("files", "readonly", s => s.getAllKeys())).filter(k => k.startsWith(pid + "/"));
    const files = {}; for (const k of keys) { const b = await fileGet(k); if (b) files[k.slice(pid.length + 1)] = await blobToDataUrl(b); }
    const blob = new Blob([JSON.stringify({ format: "studio360fwi-projet", version: VERSION, exported: now(), project: p, files })], { type: "application/json" });
    const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `${safeName(p.name)}_${now().slice(0, 10)}.studio360.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  async function importProject(file) {
    const d = JSON.parse(await file.text()); if (d.format !== "studio360fwi-projet") throw new Error("Ce fichier n'est pas un export Studio 360FWI.");
    const p = d.project; if (projects.has(p.id)) { p.id = newId("p"); p.name += " (copie importée)"; }
    for (const [rel, dataUrl] of Object.entries(d.files || {})) await filePut(fkey(p.id, rel), await (await fetch(dataUrl)).blob());
    for (const pl of p.plans) for (const l of pl.lots) for (const t of l.tasks) if (t.status === "en cours" || t.status === "en attente") { t.status = t.remote ? "en attente" : "échec"; if (!t.remote) t.error = "Interrompu avant l'export"; }
    projects.set(p.id, p); await idb("projects", "readwrite", s => s.put(clone(p))); resume(p); return p.id;
  }
  function resume(p) { for (const pl of p.plans) for (const l of pl.lots) for (const t of l.tasks) if (t.status === "en attente" || t.status === "en cours") { t.note = "Repris à la réouverture du studio"; runTask(p, pl, l, t); } }

  async function init() {
    settings = Object.assign(settings, (await kvGet("settings")) || {}); settings.keys = settings.keys || {}; settings.excluded = settings.excluded || [];
    catalog = Object.assign(catalog, (await kvGet("catalog")) || {});
    for (const p of (await idb("projects", "readonly", s => s.getAll())) || []) projects.set(p.id, p);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    refreshCatalog().catch(() => {}); setInterval(() => refreshCatalog().catch(() => {}), 30 * 60000);
    projects.forEach(resume);
  }
  async function api(method, path, data) {
    const url = new URL(path, "https://studio.local");
    for (const r of routes) { if (r.m !== method) continue; const m = r.re.exec(url.pathname); if (m) return r.fn(data === undefined ? {} : data, m, url); }
    throw new HttpErr("Action inconnue : " + method + " " + url.pathname, 404);
  }
  return { init, api, mediaUrl, download, exportProject, importProject, VERSION };
})();
