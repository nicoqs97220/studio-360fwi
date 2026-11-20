"use strict";
/* Studio 360FWI — interface (sans framework). */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = iso => iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
const ROLES = ["Scène / image de base", "Fiche personnage", "Décor", "Produit", "Logo", "Style / ambiance", "Mouvement (vidéo)", "Caméra (vidéo)", "Son / rythme", "Document", "Autre"];
const RATIOS = ["9:16", "16:9", "1:1", "4:5", "4:3", "3:4"];

const S = { state: null, project: null, view: "home", tab: "plans", poll: null };

/* ---------- utilitaires ---------- */
let toastT;
function toast(msg, ms = 4500) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
async function api(method, url, data, raw) { return Core.api(method, url, raw !== undefined ? raw : data); }
const media = (p, rel) => Core.mediaUrl(p.id, rel);
const debounce = (fn, ms = 500) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const plan = () => S.project && S.project.plans.find(x => x.id === S.project.activePlanId) || (S.project && S.project.plans[0]);
function setHash() { const pl = plan(); location.hash = S.view === "project" && S.project ? `p=${S.project.id}&t=${S.tab}${pl ? "&pl=" + pl.id : ""}` : "v=" + S.view; }
async function copy(text, what = "Texte copié.") { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast("Copie refusée par le navigateur : sélectionne le texte et copie-le à la main."); } }
function statusChip(st) {
  const cls = { "disponible": "ok", "en cours": "run", "en attente": "run", "quota atteint": "warn", "échec": "bad", "annulé": "", "exclu": "" }[st] ?? "";
  return `<span class="chip ${cls}">${esc(st)}</span>`;
}

/* ---------- plein écran ---------- */
let viewerReturn = null;
function openViewer(url, kind, caption) {
  viewerReturn = { el: document.activeElement, y: window.scrollY };
  const st = $("#viewerStage"); st.className = "stage"; st.innerHTML = "";
  if (kind === "video") { const v = document.createElement("video"); v.src = url; v.controls = true; v.autoplay = true; v.playsInline = true; st.append(v); }
  else if (kind === "audio") { const a = document.createElement("audio"); a.src = url; a.controls = true; a.autoplay = true; st.append(a); }
  else if (kind === "image") { const i = document.createElement("img"); i.src = url; i.alt = caption || ""; i.title = "Toucher pour zoomer"; i.onclick = () => st.classList.toggle("zoom"); st.append(i); }
  else { st.innerHTML = `<p style="color:#fff">Aperçu impossible pour ce type de fichier. <a style="color:#7fe3cf" href="${esc(url)}" target="_blank" rel="noopener">Ouvrir le fichier original</a></p>`; }
  $("#viewerCap").innerHTML = esc(caption || "") + ` · <a style="color:#7fe3cf" href="${esc(url)}" target="_blank" rel="noopener">fichier original</a>`;
  $("#viewer").hidden = false; $("#viewerClose").focus();
}
function closeViewer() {
  const st = $("#viewerStage"); $$("video,audio", st).forEach(m => m.pause()); st.innerHTML = "";
  $("#viewer").hidden = true;
  if (viewerReturn) { window.scrollTo(0, viewerReturn.y); viewerReturn.el && viewerReturn.el.focus && viewerReturn.el.focus({ preventScroll: true }); }
}
$("#viewerClose").onclick = closeViewer;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#viewer").hidden) closeViewer(); });

/* ---------- navigation ---------- */
$$("nav.main button").forEach(b => b.onclick = () => b.dataset.quick ? quickCreate(b.dataset.quick) : go(b.dataset.view));
/* Création rapide : une image ou une vidéo sans créer de projet (rangée dans « Créations libres »). */
async function quickCreate(mode) {
  await loadState();
  let free = S.state.projects.find(p => p.free);
  let p = free ? await api("GET", "/api/projects/" + free.id) : await api("POST", "/api/projects", { name: "Créations libres", free: true });
  const fresh = p.plans.length === 1 && !p.plans[0].description && !p.plans[0].refs.length && !p.plans[0].lots.length;
  if (!fresh) p = await api("POST", `/api/projects/${p.id}/plans`, { title: mode === "video" ? "Vidéo rapide" : "Image rapide" });
  const pl = p.plans.find(x => x.id === p.activePlanId);
  p = await api("PATCH", `/api/projects/${p.id}/plans/${pl.id}`, { mode, title: pl.title.startsWith("Plan") ? (mode === "video" ? "Vidéo rapide" : "Image rapide") : pl.title });
  S.project = p; S.tab = "plans"; await go("project");
  setTimeout(() => { const d = $("#f_description"); if (d) { d.scrollIntoView({ block: "center" }); d.focus(); } }, 50);
}
async function go(view, opts = {}) {
  S.view = view; if (opts.tab) S.tab = opts.tab;
  $$("nav.main button").forEach(b => b.setAttribute("aria-current", (b.dataset.view === view || (view === "project" && b.dataset.view === "home")) ? "page" : "false"));
  stopPoll();
  if (view === "home") await renderHome();
  else if (view === "project") await renderProject();
  else if (view === "catalog") await renderCatalog();
  else if (view === "settings") await renderSettings();
  else if (view === "guide") renderGuide();
  setHash(); window.scrollTo(0, 0);
}
async function loadState() { S.state = await api("GET", "/api/state"); $("#foot").textContent = "Version " + S.state.version + " · données sur cet appareil"; return S.state; }

/* ---------- accueil ---------- */
async function renderHome() {
  await loadState();
  const cat = S.state.catalog; const imgOk = cat.engines.filter(e => e.kind === "image" && e.status && e.status.ok && !e.excluded).length;
  $("#main").innerHTML = `
    <div class="row between"><div><h1>Que veux-tu créer ?</h1><p class="sub">Une image ou une vidéo tout de suite, ou un projet complet (brief, plusieurs plans, séquencier).</p></div>
    <span class="chip ${imgOk >= 5 ? "ok" : "warn"}">${imgOk} moteur(s) image gratuit(s) disponible(s)</span></div>
    <div class="quick">
      <button type="button" class="qbtn" data-qc="image"><span class="qi" aria-hidden="true">▣</span><b>Créer une image</b><span class="sub">Décris ou dicte, ajoute tes références, compare plusieurs générateurs gratuits.</span></button>
      <button type="button" class="qbtn" data-qc="video"><span class="qi" aria-hidden="true">▶</span><b>Créer une vidéo</b><span class="sub">Mêmes étapes, avec durée et format, envoyées aux générateurs vidéo compatibles.</span></button>
    </div>
    <h2>Projets</h2>
    <form class="box" id="newP"><h2>Nouveau projet</h2>
      <div class="grid2"><label class="f">Nom du projet<input type="text" id="npName" placeholder="Ex. Pub La Boudinière" required></label>
      <label class="f">Client <span class="h">(facultatif)</span><input type="text" id="npClient" placeholder="Ex. La Boudinière"></label></div>
      <div class="row"><button class="btn primary">Créer le projet</button></div></form>
    <div class="row"><label class="btn small">Importer un projet exporté<input type="file" id="importP" accept=".json,application/json" hidden></label><span class="sub">Pour reprendre sur cet appareil un projet exporté depuis un autre (PC ou téléphone).</span></div>
    <div class="projects">${S.state.projects.map(p => `
      <button type="button" class="pcard" data-pid="${p.id}"><div class="th">${p.thumb ? `<img src="${esc(media(p, p.thumb.file))}" alt="">` : "Pas encore de choix validé"}</div>
      <div class="b"><strong>${esc(p.name)}</strong><span class="sub">${esc(p.client || "Sans client")} · ${p.plans} plan(s) · modifié ${fmtDate(p.updated)}</span></div></button>`).join("") || `<div class="empty">Aucun projet. Crée le premier ci-dessus.</div>`}</div>`;
  $("#newP").onsubmit = async e => { e.preventDefault(); const p = await api("POST", "/api/projects", { name: $("#npName").value, client: $("#npClient").value }); S.project = p; S.tab = "plans"; go("project"); };
  $$(".pcard").forEach(c => c.onclick = async () => { S.project = await api("GET", "/api/projects/" + c.dataset.pid); S.tab = "plans"; go("project"); });
  $$("[data-qc]").forEach(b => b.onclick = () => quickCreate(b.dataset.qc).catch(e => toast(e.message)));
  $("#importP").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const id = await Core.importProject(f); S.project = await api("GET", "/api/projects/" + id); toast("Projet importé."); S.tab = "plans"; go("project"); } catch (err) { toast(err.message); } };
}

/* ---------- projet ---------- */
async function renderProject() {
  if (!S.project) return go("home");
  S.project = await api("GET", "/api/projects/" + S.project.id);
  const p = S.project;
  $("#main").innerHTML = `
    <div class="row between"><div><h1>${p.free ? (plan() && plan().mode === "video" ? "Créer une vidéo" : "Créer une image") : esc(p.name)}</h1><p class="sub">${p.free ? "Création rapide, sans projet · rangée dans « Créations libres » sur cet appareil" : esc(p.client || "Sans client") + " · " + p.plans.length + " plan(s) · enregistré automatiquement sur cet appareil"}</p></div>
    <div class="row"><button type="button" class="btn small" id="exportP">${p.free ? "Exporter mes créations" : "Exporter le projet"}</button>${p.free ? "" : '<button type="button" class="btn small danger" id="delP">Supprimer le projet</button>'}</div></div>
    <div class="tabs" role="tablist">${(p.free ? [["plans", "Mes créations"], ["avis", "Avis des assistants"], ["dossiers", "Dossiers"]] : [["plans", "Plans"], ["brief", "Brief et DA"], ["avis", "Avis des assistants"], ["dossiers", "Dossiers"]]).map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join("")}</div>
    <div id="tabBody" style="display:grid;gap:18px"></div>`;
  $$(".tabs button").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderProject(); setHash(); });
  $("#exportP").onclick = async () => { const b = $("#exportP"); b.disabled = true; b.textContent = "Préparation…"; try { await Core.exportProject(p.id); toast("Export téléchargé : garde ce fichier pour sauvegarder ou ouvrir le projet sur un autre appareil."); } catch (e) { toast(e.message); } b.disabled = false; b.textContent = "Exporter le projet"; };
  if ($("#delP")) $("#delP").onclick = async () => { const b = $("#delP"); if (b.dataset.c !== "1") { b.dataset.c = "1"; b.textContent = "Confirmer : supprimer définitivement"; return; } try { await api("DELETE", "/api/projects/" + p.id); S.project = null; toast("Projet supprimé de cet appareil."); go("home"); } catch (e) { toast(e.message); } };
  if (S.tab === "plans") renderPlans(); else if (S.tab === "brief") renderBrief(); else if (S.tab === "avis") renderAvis(); else renderDossiers();
}
async function patchProject(data) { S.project = await api("PATCH", "/api/projects/" + S.project.id, data); }
async function patchPlan(data) { const pl = plan(); S.project = await api("PATCH", `/api/projects/${S.project.id}/plans/${pl.id}`, data); }
const planUrl = (suffix = "") => `/api/projects/${S.project.id}/plans/${plan().id}${suffix}`;

function thumbOf(p, pl) {
  if (pl.favorite) return { url: media(p, pl.favorite.file), kind: /\.mp4$/i.test(pl.favorite.file) ? "video" : "image" };
  const r = pl.refs.find(x => x.kind === "image"); return r ? { url: media(p, r.file), kind: "image" } : null;
}
function renderSequencer() {
  const p = S.project, act = plan();
  return `<section class="box"><div class="row between"><h2>${p.free ? "Mes créations" : "Séquencier"}</h2><div class="row"><button type="button" class="btn small" id="printBoard">Planche imprimable</button></div></div>
  <div class="seq">${p.plans.map((pl, i) => { const th = thumbOf(p, pl); return `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ""}
    <article class="scard ${pl.id === act.id ? "active" : ""}">
      <button type="button" class="th" data-open-thumb="${pl.id}" aria-label="Voir le média du plan ${esc(pl.code)}">${th ? (th.kind === "video" ? `<video src="${esc(th.url)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(th.url)}" alt="">`) : "Pas de média"}</button>
      <div class="b"><button type="button" class="t" data-open-plan="${pl.id}">${esc(pl.code)} · ${esc(pl.title)}</button>
      <span>${statusChip(pl.state)}</span>
      <div class="mv"><button type="button" class="btn small" data-move="${pl.id}" data-to="${i - 1}" ${i ? "" : "disabled"} aria-label="Avancer">◀</button><button type="button" class="btn small" data-move="${pl.id}" data-to="${i + 1}" ${i < p.plans.length - 1 ? "" : "disabled"} aria-label="Reculer">▶</button></div></div>
    </article>`; }).join("")}
    <button type="button" class="addplan" id="addPlan">${p.free ? "+ Nouvelle création" : "+ Ajouter un plan"}</button></div></section>`;
}
function bindSequencer() {
  const p = S.project;
  $$("[data-open-plan]").forEach(b => b.onclick = async () => { await patchProject({ activePlanId: b.dataset.openPlan }); renderPlans(); setHash(); });
  $$("[data-open-thumb]").forEach(b => b.onclick = () => { const pl = p.plans.find(x => x.id === b.dataset.openThumb); const th = thumbOf(p, pl); if (th) openViewer(th.url, th.kind, `${pl.code} · ${pl.title}`); else toast("Ce plan n'a pas encore de média."); });
  $$("[data-move]").forEach(b => b.onclick = async () => { S.project = await api("POST", `/api/projects/${p.id}/plans/${b.dataset.move}/move`, { to: Number(b.dataset.to) }); renderPlans(); });
  $("#addPlan").onclick = async () => { S.project = await api("POST", `/api/projects/${p.id}/plans`, {}); renderPlans(); setHash(); };
  $("#printBoard").onclick = () => {
    $("#planche").innerHTML = p.plans.map(pl => { const th = thumbOf(p, pl); return `<figure>${th && th.kind === "image" ? `<img src="${esc(th.url)}" alt="">` : "<div style='aspect-ratio:9/16;border:1px solid #999'></div>"}<figcaption>${esc(pl.code)} · ${esc(pl.title)}</figcaption></figure>`; }).join("");
    setTimeout(() => window.print(), 300);
  };
}

function renderPlans() {
  const p = S.project; const pl = plan();
  const body = $("#tabBody");
  if (!pl) { body.innerHTML = renderSequencer(); bindSequencer(); return; }
  const v = pl.versions[pl.versions.length - 1];
  body.innerHTML = renderSequencer() + `
  <section class="step"><header><span class="n">01</span><h2>Nommer le plan</h2><p class="sub">Numéro, titre et objectif visuel en une phrase. Le code de production sert aussi dans les noms de fichiers.</p></header>
    <div class="grid2">
      <label class="f">Code<input type="text" id="f_code" value="${esc(pl.code)}"></label>
      <label class="f">Titre<input type="text" id="f_title" value="${esc(pl.title)}"></label>
      <label class="f">Type de rendu<select id="f_mode"><option value="image" ${pl.mode === "image" ? "selected" : ""}>Image</option><option value="video" ${pl.mode === "video" ? "selected" : ""}>Vidéo</option></select></label>
      <label class="f">Format<select id="f_ratio">${RATIOS.map(r => `<option ${pl.ratio === r ? "selected" : ""}>${r}</option>`).join("")}</select></label>
      ${pl.mode === "video" ? `<label class="f">Durée (s)<input type="number" id="f_seconds" min="2" max="15" value="${pl.seconds}"></label>` : ""}
    </div>
    <label class="f">Objectif visuel<input type="text" id="f_objective" value="${esc(pl.objective)}" placeholder="Ex. donner envie de goûter le boudin en trois secondes"></label>
    <div class="row"><span class="sub">Projet ${esc(p.name)} · plan ${pl.num} · ${v ? "version " + v.n + " du " + fmtDate(v.date) : "pas encore de version validée"}</span>
    <button type="button" class="btn small danger" id="delPlan">Supprimer ce plan</button></div>
  </section>

  <section class="step"><header><span class="n">02</span><h2>Références</h2><p class="sub">Dans l'ordre d'envoi. Chaque fichier reçoit sa mention exacte (@Image1, @Video1…). Touche une vignette pour l'ouvrir en pleine page.</p></header>
    <div class="drop" id="drop">Dépose ici une ou plusieurs photos, vidéos, sons ou documents, ou <label class="btn small" style="display:inline-block">choisis des fichiers<input type="file" id="refInput" multiple hidden></label>
    <div class="sub" style="margin-top:6px">Un dépôt groupé compte comme un seul ajout${pl.summary.status === "validé" ? " et relance automatiquement le comparatif gratuit." : "."}</div></div>
    <div id="upProg" class="sub"></div>
    <div class="refs">${pl.refs.map((r, i) => `
      <div class="ref"><button type="button" class="media" data-view-ref="${r.id}" aria-label="Ouvrir ${esc(r.mention)} en pleine page">${r.kind === "image" ? `<img src="${esc(media(p, r.file))}" alt="">` : r.kind === "video" ? `<video src="${esc(media(p, r.file))}" muted preload="metadata"></video>` : esc(r.kind === "audio" ? "Son" : "Document")}</button>
      <div class="meta"><div class="row between"><span class="mention">${esc(r.mention)}</span>
        <div class="row"><button type="button" class="btn small" data-ref-up="${r.id}" ${i ? "" : "disabled"} aria-label="Monter">↑</button><button type="button" class="btn small" data-ref-down="${r.id}" ${i < pl.refs.length - 1 ? "" : "disabled"} aria-label="Descendre">↓</button><button type="button" class="btn small danger" data-ref-del="${r.id}">Retirer</button></div></div>
        <div class="fname">${esc(r.original)}</div>
        <div class="grid2"><label class="f">Rôle<select data-ref-role="${r.id}">${ROLES.map(x => `<option ${r.role === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label class="f" style="align-content:end"><span><input type="checkbox" data-ref-req="${r.id}" ${r.required ? "checked" : ""}> Pièce obligatoire</span></label></div>
        <label class="f">Ce qui est visible<input type="text" data-ref-desc="${r.id}" value="${esc(r.description)}" placeholder="Ex. le personnage de face, tenue rouge"></label>
      </div></div>`).join("") || '<div class="empty">Aucune référence pour ce plan.</div>'}</div>
  </section>

  <section class="step"><header><span class="n">03</span><h2>Décrire le plan</h2><p class="sub">Écris ou dicte naturellement, puis précise ce qui compte. Pense à distinguer la main droite du personnage et la droite de l'écran.</p></header>
    <label class="f">Ta demande<textarea id="f_description" rows="3" placeholder="Ex. un chien fer de Martinique qui fait du jet-ski">${esc(pl.description)}</textarea></label>
    <div class="mic" id="mic"></div><div class="interim" id="interim"></div>
    <div class="grid2">
      <label class="f">Fonction dans la séquence<input type="text" id="f_func" value="${esc(pl.func)}"></label>
      <label class="f">Action<input type="text" id="f_action" value="${esc(pl.action)}"></label>
      <label class="f">Cadrage<input type="text" id="f_framing" value="${esc(pl.framing)}" placeholder="Ex. plan moyen, contre-plongée légère"></label>
      <label class="f">Position de caméra<input type="text" id="f_camera" value="${esc(pl.camera)}"></label>
      <label class="f">Lumière<input type="text" id="f_light" value="${esc(pl.light)}"></label>
      <label class="f">Contraintes<input type="text" id="f_constraints" value="${esc(pl.constraints)}" placeholder="Accessoires, gestes, sens du mouvement…"></label>
    </div>
  </section>

  <section class="step" id="stepUnderstand"></section>
  <section class="step" id="stepPrompts"></section>
  <section class="step" id="stepCompare"></section>
  <section class="step" id="stepVersions"></section>`;
  bindSequencer(); bindPlanFields(); bindRefs(); renderMic();
  renderUnderstand(); renderPrompts(); renderCompare(); renderVersions();
  maybePoll();
}
function bindPlanFields() {
  const save = debounce(async (k, v) => { try { await patchPlan({ [k]: v }); } catch (e) { toast(e.message); } }, 450);
  for (const k of ["code", "title", "objective", "description", "func", "action", "framing", "camera", "light", "constraints"]) { const el = $("#f_" + k); if (el) el.oninput = () => save(k, el.value); }
  $("#f_mode").onchange = async () => { await patchPlan({ mode: $("#f_mode").value }); renderPlans(); };
  $("#f_ratio").onchange = () => patchPlan({ ratio: $("#f_ratio").value });
  if ($("#f_seconds")) $("#f_seconds").onchange = () => patchPlan({ seconds: Number($("#f_seconds").value) });
  $("#delPlan").onclick = async () => {
    const b = $("#delPlan"); if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirmer la suppression"; return; }
    try { S.project = await api("DELETE", planUrl()); renderPlans(); } catch (e) { toast(e.message); }
  };
}
function bindRefs() {
  const p = S.project, pl = plan();
  const upload = async files => {
    if (!files.length) return;
    const batch = "b" + Date.now(); const prog = $("#upProg");
    for (let i = 0; i < files.length; i++) {
      prog.textContent = `Import ${i + 1} / ${files.length} : ${files[i].name}`;
      await api("POST", planUrl(`/refs?batch=${batch}&name=${encodeURIComponent(files[i].name)}`), undefined, files[i]);
    }
    const r = await api("POST", planUrl("/refs/commit"), { batch });
    S.project = r.project; prog.textContent = "";
    toast(`${r.count} fichier(s) ajouté(s).` + (r.lotId ? " Comparatif gratuit relancé avec ces références." : ""));
    renderPlans();
  };
  $("#refInput").onchange = e => upload([...e.target.files]);
  const drop = $("#drop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files]); };
  $$("[data-view-ref]").forEach(b => b.onclick = () => { const r = pl.refs.find(x => x.id === b.dataset.viewRef); openViewer(media(p, r.file), r.kind, `${r.mention} · ${r.original} · ${r.role}`); });
  const order = async ids => { S.project = await api("POST", planUrl("/refs/order"), { ids }); renderPlans(); };
  $$("[data-ref-up]").forEach(b => b.onclick = () => { const ids = pl.refs.map(r => r.id); const i = ids.indexOf(b.dataset.refUp); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; order(ids); });
  $$("[data-ref-down]").forEach(b => b.onclick = () => { const ids = pl.refs.map(r => r.id); const i = ids.indexOf(b.dataset.refDown); [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; order(ids); });
  $$("[data-ref-del]").forEach(b => b.onclick = async () => { S.project = await api("DELETE", planUrl("/refs/" + b.dataset.refDel)); renderPlans(); });
  const patchRef = debounce(async (id, data) => { S.project = await api("PATCH", planUrl("/refs/" + id), data); }, 400);
  $$("[data-ref-role]").forEach(s => s.onchange = () => patchRef(s.dataset.refRole, { role: s.value }));
  $$("[data-ref-req]").forEach(c => c.onchange = () => patchRef(c.dataset.refReq, { required: c.checked }));
  $$("[data-ref-desc]").forEach(i => i.oninput = () => patchRef(i.dataset.refDesc, { description: i.value }));
}

/* ---------- dictée ---------- */
let rec = null, recState = "off", recBase = "";
function renderMic() {
  const box = $("#mic"); const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { box.innerHTML = `<span class="sub">Dictée vocale indisponible dans ce navigateur. Utilise la touche micro du clavier de ton téléphone, ou écris ta demande.</span>`; return; }
  const ta = $("#f_description");
  box.innerHTML = recState === "off"
    ? `<button type="button" class="btn" id="micStart">🎤 Dicter</button>`
    : `${recState === "on" ? '<span class="rec">Enregistrement</span>' : '<span class="chip warn">En pause</span>'}
       ${recState === "on" ? '<button type="button" class="btn small" id="micPause">Pause</button>' : '<button type="button" class="btn small" id="micResume">Reprendre</button>'}
       <button type="button" class="btn small" id="micStop">Arrêter</button><button type="button" class="btn small" id="micRestart">Recommencer</button>`;
  const start = () => {
    rec = new SR(); rec.lang = "fr-FR"; rec.interimResults = true; rec.continuous = true;
    rec.onresult = e => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { ta.value = (ta.value ? ta.value.trimEnd() + " " : "") + t.trim(); ta.dispatchEvent(new Event("input")); } else interim += t;
      }
      $("#interim").textContent = interim;
    };
    rec.onerror = e => { if (e.error === "not-allowed") toast("Micro refusé : autorise-le dans le navigateur, ou écris ta demande."); else if (e.error !== "no-speech" && e.error !== "aborted") toast("Dictée : " + e.error); };
    rec.onend = () => { if (recState === "on") { try { rec.start(); } catch { recState = "off"; renderMic(); } } };
    rec.start(); recState = "on"; renderMic();
  };
  const halt = st => { recState = st; try { rec && rec.stop(); } catch {} $("#interim").textContent = ""; renderMic(); };
  if ($("#micStart")) $("#micStart").onclick = () => { recBase = ta.value; start(); };
  if ($("#micPause")) $("#micPause").onclick = () => halt("pause");
  if ($("#micResume")) $("#micResume").onclick = () => start();
  if ($("#micStop")) $("#micStop").onclick = () => halt("off");
  if ($("#micRestart")) $("#micRestart").onclick = () => { halt("off"); ta.value = recBase; ta.dispatchEvent(new Event("input")); recBase = ta.value; start(); };
}

/* ---------- 04 vérifier et valider ---------- */
function renderUnderstand() {
  const pl = plan(); const box = $("#stepUnderstand"); const r = pl.research;
  const validated = pl.summary.status === "validé";
  box.innerHTML = `<header><span class="n">04</span><h2>Vérifier et valider la demande</h2><p class="sub">Le studio cherche les termes précis sur Wikipédia, puis te présente sa compréhension. Rien n'est envoyé aux générateurs avant ta validation.</p></header>
    <div class="row"><button type="button" class="btn primary" id="btnUnderstand">${pl.summary.text ? "Relancer la vérification" : "Vérifier et résumer"}</button>
    <label class="sub"><input type="checkbox" id="holdLaunch" ${pl.hold ? "checked" : ""}> Attendre avant de lancer le comparatif</label></div>
    ${r && r.status === "indisponible" ? `<div class="summary" style="background:var(--warn-soft)"><b>Recherche Web indisponible</b><span class="sub">${esc(r.error)}</span>
      <div class="row"><button type="button" class="btn small" id="webRetry">Réessayer</button><button type="button" class="btn small" id="webSkip">Poursuivre avec mes informations</button></div></div>` : ""}
    ${r && r.sources && r.sources.length ? `<div><h3>Sources consultées <span class="sub">(${fmtDate(r.date)} · recherches : ${esc(r.queries.join(" ; "))})</span></h3><ol class="sources">${r.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> — ${esc(s.extract.slice(0, 220))}</li>`).join("")}</ol></div>` : r && r.status === "ok" ? `<p class="sub">Aucune source trouvée pour « ${esc(r.text)} ». Le résumé repose sur ta description.</p>` : ""}
    ${pl.summary.text ? `<div class="summary"><div class="row between"><h3>Ce que le studio a compris</h3>${statusChip(validated ? "validé" : "à valider")}</div>
      <textarea id="sumText" rows="5">${esc(pl.summary.text)}</textarea>
      <span class="sub">Rédigé par ${esc(pl.summary.via || "—")} · tu peux corriger le texte directement.</span>
      <div class="row"><button type="button" class="btn primary" id="btnOk">C'est bien ça</button><button type="button" class="btn" id="btnFix">Corriger</button></div></div>` : ""}`;
  $("#holdLaunch").onchange = () => patchPlan({ hold: $("#holdLaunch").checked });
  const understand = async (skipWeb) => {
    const b = $("#btnUnderstand"); b.disabled = true; b.textContent = "Recherche et résumé en cours… (jusqu'à 1 min sans clé Agnes)";
    try { const d = await api("POST", planUrl("/understand"), { description: $("#f_description").value, skipWeb }); S.project = d.project; if (d.webError) toast("Recherche Web indisponible."); }
    catch (e) { toast(e.message); }
    renderUnderstand();
  };
  $("#btnUnderstand").onclick = () => understand(false);
  if ($("#webRetry")) $("#webRetry").onclick = () => understand(false);
  if ($("#webSkip")) $("#webSkip").onclick = () => understand(true);
  if ($("#btnFix")) $("#btnFix").onclick = () => { const ta = $("#f_description"); ta.focus(); ta.scrollIntoView({ block: "center" }); toast("Corrige ta demande, puis relance la vérification."); };
  if ($("#btnOk")) $("#btnOk").onclick = async () => {
    const b = $("#btnOk"); b.disabled = true; b.textContent = "Rédaction des prompts FR et chinois…";
    try {
      const d = await api("POST", planUrl("/validate"), { summary: $("#sumText").value, hold: $("#holdLaunch").checked });
      S.project = d.project; toast(d.lotId ? "Résumé validé. Prompts prêts, comparatif gratuit lancé." : "Résumé validé. Prompts prêts.");
      renderPlans(); $("#stepCompare").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = "C'est bien ça"; }
  };
}

/* ---------- 05 prompts ---------- */
function renderPrompts() {
  const pl = plan(); const box = $("#stepPrompts");
  const lim = pl.mode === "video" ? 2500 : null;
  const cnt = (t) => `<span class="count ${lim && t.length > lim ? "over" : ""}">${t.length} caractères${lim ? " / " + lim + " (Kling)" : ""}</span>`;
  box.innerHTML = `<header><span class="n">05</span><h2>Prompts français et chinois</h2><p class="sub">Le français sert à la relecture, le chinois à l'envoi. Les deux décrivent le même plan avec les mêmes mentions. ${pl.promptsVia ? "Rédigés par " + esc(pl.promptsVia) + "." : ""}</p></header>
    ${pl.promptFr || pl.promptZh ? `<div class="prompts">
      <label class="f"><span class="row between">Français ${cnt(pl.promptFr)}</span><textarea id="pFr">${esc(pl.promptFr)}</textarea><button type="button" class="btn small" data-copy="pFr">Copier</button></label>
      <label class="f"><span class="row between">中文 · chinois ${cnt(pl.promptZh)}</span><textarea id="pZh">${esc(pl.promptZh)}</textarea><button type="button" class="btn small" data-copy="pZh">Copier</button></label></div>
      <p class="sub">Mentions présentes — FR : ${esc((pl.promptFr.match(/@\w+\d+/g) || []).join(" ") || "aucune")} · ZH : ${esc((pl.promptZh.match(/@\w+\d+/g) || []).join(" ") || "aucune")} · références du plan : ${esc(pl.refs.map(r => r.mention).join(" ") || "aucune")}</p>
      <details class="en"><summary>Adaptation anglaise envoyée aux moteurs qui ne lisent pas le chinois</summary><textarea id="pEn" class="mono" style="margin-top:8px">${esc(pl.promptEn)}</textarea>
      <p class="sub">FLUX, DreamShaper, Juggernaut et les autres modèles libres comprennent mal le chinois et ne reçoivent pas les références : ils lisent cette version.</p></details>
      <div class="row"><button type="button" class="btn" id="saveVersion">Enregistrer comme nouvelle version et relancer le comparatif</button></div>`
    : `<div class="empty">Les prompts apparaîtront après « C'est bien ça » à l'étape 04.</div>`}`;
  $$("[data-copy]").forEach(b => b.onclick = e => { e.preventDefault(); copy($("#" + b.dataset.copy).value, "Prompt copié."); });
  const save = debounce(async () => { await patchPlan({ promptFr: $("#pFr").value, promptZh: $("#pZh").value, promptEn: $("#pEn").value }); }, 500);
  $$("#pFr,#pZh,#pEn").forEach(t => t.oninput = save);
  if ($("#saveVersion")) $("#saveVersion").onclick = async () => {
    await patchPlan({ promptFr: $("#pFr").value, promptZh: $("#pZh").value, promptEn: $("#pEn").value });
    const d = await api("POST", planUrl("/lots"), { newVersion: true, label: "Prompts modifiés" }); S.project = d.project; toast("Nouvelle version enregistrée, comparatif relancé."); renderPlans();
  };
}

/* ---------- 06 comparatif ---------- */
const MANUAL = [
  { kind: "image", name: "ChatGPT (images GPT)", url: "https://chatgpt.com/", lang: "fr", note: "Compte gratuit, quelques images par jour" },
  { kind: "image", name: "Gemini (Nano Banana)", url: "https://gemini.google.com/app", lang: "fr", note: "Compte Google, quota quotidien" },
  { kind: "image", name: "Microsoft Designer / Bing Image Creator", url: "https://www.bing.com/images/create", lang: "en", note: "Compte Microsoft, crédits rapides quotidiens" },
  { kind: "image", name: "Meta AI", url: "https://www.meta.ai/", lang: "en", note: "Compte Meta, disponibilité selon le pays" },
  { kind: "image", name: "Ideogram", url: "https://ideogram.ai/", lang: "en", note: "Crédits gratuits, fort sur le texte dans l'image" },
  { kind: "image", name: "Leonardo", url: "https://app.leonardo.ai/", lang: "en", note: "Jetons gratuits quotidiens" },
  { kind: "video", name: "Google Flow (Veo)", url: "https://labs.google/flow", lang: "en", note: "Offre gratuite en 720p avec filigrane" },
  { kind: "video", name: "Kling", url: "https://klingai.com/", lang: "zh", note: "Crédits gratuits quotidiens" },
  { kind: "video", name: "Hailuo (MiniMax)", url: "https://hailuoai.video/", lang: "zh", note: "Crédits gratuits quotidiens" },
  { kind: "video", name: "PixVerse", url: "https://app.pixverse.ai/", lang: "en", note: "Crédits gratuits quotidiens" },
];
function renderCompare() {
  const p = S.project, pl = plan(); const box = $("#stepCompare");
  const engines = (S.state ? S.state.catalog.engines : []).filter(e => e.kind === pl.mode);
  const lots = pl.lots.slice().reverse();
  box.innerHTML = `<header><span class="n">06</span><h2>Comparatif ${pl.mode === "video" ? "vidéo" : "d'images"} gratuit</h2>
    <p class="sub">${pl.mode === "image" ? "Le lot vise cinq ou six générateurs distincts." : "Le lot lance tous les générateurs vidéo gratuits compatibles."} Les crédits payants ne sont jamais utilisés ici.</p></header>
    <div class="row"><button type="button" class="btn primary" id="launch" ${pl.promptFr || pl.promptZh || pl.promptEn ? "" : "disabled"}>Lancer un nouveau lot</button>
    <span class="sub">Moteurs exclus ou à configurer : voir « Moteurs gratuits ».</span></div>
    ${lots.length ? lots.map(lot => renderLot(p, pl, lot)).join("") : `<div class="engines">${engines.map(e => `<div class="e"><b>${esc(e.name)}</b> ${e.status && e.status.ok && !e.excluded ? '<span class="chip ok">prêt</span>' : `<span class="chip warn">${esc(e.excluded ? "exclu" : e.keyMissing ? "clé à ajouter" : e.notInstalled ? "à installer" : "indisponible")}</span>`}<span class="why">${esc(e.status ? e.status.detail : "")}</span></div>`).join("")}</div>`}`;
  $("#launch").onclick = async () => { try { const d = await api("POST", planUrl("/lots"), {}); S.project = d.project; renderCompare(); maybePoll(); } catch (e) { toast(e.message); } };
  $$("[data-res]").forEach(b => b.onclick = () => { const [lid, tid] = b.dataset.res.split(":"); const t = pl.lots.find(l => l.id === lid).tasks.find(x => x.id === tid); openViewer(media(p, t.file), /\.mp4$/i.test(t.file) ? "video" : "image", `${t.engineName} · ${t.model}`); });
  $$("[data-choose]").forEach(b => b.onclick = () => openChoose(...b.dataset.choose.split(":")));
  $$("[data-cancel]").forEach(b => b.onclick = async () => { const [, tid] = b.dataset.cancel.split(":"); S.project = await api("POST", planUrl("/tasks/" + tid + "/cancel")); renderCompare(); });
}
function renderLot(p, pl, lot) {
  const ok = lot.engines.filter(e => e.eligible).length;
  const ar = pl.ratio.replace(":", "/");
  return `<div class="lot"><header><h3>Lot ${lot.n} · version ${lot.version} · ${fmtDate(lot.created)}</h3>
    <span class="chip ${lot.target && ok < lot.target ? "warn" : "ok"}">${lot.target ? `${ok} sur ${lot.target} disponibles` : `${ok} moteur(s) lancé(s)`}</span></header>
    ${lot.engines.some(e => !e.eligible) ? `<details><summary class="sub">Moteurs non lancés et motif</summary><ul class="sub">${lot.engines.filter(e => !e.eligible).map(e => `<li><b>${esc(e.name)}</b> : ${esc(e.reason)}</li>`).join("")}</ul></details>` : ""}
    <div class="results">${lot.tasks.map(t => `
      <article class="rcard ${lot.favoriteTaskId === t.id ? "fav" : ""}" style="--ar:${ar}">
        ${t.file ? `<button type="button" class="media" data-res="${lot.id}:${t.id}" aria-label="Ouvrir en pleine page">${/\.mp4$/i.test(t.file) ? `<video src="${esc(media(p, t.file))}" muted playsinline preload="metadata"></video>` : `<img src="${esc(media(p, t.file))}" alt="Résultat ${esc(t.engineName)}" loading="lazy">`}</button>`
          : `<div class="media"><div class="wait">${t.status === "en cours" || t.status === "en attente" ? '<div class="bar"><i></i></div>' : ""}<span>${esc(t.note || t.status)}</span>${t.error ? `<span class="err">${esc(t.error)}</span>` : ""}</div></div>`}
        <div class="b"><div class="row between"><span class="name">${esc(t.engineName)}</span>${statusChip(t.status)}</div>
          <span class="sub">${esc(t.model)}${t.started && t.ended && t.file ? " · " + Math.round((new Date(t.ended) - new Date(t.started)) / 1000) + " s" : ""}</span>
          <details><summary>Texte et réglages envoyés</summary><pre>${esc(`Langue : ${t.sent.lang}\nRéférences : ${t.sent.refs.join(", ") || "aucune"}\nRéglages : ${JSON.stringify(t.sent.params)}\n\n${t.sent.prompt}`)}</pre></details>
          <div class="row">${t.file ? `<button type="button" class="btn small primary" data-choose="${lot.id}:${t.id}">${lot.favoriteTaskId === t.id ? "Choisi ✓" : "Choisir ce résultat"}</button>` : ""}
          ${t.status === "en cours" || t.status === "en attente" ? `<button type="button" class="btn small" data-cancel="${lot.id}:${t.id}">Annuler</button>` : ""}</div></div>
      </article>`).join("")}</div></div>`;
}
function openChoose(lotId, taskId) {
  const p = S.project, pl = plan(); const t = pl.lots.find(l => l.id === lotId).tasks.find(x => x.id === taskId);
  const dlg = $("#chooseDlg");
  const others = (S.state ? S.state.projects : []).filter(x => !x.free && x.id !== p.id);
  $("#chProject").innerHTML = (p.free ? "" : `<option value="${p.id}">Ce projet (${esc(p.name)})</option>`) + others.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("") + `<option value="__new">Nouveau projet…</option>`;
  const sync = async () => {
    const v = $("#chProject").value; $("#chNewProjWrap").hidden = v !== "__new";
    let folders = ["Sélection"]; if (v === p.id) folders = p.folders; else if (v !== "__new") { try { folders = (await api("GET", "/api/projects/" + v)).folders; } catch {} }
    $("#chFolderList").innerHTML = folders.map(f => `<option value="${esc(f)}">`).join("");
  };
  $("#chProject").onchange = sync; sync();
  $("#chFolder").checked = !!p.free && false;
  dlg.returnValue = ""; dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    const toProj = $("#chFolder").checked; const pv = $("#chProject").value; const folder = $("#chFolderName").value.trim() || "Sélection";
    try {
      const d = await api("POST", planUrl("/choose"), { lotId, taskId, favorite: $("#chPlan").checked, folder: toProj ? folder : null,
        project: toProj && pv !== "__new" ? pv : null, newProject: toProj && pv === "__new" ? ($("#chNewProj").value.trim() || "Nouveau projet") : null });
      S.project = d.project; await loadState();
      const parts = [];
      if (d.done.includes("plan")) parts.push("gardé comme choix de " + pl.code);
      if (d.done.includes("dossier")) parts.push("classé dans « " + folder + " »");
      if (d.done.includes("projet")) parts.push("ajouté au projet « " + d.targetName + " », dossier « " + folder + " »");
      if ($("#chDevice").checked) { await Core.download(p.id, t.file); parts.push("téléchargement lancé"); }
      toast(parts.length ? "Enregistré : " + parts.join(", ") + "." : "Rien n'a été coché.");
      renderPlans();
    } catch (e) { toast("Échec de l'enregistrement : " + e.message); }
  };
}
function renderVersions() {
  const pl = plan(); const box = $("#stepVersions");
  box.innerHTML = `<header><h2>Versions du plan</h2><p class="sub">Chaque validation ou correction crée une version avec son résumé, ses prompts et ses références ordonnées.</p></header>
    ${pl.versions.length ? `<div class="engines">${pl.versions.slice().reverse().map(v => `<div class="e"><b>Version ${v.n}</b> <span class="sub">${fmtDate(v.date)} · ${esc(v.label)} · ${v.refs.length} référence(s)</span>
      <button type="button" class="btn small" data-restore="${v.n}">Reprendre ces textes</button></div>`).join("")}</div>` : '<div class="empty">Pas encore de version.</div>'}`;
  $$("[data-restore]").forEach(b => b.onclick = async () => { S.project = await api("POST", planUrl("/restore"), { n: Number(b.dataset.restore) }); toast("Textes de la version " + b.dataset.restore + " repris. Relance la vérification ou le comparatif."); renderPlans(); });
}
function maybePoll() {
  stopPoll();
  const pl = plan(); if (!pl) return;
  if (!pl.lots.some(l => l.tasks.some(t => t.status === "en cours" || t.status === "en attente"))) return;
  S.poll = setInterval(async () => {
    if (S.view !== "project" || S.tab !== "plans") return stopPoll();
    try {
      S.project = await api("GET", "/api/projects/" + S.project.id);
      renderCompare();
      const p2 = plan(); if (!p2.lots.some(l => l.tasks.some(t => t.status === "en cours" || t.status === "en attente"))) { stopPoll(); renderPlans(); }
    } catch {}
  }, 2500);
}
function stopPoll() { if (S.poll) clearInterval(S.poll); S.poll = null; }

/* ---------- brief ---------- */
function renderBrief() {
  const b = S.project.brief || {};
  const F = [["client", "Client"], ["produit", "Produit exact"], ["objectif", "Objectif"], ["public", "Public"], ["canal", "Canal"], ["langue", "Langue"], ["livrables", "Livrables (Reel vertical, story, version horizontale…)"], ["textes", "Textes obligatoires"], ["prix", "Prix, offre et appel à l'action"], ["dates", "Dates"]];
  $("#tabBody").innerHTML = `<section class="box"><h2>01 · La commande</h2><p class="sub">Chaque champ est facultatif. Une information commerciale manquante reste simplement vide.</p>
    <div class="grid2">${F.map(([k, l]) => `<label class="f">${l}<input type="text" data-brief="${k}" value="${esc(b[k])}"></label>`).join("")}</div></section>
    <section class="box"><h2>02 · Concept retenu</h2><textarea data-brief="concept" rows="4" placeholder="Accroche, déroulé, chute, rôle du produit">${esc(b.concept)}</textarea></section>
    <section class="box"><h2>03 · Direction artistique</h2><textarea data-brief="da" rows="4" placeholder="Palette, lumière, lieux, matières, stylisme, présentation du produit, cadrages, mouvements de caméra">${esc(b.da)}</textarea>
    <label class="f">Direction sonore<textarea data-brief="son" rows="2" placeholder="Voix, musique, intentions de montage">${esc(b.son)}</textarea></label></section>
    <p class="sub">Le produit, la DA et le concept sont repris automatiquement dans le résumé et les prompts de chaque plan.</p>`;
  const save = debounce(async (k, v) => { await patchProject({ brief: { [k]: v } }); }, 500);
  $$("[data-brief]").forEach(el => el.oninput = () => save(el.dataset.brief, el.value));
}

/* ---------- avis ---------- */
function renderAvis() {
  const p = S.project;
  $("#tabBody").innerHTML = `<section class="box"><h2>Demander un avis à Claude ou ChatGPT</h2>
    <p class="sub">Mode manuel : le studio prépare le dossier du plan, tu le colles dans ton compte, puis tu reviens coller la réponse ici. Chaque avis garde son auteur et son plan.</p>
    <div class="grid2"><label class="f">Plan concerné<select id="avPlan">${p.plans.map(pl => `<option value="${pl.id}" ${pl.id === p.activePlanId ? "selected" : ""}>${esc(pl.code)} · ${esc(pl.title)}</option>`).join("")}</select></label></div>
    <label class="f">Ta question<textarea id="avQ" rows="2" placeholder="Ex. Cette accroche donne-t-elle envie de goûter en trois secondes ?"></textarea></label>
    <div class="row"><button type="button" class="btn primary" id="avCopy">Copier le dossier et la question</button><span class="sub" id="avPieces"></span></div>
    <div class="grid2"><label class="f">Réponse de<select id="avAuthor"><option>Claude</option><option>ChatGPT</option><option>Autre</option></select></label></div>
    <label class="f">Colle la réponse<textarea id="avA" rows="5"></textarea></label>
    <div class="row"><button type="button" class="btn" id="avSave">Enregistrer l'avis</button></div></section>
    <section class="box"><h2>Avis enregistrés</h2>${p.avis.length ? p.avis.map(a => { const pl = p.plans.find(x => x.id === a.planId); return `<article class="box" style="background:var(--bg)">
      <div class="row between"><b>${esc(a.author)} · ${esc(pl ? pl.code + " " + pl.title : "projet")}</b><span class="sub">${fmtDate(a.date)}</span></div>
      ${a.question ? `<p class="sub"><b>Question :</b> ${esc(a.question)}</p>` : ""}<div style="white-space:pre-wrap">${esc(a.answer)}</div>
      <div class="row"><button type="button" class="btn small ${a.kept ? "primary" : ""}" data-keep="${a.id}">${a.kept ? "Suggestion retenue ✓" : "Retenir cette suggestion"}</button><button type="button" class="btn small danger" data-avdel="${a.id}">Supprimer</button></div></article>`; }).join("") : '<div class="empty">Aucun avis.</div>'}</section>`;
  $("#avCopy").onclick = async () => {
    const plid = $("#avPlan").value; const d = await api("GET", `/api/projects/${p.id}/plans/${plid}/dossier`);
    const pl = p.plans.find(x => x.id === plid);
    $("#avPieces").textContent = pl.refs.length ? "Joins dans le chat : " + pl.refs.map(r => `${r.mention} (${r.original})`).join(", ") : "Aucune pièce à joindre.";
    copy(d.text + "\n\nQUESTION : " + $("#avQ").value, "Dossier copié : colle-le dans Claude ou ChatGPT.");
  };
  $("#avSave").onclick = async () => { if (!$("#avA").value.trim()) return toast("Colle d'abord la réponse."); S.project = await api("POST", `/api/projects/${p.id}/avis`, { planId: $("#avPlan").value, author: $("#avAuthor").value, question: $("#avQ").value, answer: $("#avA").value }); renderAvis(); toast("Avis enregistré."); };
  $$("[data-keep]").forEach(b => b.onclick = async () => { const a = p.avis.find(x => x.id === b.dataset.keep); S.project = await api("PATCH", `/api/projects/${p.id}/avis/${a.id}`, { kept: !a.kept }); renderAvis(); });
  $$("[data-avdel]").forEach(b => b.onclick = async () => { S.project = await api("DELETE", `/api/projects/${p.id}/avis/${b.dataset.avdel}`); renderAvis(); });
}

/* ---------- dossiers ---------- */
function renderDossiers() {
  const p = S.project;
  $("#tabBody").innerHTML = p.folders.map(f => { const items = p.assets.filter(a => a.folder === f); return `<section class="box"><div class="row between"><h2>${esc(f)}</h2><span class="sub">${items.length} création(s)</span></div>
    ${items.length ? `<div class="results">${items.map(a => `<article class="rcard"><button type="button" class="media" data-asset="${a.id}">${/\.mp4$/i.test(a.file) ? `<video src="${esc(media(p, a.file))}" muted preload="metadata"></video>` : `<img src="${esc(media(p, a.file))}" alt="" loading="lazy">`}</button>
      <div class="b"><span class="name">${esc(a.plan)} · ${esc(a.engine)}</span><span class="sub">${fmtDate(a.date)}${a.validated ? " · choix validé" : ""}</span><button type="button" class="btn small" data-dl="${esc(a.file)}">Télécharger</button></div></article>`).join("")}</div>` : '<div class="empty">Vide.</div>'}</section>`; }).join("");
  $$("[data-dl]").forEach(b => b.onclick = () => Core.download(p.id, b.dataset.dl).catch(e => toast(e.message)));
  $$("[data-asset]").forEach(b => b.onclick = () => { const a = p.assets.find(x => x.id === b.dataset.asset); openViewer(media(p, a.file), /\.mp4$/i.test(a.file) ? "video" : "image", `${a.folder} · ${a.plan} · ${a.engine}`); });
}

/* ---------- catalogue ---------- */
async function renderCatalog() {
  await loadState(); const c = S.state.catalog;
  const stateOf = e => e.excluded ? ["exclu", ""] : e.keyMissing ? ["clé à ajouter", "warn"] : e.notInstalled ? ["à installer", "warn"] : !e.status ? ["à vérifier", "warn"] : e.status.ok ? ["disponible", "ok"] : e.status.networkError ? ["contrôle impossible", "warn"] : ["indisponible", "bad"];
  $("#main").innerHTML = `<div class="row between"><div><h1>Moteurs gratuits</h1><p class="sub">Dernier contrôle : ${fmtDate(c.checkedAt)}. Contrôle automatique à l'ouverture puis toutes les 30 minutes.</p></div>
    <button type="button" class="btn primary" id="catRefresh">Rechercher maintenant</button></div>
    ${["image", "video"].map(k => `<h2>${k === "image" ? "Images" : "Vidéo"}</h2><div class="cat">${c.engines.filter(e => e.kind === k).map(e => { const [l, cls] = stateOf(e); return `<article class="box">
      <div class="row between"><h3>${esc(e.name)}</h3><span class="chip ${cls}">${l}</span></div>
      <p class="sub">${esc(e.status ? e.status.detail : "")}${e.status && e.status.checkedAt ? " · " + fmtDate(e.status.checkedAt) : ""}</p>
      <dl><dt>Fournisseur</dt><dd>${esc(e.provider)}</dd><dt>Modèle</dt><dd>${esc(e.model)}</dd><dt>Accès</dt><dd>${esc(e.access)}</dd><dt>Quota</dt><dd>${esc(e.quota)}</dd><dt>Entrées</dt><dd>${esc(e.inputs)}</dd><dt>Langue lue</dt><dd>${e.lang === "zh" ? "chinois" : "anglais (adaptation)"}</dd><dt>Limites</dt><dd>${esc(e.limits)}</dd><dt>Usage commercial</dt><dd>${esc(e.commercial)}</dd><dt>Source</dt><dd><a href="${esc(e.source)}" target="_blank" rel="noopener">documentation officielle</a></dd></dl>
      <label class="sub"><input type="checkbox" data-excl="${e.id}" ${e.excluded ? "checked" : ""}> Exclure du comparatif</label></article>`; }).join("")}</div>`).join("")}
    <section class="box"><h2>Changements détectés</h2>${c.history.length ? `<ul class="sub">${c.history.map(h => `<li>${fmtDate(h.at)} · ${esc(h.engine)} : ${esc(h.change)}</li>`).join("")}</ul>` : '<p class="sub">Aucun changement depuis l\'installation.</p>'}</section>`;
  $("#catRefresh").onclick = async () => { const b = $("#catRefresh"); b.disabled = true; b.textContent = "Contrôle en cours…"; await api("POST", "/api/catalog/refresh"); renderCatalog(); toast("Catalogue actualisé."); };
  $$("[data-excl]").forEach(cb => cb.onchange = async () => { const ex = $$("[data-excl]").filter(x => x.checked).map(x => x.dataset.excl); await api("POST", "/api/settings", { excluded: ex }); });
}

/* ---------- réglages ---------- */
async function renderSettings() {
  await loadState(); const k = S.state.keys;
  $("#main").innerHTML = `<h1>Réglages</h1>
    <section class="box"><h2>Clés gratuites</h2><p class="sub">Les clés restent sur cet appareil (téléphone ou PC) et ne partent que vers le service concerné. Saisis-les sur chaque appareil utilisé. Laisse un champ vide pour garder la clé actuelle.</p>
      <label class="f">Clé Agnes AI ${k.agnes ? `<span class="h">enregistrée (${esc(k.agnes)})</span>` : '<span class="h">ajoute Agnes Image et Agnes Video au comparatif, et accélère les résumés</span>'}<input type="password" id="kAgnes" autocomplete="off" placeholder="sk-…"></label>
      <p class="sub">Obtenir la clé : <a href="https://platform.agnes-ai.com/" target="_blank" rel="noopener">platform.agnes-ai.com</a> → API Keys → Create.</p>
      <label class="f">Jeton Hugging Face ${k.hf ? `<span class="h">enregistré (${esc(k.hf)})</span>` : '<span class="h">facultatif : augmente le quota GPU gratuit de FLUX</span>'}<input type="password" id="kHf" autocomplete="off" placeholder="hf_…"></label>
      <label class="f">Clé AI Horde ${k.horde ? `<span class="h">enregistrée (${esc(k.horde)})</span>` : '<span class="h">facultatif : compte gratuit = images plus grandes et file plus rapide</span>'}<input type="password" id="kHorde" autocomplete="off"></label>
      <div class="row"><button type="button" class="btn primary" id="saveKeys">Enregistrer</button></div></section>
    <section class="box"><h2>Lancement automatique</h2><label class="opt"><input type="checkbox" id="autoL" ${S.state.autoLaunch ? "checked" : ""}> <span>Lancer le comparatif gratuit dès la validation du résumé et à chaque dépôt de références sur un plan validé</span></label></section>`;
  $("#saveKeys").onclick = async () => {
    const keys = {}; if ($("#kAgnes").value.trim()) keys.agnes = $("#kAgnes").value; if ($("#kHf").value.trim()) keys.hf = $("#kHf").value; if ($("#kHorde").value.trim()) keys.horde = $("#kHorde").value;
    await api("POST", "/api/settings", { keys }); toast("Clés enregistrées. Le catalogue se met à jour."); renderSettings();
  };
  $("#autoL").onchange = () => api("POST", "/api/settings", { autoLaunch: $("#autoL").checked });
}

/* ---------- mode d'emploi ---------- */
function renderGuide() {
  $("#main").innerHTML = `<article class="guide"><h1>Mode d'emploi</h1>
  <h2>Démarrer</h2><p>Le studio est une application web : il fonctionne dans Chrome sur le téléphone comme sur l'ordinateur, <b>PC éteint compris</b>. Adresse : <a href="https://nicoqs97220.github.io/studio-360fwi/" target="_blank" rel="noopener">nicoqs97220.github.io/studio-360fwi</a>. Sur le PC, le raccourci <b>Studio 360FWI</b> du Bureau l'ouvre directement.</p>
  <p><b>Sur iPhone :</b> ouvre l'adresse dans Safari, touche Partager puis « Sur l'écran d'accueil ». <b>Sur Android :</b> dans Chrome, menu ⋮ puis « Installer l'application ». Le studio s'ouvre alors comme une application.</p>
  <p><b>Important :</b> tes projets, rendus et clés sont enregistrés <b>dans l'appareil</b> utilisé. Pour passer un projet du téléphone au PC (ou l'inverse), utilise « Exporter le projet » puis « Importer un projet exporté ». Une génération en cours continue tant que la page reste ouverte ; si tu fermes l'application, elle reprend à la réouverture.</p>
  <h2>Créer une image, pas à pas</h2><ol>
  <li><b>Projets</b> → crée un projet. Un premier plan est prêt.</li>
  <li><b>01</b> Donne un titre et un objectif. Choisis image ou vidéo et le format (9:16 par défaut).</li>
  <li><b>02</b> Dépose tes références. Chacune reçoit sa mention (@Image1, @Image2…). Indique son rôle, ce qu'elle montre, et coche « obligatoire » si un moteur doit absolument la recevoir. Touche une vignette pour la voir en pleine page, la croix × ou Échap referme.</li>
  <li><b>03</b> Écris ou dicte ta demande avec 🎤, puis précise cadrage, lumière, contraintes.</li>
  <li><b>04</b> « Vérifier et résumer » : le studio cherche les termes sur Wikipédia et te montre sa compréhension avec les sources. Corrige si besoin, puis « C'est bien ça ».</li>
  <li><b>05</b> Les prompts français et chinois apparaissent. Tu peux les modifier : « Enregistrer comme nouvelle version » relance le comparatif.</li>
  <li><b>06</b> Le comparatif part tout seul : une carte par moteur gratuit, les images arrivent au fil de l'eau. « Choisir ce résultat » te demande où l'enregistrer.</li></ol>
  <h2>Moteurs gratuits</h2><p>Sans aucune clé : Pollinations, AI Horde (DreamShaper, Juggernaut XL, AlbedoBase XL) et FLUX.1 schnell sur Hugging Face. Avec une clé Agnes gratuite : Agnes Image et Agnes Video en plus. La page « Moteurs gratuits » montre l'état, les quotas et les conditions de chacun, avec la date du contrôle.</p>
  <h2>Le chinois et les autres moteurs</h2><p>Le prompt chinois validé part vers les moteurs qui le lisent (Agnes, puis Higgsfield plus tard). Les modèles libres (FLUX, DreamShaper…) lisent mal le chinois et ne reçoivent pas les références : ils reçoivent l'adaptation anglaise, visible dans l'étape 05 et dans « Texte et réglages envoyés » de chaque carte.</p>
  <h2>Sauvegarde</h2><p>Dans chaque projet, « Exporter le projet » télécharge un fichier qui contient tout : brief, plans, versions, prompts, références et rendus. Range ces fichiers dans un dossier de sauvegarde (par exemple <code>D:\\Studio360FWI\\Sauvegardes</code> ou ton cloud). Pour restaurer, « Importer un projet exporté » sur la page Projets.</p>
  <h2>Ce qui viendra ensuite</h2><p>Synchronisation automatique PC ↔ téléphone, workflow vidéo complet avec timeline, dossier de rushs et montage MP4, liaison Higgsfield avec devis et confirmation.</p></article>`;
}

/* ---------- démarrage ---------- */
(async function init() {
  try { await Core.init(); await loadState(); } catch (e) { $("#main").innerHTML = `<div class="empty">Le stockage de cet appareil est inaccessible (navigation privée ?). Ouvre le studio dans une fenêtre normale.<br><span class="sub">${esc(e.message)}</span></div>`; return; }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("p")) {
    try { S.project = await api("GET", "/api/projects/" + h.get("p")); if (h.get("pl")) S.project.activePlanId = h.get("pl"); S.tab = h.get("t") || "plans"; return go("project"); } catch {}
  }
  go(h.get("v") || "home");
})();
