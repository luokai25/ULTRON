import "./products.css";
import { blocksToHtml } from "./blocks";
import { bookTitle, brandOf, disclaimerOf, imageLookup, sectionLabel } from "./book";
import { fetchPage, generateIllustration, isPublicHttpUrl, research } from "./browser";
import { deepResearch } from "./deep-research";
import { promptCondense, SYSTEM_WRITER } from "./prompts";
import { clear, ago, el, shareBlob } from "./dom";
import { browserParse } from "../web/page";
import { approveOutline, buildSummary, expandToTarget, buildVtm, designBranding, buildStore, discoverPockets, generateOutlines, newProduct, planChapters, qualityReport, refineVtm, renderImages, reviseOutline, writeManuscript, type EngineEnv, type Progress } from "./engine";
import { exportProduct, FONT_URLS, FORMAT_INFO, measurePdfPages, renderExport, type ExportFormat } from "./export-runtime";
import { createHttp } from "./http";
import { createCompleter, describeChoice, listModelOptions, NO_MODEL_MESSAGE, type LocalRoute, type ModelChoice, type ModelOptionList } from "./models";
import { cardOf, deleteProduct, listProducts, loadProduct, saveProduct } from "./store";
import { cachedTrendIdeas, refreshTrendIdeas } from "./trending";
import { BOOK_FORMATS, DEPTH_SPEC, type BookFormat, type Depth, type Product } from "./types";
import { scoreTone } from "./scoring";

export type ProductsHost = {
  local: LocalRoute;
  openKeys: () => void;
  openLocalModels: () => void;
  onClose: () => void;
  /** Test seam: replaces the real model router and the public-web transport. Not used by the app. */
  testing?: { completer?: (choice: ModelChoice) => { complete: import("./engine").Completer; concurrency: number }; http?: import("./browser").Http };
};

type View = "home" | "working" | "pockets" | "format" | "outline" | "customise" | "vtm" | "structure" | "plan" | "manuscript" | "product" | "projects";

const MODEL_KEY = "ultron.products.model.v1";
const loadChoice = (): ModelChoice => { try { const v = JSON.parse(localStorage.getItem(MODEL_KEY) ?? "null") as ModelChoice | null; if (v && (v.kind === "auto" || v.kind === "local" || (v.kind === "cloud" && v.id))) return v; } catch { /* default */ } return { kind: "auto" }; };

export function mountProducts(root: HTMLElement, host: ProductsHost): { open: (options?: { topic?: string; autostart?: boolean }) => void; resume: (id: string) => Promise<void> } {
  const http = host.testing?.http ?? createHttp();
  if (!document.getElementById("pb-fonts")) {
    // The reader uses the same bundled fonts as the PDF, so the on-screen book matches the exported one.
    document.head.append(el("style", { id: "pb-fonts" }));
    const face = (family: string, url: string, weight: number): string => `@font-face{font-family:"${family}";src:url("${url}") format("truetype");font-weight:${weight};font-display:swap}`;
    (document.getElementById("pb-fonts") as HTMLStyleElement).textContent = face("Merriweather", FONT_URLS.merriweatherBold, 700) + face("Open Sans", FONT_URLS.openSans, 400) + face("Open Sans", FONT_URLS.openSansBold, 700);
  }
  let choice = loadChoice();
  let product: Product | null = null;
  let view: View = "home";
  let abort: AbortController | null = null;
  let options: ModelOptionList | null = null;
  let mode: "guided" | "creator" = "guided";
  let draft = { topic: "", handle: "", notes: "", consent: false, web: true, research: "standard" as "light" | "standard" | "deep" };
  let outlineTab = 0;
  let readTab: "read" | "export" | "store" | "charter" = "read";
  let liveText = "";
  let liveNode: HTMLElement | null = null;
  let error = "";

  const head = el("header", { class: "feature-head pb-head" });
  const body = el("div", { class: "pb-body" });
  const sheet = el("div", { class: "pb-sheet-wrap", hidden: true });
  root.append(head, body, sheet);

  // ---------- engine environment ----------
  const modelReady = (): boolean => choice.kind === "local" ? host.local.ready() : choice.kind === "cloud" ? true : Boolean(options && (options.cloud.length > 0 || options.localReady));
  const makeEnv = (needImages = false): EngineEnv => {
    const { complete, concurrency } = host.testing?.completer?.(choice) ?? createCompleter(choice, host.local);
    return {
      complete, concurrency, signal: abort?.signal, persist: async (p) => { await saveProduct(p); },
      progress: onProgress, stream: (_id, text) => { liveText = text; if (liveNode) liveNode.textContent = text.slice(-900); },
      image: needImages ? (prompt, mood, signal) => generateIllustration(http, prompt, mood, signal).catch(() => null) : undefined,
    };
  };

  // ---------- chrome ----------
  function renderHead(): void {
    clear(head);
    const back = el("button", { class: "icon-btn", type: "button", "aria-label": view === "home" ? "Back to chat" : "Back", text: "‹", onclick: () => { if (busy()) return; goBack(); } });
    const heading = view === "projects" ? "Projects" : view === "home" || !product ? "Offer Builder" : (product.summary?.title || (product.outlineId ? product.title : "") || product.topic.slice(0, 40) || "New eBook");
    const titleBlock = el("div", {}, el("span", { class: "feature-eyebrow", text: "AI DIGITAL PRODUCTS" }), el("h1", { text: heading }),
      view === "home" ? el("p", { text: "From a rough idea to a finished eBook you can sell, built on your phone." }) : null);
    const model = el("button", { class: "chat-model-button pb-model", type: "button", onclick: () => void openModelSheet() }, el("i", { class: "chat-model-indicator" }), el("span", { text: describeChoice(choice) }));
    head.append(el("div", { class: "pb-head-left" }, back, titleBlock), el("div", { class: "pb-head-right" }, model));
  }
  const goBack = (): void => {
    const order: View[] = ["home", "pockets", "format", "outline", "customise", "vtm", "structure", "plan", "manuscript", "product"];
    if (view === "home" || view === "projects") { host.onClose(); return; }
    if (view === "product") { show("projects"); return; }
    const i = order.indexOf(view);
    show(i > 1 && view !== "manuscript" ? (order[i - 1] as View) : "home");
  };
  const busy = (): boolean => view === "working";

  function tabs(): HTMLElement {
    return el("div", { class: "pb-tabs", role: "tablist" },
      el("button", { class: "pb-tab", type: "button", role: "tab", "aria-selected": view !== "projects", text: "Create", onclick: () => { if (!busy()) show(product && view !== "home" ? view : "home"); } }),
      el("button", { class: "pb-tab", type: "button", role: "tab", "aria-selected": view === "projects", text: "Projects", onclick: () => { if (!busy()) show("projects"); } }));
  }

  function show(next: View): void {
    view = next; error = "";
    renderHead(); clear(body);
    if (next === "working") return;
    body.append(tabs());
    const content = el("div", { class: "pb-content", "data-view": next });
    body.append(content);
    const draw: Record<View, (c: HTMLElement) => void> = { home: drawHome, working: () => undefined, pockets: drawPockets, format: drawFormat, outline: drawOutline, customise: drawCustomise, vtm: drawVtm, structure: drawStructure, plan: drawPlan, manuscript: drawManuscript, product: drawProduct, projects: drawProjects };
    draw[next](content);
    body.scrollTop = 0; root.scrollTop = 0;
  }

  // ---------- long-running work ----------
  const steps = new Map<string, { label: string; value: number; total: number }>();
  let workTitle = ""; let workNote = ""; let workNode: HTMLElement | null = null;
  function onProgress(p: Progress): void {
    if (p.phase === "note") workNote = p.label;
    else if (p.phase === "section") { steps.set("manuscript", { label: `Writing · wave ${p.wave} of ${p.waves}`, value: product?.sections.filter((s) => s.status === "done").length ?? 0, total: p.total }); workNote = `${p.words.toLocaleString()} words written`; if (view === "working") paintManuscriptList(); }
    else if (p.phase === "pages") { steps.set("pages", { label: `Measuring the PDF${p.round ? ` · round ${p.round}` : ""}`, value: p.pages, total: p.target }); workNote = `${p.pages} of ${p.target} pages`; }
    else { steps.set(p.phase, { label: p.label, value: p.done, total: p.total }); workNote = p.label; }
    paintWork();
  }
  function paintWork(): void {
    if (!workNode) return;
    clear(workNode);
    workNode.append(el("h2", { text: workTitle }), el("p", { class: "pb-note", role: "status", "aria-live": "polite", text: steps.size && !/^(Searching|Reading|Designing|Generating|Writing the)/.test(workNote) ? "This takes a minute. You can stop at any time; progress is saved." : workNote || "Starting…" }));
    for (const [, s] of steps) workNode.append(el("div", { class: "pb-step" }, el("div", { class: "pb-step-row" }, el("span", { text: s.label }), el("span", { class: "pb-mono", text: s.total ? `${Math.min(s.value, s.total)}/${s.total}` : "" })), el("div", { class: "pb-bar" }, el("i", { style: `width:${s.total ? Math.min(100, (s.value / s.total) * 100) : 8}%` }))));
    if (product?.sections.length && (workTitle.includes("Writing"))) { workNode.append(el("div", { class: "pb-secs", id: "pb-seclist" }), el("pre", { class: "pb-live", "aria-label": "Live draft" })); paintManuscriptList(); liveNode = workNode.querySelector(".pb-live"); if (liveNode) liveNode.textContent = liveText.slice(-900); }
    workNode.append(el("button", { class: "pb-btn ghost", type: "button", text: "Stop", onclick: () => abort?.abort() }));
  }
  function paintManuscriptList(): void {
    const list = body.querySelector("#pb-seclist"); if (!list || !product) return;
    clear(list);
    for (const s of product.sections) list.append(el("div", { class: `pb-sec ${s.status}` }, el("i"), el("span", { text: s.title }), el("em", { text: s.status === "done" ? `${s.words}w` : s.status === "error" ? "retry" : s.status === "writing" ? "writing" : "" })));
  }

  async function run(title: string, after: View, work: () => Promise<void>, fallbackView?: View): Promise<void> {
    if (busy()) return;
    if (!modelReady() && !(await refreshOptions())) { error = NO_MODEL_MESSAGE; show(fallbackView ?? (view === "working" ? "home" : view)); return; }
    abort = new AbortController(); steps.clear(); workTitle = title; workNote = ""; liveText = "";
    const prior = view;
    show("working");
    workNode = el("div", { class: "pb-work" }); body.append(workNode); paintWork();
    try { await work(); abort = null; workNode = null; liveNode = null; show(after); }
    catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      abort = null; workNode = null; liveNode = null;
      if (product) await saveProduct(product).catch(() => undefined);
      const resumable: View = product && product.stage === "manuscript" && product.sections.length ? "plan" : (fallbackView ?? (prior === "working" ? "home" : prior));
      show(resumable);
      error = aborted ? "Stopped. Everything finished so far is saved." : e instanceof Error ? e.message : "Something went wrong.";
      showError();
    }
  }
  function showError(): void {
    const c = body.querySelector(".pb-content"); if (!c || !error) return;
    c.prepend(el("div", { class: "pb-error", role: "alert" }, el("span", { text: error }), /No model is ready/.test(error) ? el("span", { class: "pb-row" }, el("button", { class: "pb-btn small", type: "button", text: "Add API key", onclick: host.openKeys }), el("button", { class: "pb-btn small ghost", type: "button", text: "Local models", onclick: host.openLocalModels })) : null));
  }

  async function refreshOptions(): Promise<boolean> {
    options = await listModelOptions(host.local);
    return options.cloud.length > 0 || options.localReady;
  }

  // ---------- model sheet ----------
  async function openModelSheet(): Promise<void> {
    await refreshOptions();
    const opt = options as ModelOptionList;
    clear(sheet); sheet.hidden = false;
    const close = (): void => { sheet.hidden = true; clear(sheet); };
    const pick = (c: ModelChoice): void => { choice = c; try { localStorage.setItem(MODEL_KEY, JSON.stringify(c)); } catch { /* ignore */ } close(); renderHead(); if (view === "home") show("home"); };
    const row = (label: string, sub: string, selected: boolean, on: () => void, disabled = false): HTMLElement => el("button", { class: "pb-opt", type: "button", "aria-pressed": selected, disabled, onclick: on }, el("strong", { text: label }), el("small", { text: sub }));
    const byProvider = new Map<string, typeof opt.cloud>();
    for (const m of opt.cloud) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
    const search = el("input", { class: "pb-input", type: "search", placeholder: "Filter models…", "aria-label": "Filter models" }) as HTMLInputElement;
    const list = el("div", { class: "pb-opts" });
    const paint = (): void => {
      clear(list);
      const q = search.value.trim().toLowerCase();
      list.append(row("Automatic", opt.connectedKeys ? `Uses ${opt.connectedKeys} connected provider${opt.connectedKeys > 1 ? "s" : ""}, free tiers included` : "Uses any key you add; falls back to the on-device model", choice.kind === "auto", () => pick({ kind: "auto" })));
      list.append(row("On-device model", opt.localReady ? opt.localLabel : "Load a model in Local models first", choice.kind === "local", () => pick({ kind: "local" }), !opt.localReady));
      for (const [provider, models] of byProvider) {
        const shown = models.filter((m) => !q || m.label.toLowerCase().includes(q) || provider.toLowerCase().includes(q));
        if (!shown.length) continue;
        list.append(el("div", { class: "pb-group", text: provider }));
        for (const m of shown.slice(0, 40)) list.append(row(m.label, provider, choice.kind === "cloud" && choice.id === m.id, () => pick({ kind: "cloud", id: m.id, label: m.label })));
      }
      if (!opt.cloud.length) list.append(el("p", { class: "pb-note", text: "No provider keys yet. Add a free key and every model it unlocks appears here." }));
    };
    search.addEventListener("input", paint); paint();
    sheet.append(el("div", { class: "pb-sheet", role: "dialog", "aria-label": "Choose a model" },
      el("div", { class: "pb-sheet-head" }, el("h2", { text: "Model" }), el("button", { class: "icon-btn", type: "button", "aria-label": "Close", text: "×", onclick: close })),
      el("p", { class: "pb-note", text: "Writing a book takes 20–40 model calls. Free keys work; stronger models write better." }),
      search, list,
      el("div", { class: "pb-row" }, el("button", { class: "pb-btn", type: "button", text: "Add API key", onclick: () => { close(); host.openKeys(); } }), el("button", { class: "pb-btn ghost", type: "button", text: "Local models", onclick: () => { close(); host.openLocalModels(); } }))));
  }

  // ---------- views ----------
  function drawHome(c: HTMLElement): void {
    const ideas = cachedTrendIdeas();
    const topic = el("textarea", { class: "pb-input", rows: 3, placeholder: mode === "guided" ? "What do you know, care about, or want to help people with?" : "Creator's niche or what they are known for (optional)", "aria-label": "Topic", oninput: (e: Event) => { draft.topic = (e.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement;
    topic.value = draft.topic;
    const chips = el("div", { class: "pb-chips", "aria-label": "Trending ideas" }, ...ideas.slice(0, 8).map((idea) => el("button", { class: "pb-chip", type: "button", text: idea, onclick: () => { draft.topic = idea; topic.value = idea; } })));
    const modeCards = el("div", { class: "pb-modes" },
      el("button", { class: "pb-mode", type: "button", "aria-pressed": mode === "guided", onclick: () => { mode = "guided"; show("home"); } }, el("strong", { text: "Guided" }), el("small", { text: "You know the topic. Ultron finds the best offer inside it." })),
      el("button", { class: "pb-mode", type: "button", "aria-pressed": mode === "creator", onclick: () => { mode = "creator"; show("home"); } }, el("strong", { text: "From a creator" }), el("small", { text: "Build an eBook from a creator's public content, with their approval." })));
    c.append(modeCards, el("label", { class: "pb-label", text: mode === "guided" ? "Your idea" : "Creator" }), topic);
    if (mode === "guided") c.append(el("div", { class: "pb-sub", text: "Trending today" }), chips);
    else {
      const handle = el("input", { class: "pb-input", type: "text", placeholder: "Website, blog or channel page (public link)", "aria-label": "Public link", oninput: (e: Event) => { draft.handle = (e.target as HTMLInputElement).value; } }) as HTMLInputElement; handle.value = draft.handle;
      const notes = el("textarea", { class: "pb-input", rows: 5, placeholder: "Paste their bio, posts, transcripts or newsletters here. This is the best source.", "aria-label": "Creator material", oninput: (e: Event) => { draft.notes = (e.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement; notes.value = draft.notes;
      c.append(el("label", { class: "pb-label", text: "Public link" }), handle, el("label", { class: "pb-label", text: "Their material" }), notes,
        el("label", { class: "pb-check" }, el("input", { type: "checkbox", checked: draft.consent, onchange: (e: Event) => { draft.consent = (e.target as HTMLInputElement).checked; } }), el("span", { text: "I have this creator's permission, or will get their approval before anything is published." })),
        el("p", { class: "pb-note", text: "Ultron reads public pages and what you paste. It does not log in to social accounts or collect private data." }));
    }
    c.append(el("label", { class: "pb-check" }, el("input", { type: "checkbox", checked: draft.web, onchange: (e: Event) => { draft.web = (e.target as HTMLInputElement).checked; } }), el("span", { text: "Research the web first (existing books, top pages, public sources)" })));
    const level = el("select", { class: "pb-input", "aria-label": "Research depth", onchange: (e: Event) => { draft.research = (e.target as HTMLSelectElement).value as typeof draft.research; } }, el("option", { value: "light", text: "Quick scan · about 8 sources, under a minute" }), el("option", { value: "standard", text: "Standard · about 40 sources, a few minutes" }), el("option", { value: "deep", text: "Deep · reads up to 150 sources, best for long books" })) as HTMLSelectElement;
    level.value = draft.research;
    c.append(el("label", { class: "pb-label block" }, el("span", { text: "Research depth" }), level));
    c.append(modelStatus(), el("button", { class: "pb-btn big", type: "button", text: "Find my profitable pockets", onclick: () => void start() }));
    if (!ideas.length) return;
    void refreshTrendIdeas(http, makeEnv()).then((fresh) => { if (view === "home" && fresh !== ideas && fresh.join() !== ideas.join() && !draft.topic) show("home"); });
  }

  function modelStatus(): HTMLElement {
    const box = el("div", { class: "pb-status" });
    void refreshOptions().then(() => {
      const o = options as ModelOptionList;
      const ready = choice.kind === "local" ? o.localReady : choice.kind === "cloud" ? true : o.cloud.length > 0 || o.localReady;
      clear(box);
      box.append(el("span", { class: `pb-dot ${ready ? "ok" : "warn"}` }), el("span", { text: ready ? `Writing with ${describeChoice(choice)}${choice.kind === "auto" && o.connectedKeys ? ` · ${o.connectedKeys} provider${o.connectedKeys > 1 ? "s" : ""} connected` : ""}${o.localReady ? " · on-device model loaded" : ""}` : "No model is ready yet." }));
      if (!ready) box.append(el("span", { class: "pb-row" }, el("button", { class: "pb-btn small", type: "button", text: "Add API key", onclick: host.openKeys }), el("button", { class: "pb-btn small ghost", type: "button", text: "Local models", onclick: host.openLocalModels })));
    });
    return box;
  }

  async function runDeepResearch(p: Product, target: number): Promise<void> {
    const env = makeEnv();
    try {
      const dr = await deepResearch(http, browserParse, p.topic, {
        target, signal: abort?.signal,
        condense: (batch, topic) => env.complete([{ role: "system", content: SYSTEM_WRITER }, { role: "user", content: promptCondense(batch, topic) }], { maxTokens: 700, signal: abort?.signal }),
        onProgress: (e) => { steps.set(e.phase, { label: e.label, value: e.done, total: e.total }); workNote = e.label; paintWork(); },
      });
      p.research = { query: dr.query, notes: dr.notes, sources: dr.digests.slice(0, 12).map((d) => ({ title: d.title, url: d.url, snippet: d.digest.slice(0, 140) })), deep: true, digests: dr.digests, attempted: dr.attempted, read: dr.read };
      await saveProduct(p);
    } catch (e) { if (e instanceof DOMException && e.name === "AbortError") throw e; /* offline or blocked: continue without research */ }
  }

  async function start(): Promise<void> {
    const topic = draft.topic.trim() || (mode === "creator" ? draft.handle.trim() : "");
    if (topic.length < 3 && !draft.notes.trim()) { error = "Tell Ultron what the book is about first."; show("home"); showError(); return; }
    if (mode === "creator" && !draft.consent) { error = "Confirm you have the creator's permission to continue."; show("home"); showError(); return; }
    const p = newProduct(topic || "Creator eBook", mode);
    product = p;
    await run("Finding your profitable pockets", "pockets", async () => {
      const env = makeEnv();
      if (mode === "creator") {
        const sources: Array<{ title: string; url: string }> = [];
        let text = draft.notes.trim();
        if (draft.handle.trim() && isPublicHttpUrl(draft.handle.trim())) {
          workNote = "Reading the creator's public page"; paintWork();
          try { const page = await fetchPage(http, draft.handle.trim(), 5000); text = `${page.title}. ${page.description}\n${page.text.slice(0, 3500)}\n${text}`.trim(); sources.push({ title: page.title || draft.handle, url: page.url }); } catch { /* pasted notes still work */ }
        }
        p.creator = { handle: draft.handle.trim(), notes: text.slice(0, 5000), sources, consent: draft.consent };
      }
      if (draft.web) {
        if (draft.research === "light") {
          workNote = "Searching the web"; paintWork();
          try { p.research = await research(http, p.topic, { signal: abort?.signal }); } catch { /* offline: continue without it */ }
        } else await runDeepResearch(p, draft.research === "deep" ? 150 : 40);
      }
      await discoverPockets(p, env);
    }, "home");
  }

  function drawPockets(c: HTMLElement): void {
    const p = product; if (!p) return show("home");
    c.append(el("h2", { text: "Your profitable pockets" }), el("p", { class: "pb-note", text: `${p.pockets.length} opportunities across ${p.directions.length} directions, best first. Scores weigh pain, urgency, buying power and speed to a result.` }));
    if (p.research?.sources.length) c.append(el("details", { class: "pb-details" }, el("summary", { text: `Web research · ${p.research.sources.length} sources` }), el("p", { class: "pb-note", text: p.research.notes.slice(0, 700) }), ...p.research.sources.slice(0, 5).map((s) => el("small", { class: "pb-src", text: s.title }))));
    for (const pocket of p.pockets.slice(0, 16)) {
      c.append(el("div", { class: `pb-card ${pocket.recommended ? "rec" : ""}` },
        el("div", { class: "pb-card-top" }, el("span", { class: `pb-score ${scoreTone(pocket.overall)}`, text: pocket.overall.toFixed(1) }), pocket.recommended ? el("span", { class: "pb-badge", text: "Recommended" }) : null, el("small", { text: pocket.niche })),
        el("p", { class: "pb-statement", text: pocket.statement }),
        el("p", { class: "pb-note", text: pocket.problem }),
        el("div", { class: "pb-sub4" }, ...(["pain", "worsening", "purchasing", "speed"] as const).map((k) => el("span", { text: `${k} ${pocket.scores[k]}` }))),
        pocket.rationale ? el("small", { class: "pb-why", text: pocket.rationale }) : null,
        el("button", { class: "pb-btn", type: "button", text: "Build this offer", onclick: () => { p.pocket = pocket; p.stage = "format"; void saveProduct(p); show("format"); } })));
    }
  }

  function drawFormat(c: HTMLElement): void {
    const p = product; if (!p) return show("home");
    c.append(el("h2", { text: "What format do you want?" }), el("p", { class: "pb-note", text: p.pocket?.statement ?? "" }));
    c.append(el("button", { class: "pb-mode wide", type: "button", onclick: () => { p.format = "ebook"; void runOutlines(); } }, el("strong", { text: "eBook" }), el("small", { text: "A finished book: PDF, EPUB and a web page, with a sales page and charter." })));
    for (const [name, note] of [["Pre-recorded course", "Modules, lessons and scripts. Coming next."], ["Coaching offer", "Program structure and session plans. Coming next."]] as const) c.append(el("div", { class: "pb-mode wide disabled", "aria-disabled": true }, el("strong", { text: name }), el("small", { text: note })));
  }
  async function runOutlines(): Promise<void> { const p = product; if (!p) return; await run("Drafting three outlines", "outline", async () => { await generateOutlines(p, makeEnv()); outlineTab = 0; }, "format"); }

  function drawOutline(c: HTMLElement): void {
    const p = product; if (!p) return show("home");
    c.append(el("h2", { text: "Shape your outline" }), el("p", { class: "pb-note", text: "Three different angles on the same offer. Revise one with feedback, then approve the one you want." }));
    c.append(el("div", { class: "pb-seg", role: "tablist" }, ...p.outlines.map((o, i) => el("button", { class: "pb-segbtn", type: "button", role: "tab", "aria-selected": i === outlineTab, text: `${o.label}${o.version > 1 ? ` · v${o.version}` : ""}`, onclick: () => { outlineTab = i; show("outline"); } }))));
    const o = p.outlines[outlineTab]; if (!o) return;
    c.append(el("div", { class: "pb-card" }, el("h3", { text: o.name }), el("p", { class: "pb-statement", text: o.promise }), el("p", { class: "pb-note", text: o.fromTo }), el("ol", { class: "pb-chapters" }, ...o.chapters.map((ch) => el("li", {}, el("strong", { text: ch.title }), el("small", { text: ch.purpose }))))));
    const fb = el("textarea", { class: "pb-input", rows: 2, placeholder: "What should change? (angle, audience, chapters, tone)", "aria-label": "Feedback" }) as HTMLTextAreaElement;
    c.append(fb, el("div", { class: "pb-row" },
      el("button", { class: "pb-btn ghost", type: "button", text: "Revise this outline", onclick: () => { const text = fb.value.trim(); if (!text) { fb.focus(); return; } void run("Revising outline", "outline", async () => { await reviseOutline(p, o.id, text, makeEnv()); }, "outline"); } }),
      el("button", { class: "pb-btn", type: "button", text: "Approve this outline", onclick: () => { approveOutline(p, o.id); void saveProduct(p); show("customise"); } })));
  }

  function drawCustomise(c: HTMLElement): void {
    const p = product; if (!p) return show("home");
    const cu = p.custom;
    const tone = el("textarea", { class: "pb-input", rows: 2, "aria-label": "Tone", oninput: (e: Event) => { cu.tone = (e.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement; tone.value = cu.tone;
    const notes = el("textarea", { class: "pb-input", rows: 3, placeholder: "Stories to include, things to avoid, your own methods, audience details…", "aria-label": "Notes", oninput: (e: Event) => { cu.notes = (e.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement; notes.value = cu.notes;
    const select = (label: string, values: Array<[string, string]>, current: string, on: (v: string) => void): HTMLElement => el("label", { class: "pb-label block" }, el("span", { text: label }), (() => { const s = el("select", { class: "pb-input", onchange: (e: Event) => on((e.target as HTMLSelectElement).value) }, ...values.map(([v, t]) => el("option", { value: v, text: t }))) as HTMLSelectElement; s.value = current; return s; })());
    const refs = el("div", { class: "pb-refs" });
    const paintRefs = (): void => { clear(refs); for (const [i, r] of cu.references.entries()) refs.append(el("div", { class: "pb-ref" }, el("span", { text: `${r.name} · ${r.text.length.toLocaleString()} chars` }), el("button", { class: "pb-link", type: "button", text: "Remove", onclick: () => { cu.references.splice(i, 1); paintRefs(); } }))); };
    paintRefs();
    const file = el("input", { type: "file", accept: ".txt,.md,.csv,.json,.html", hidden: true, multiple: true, onchange: async (e: Event) => { for (const f of Array.from((e.target as HTMLInputElement).files ?? [])) { if (f.size > 400_000) continue; const text = (await f.text()).slice(0, 12000); cu.references.push({ name: f.name, text }); } paintRefs(); } }) as HTMLInputElement;
    c.append(el("h2", { text: "Customise your eBook" }), el("p", { class: "pb-note", text: `Approved: ${p.title}` }),
      select("Book format", Object.entries(BOOK_FORMATS).map(([k, v]) => [k, `${v.label} · ${v.hint}`]), cu.bookFormat, (v) => { cu.bookFormat = v as BookFormat; }),
      select("Depth", Object.entries(DEPTH_SPEC).map(([k, v]) => [k, `${v.label} · ${v.chapters} chapters`]), cu.depth, (v) => { cu.depth = v as Depth; }),
      select("Illustrations", [["0", "None"], ["2", "2 images"], ["3", "3 images"], ["5", "5 images"], ["8", "8 images"]], String(cu.imageCount), (v) => { cu.imageCount = Number(v); }),
      ...(DEPTH_SPEC[cu.depth].pages && !p.research?.deep ? [el("div", { class: "pb-status" }, el("span", { class: "pb-dot warn" }), el("span", { text: `${DEPTH_SPEC[cu.depth].label} books are stronger after deep research (it grounds each chapter in real sources).` }), el("button", { class: "pb-btn small", type: "button", text: "Run deep research (150 sources)", onclick: () => { void run("Reading sources", "customise", async () => { await runDeepResearch(p, 150); }, "customise"); } }))] : []),
      el("label", { class: "pb-label", text: "Tone" }), tone, el("label", { class: "pb-label", text: "Your notes" }), notes,
      el("div", { class: "pb-sub", text: "Reference material (optional)" }), refs, file, el("button", { class: "pb-btn ghost", type: "button", text: "Add text, Markdown or CSV files", onclick: () => file.click() }),
      el("button", { class: "pb-btn big", type: "button", text: "Build the transformation map", onclick: () => { void run("Building the transformation map", "vtm", async () => { await buildVtm(p, makeEnv()); }, "customise"); } }));
  }

  function drawVtm(c: HTMLElement): void {
    const p = product; const v = p?.vtm; if (!p || !v) return show("customise");
    c.append(el("h2", { text: "Visceral Transformation Map" }), el("p", { class: "pb-note", text: "The emotional before and after your book delivers. Every chapter is built on it." }));
    for (const r of v.rows) c.append(el("div", { class: "pb-card" }, el("div", { class: "pb-sub", text: r.label }), el("div", { class: "pb-ba" }, el("div", {}, el("small", { text: "BEFORE" }), el("p", { text: r.before })), el("div", {}, el("small", { text: "AFTER" }), el("p", { text: r.after })))));
    c.append(el("div", { class: "pb-sub", text: "Transformation stages" }), el("ol", { class: "pb-chapters" }, ...v.stages.map((s) => el("li", {}, el("strong", { text: s.stage }), el("small", { text: `${s.goal} ${s.description}`.trim() })))));
    const fb = el("input", { class: "pb-input", type: "text", placeholder: "Change something (e.g. make the fears more specific)", "aria-label": "Refine map" }) as HTMLInputElement;
    c.append(fb, el("div", { class: "pb-row" },
      el("button", { class: "pb-btn ghost", type: "button", text: "Refine", onclick: () => { const t = fb.value.trim(); if (!t) { fb.focus(); return; } void run("Refining the map", "vtm", async () => { await refineVtm(p, t, makeEnv()); }, "vtm"); } }),
      el("button", { class: "pb-btn", type: "button", text: "Continue", onclick: () => { void run("Designing the eBook", "structure", async () => { await buildSummary(p, makeEnv()); }, "vtm"); } })));
  }

  function drawStructure(c: HTMLElement): void {
    const p = product; const s = p?.summary; if (!p || !s) return show("vtm");
    c.append(el("h2", { text: s.title }), el("p", { class: "pb-statement", text: s.subtitle }), el("p", { class: "pb-note", text: s.about }),
      el("div", { class: "pb-meta" }, el("span", { text: `${s.wordRange[0].toLocaleString()}–${s.wordRange[1].toLocaleString()} words` }), el("span", { text: `~${s.readingMinutes} min read` }), el("span", { text: DEPTH_SPEC[p.custom.depth].pages ? `${DEPTH_SPEC[p.custom.depth].pages}+ pages` : DEPTH_SPEC[p.custom.depth].label })),
      el("div", { class: "pb-sub", text: "What readers learn" }), el("ul", { class: "pb-list" }, ...s.learn.map((l) => el("li", { text: l }))),
      el("div", { class: "pb-sub", text: "Frameworks in this book" }), ...s.glossary.map((g) => el("div", { class: "pb-gloss" }, el("strong", { text: g.term }), el("small", { text: g.meaning }))),
      el("div", { class: "pb-sub", text: "Bonus materials" }), el("ul", { class: "pb-list" }, ...s.bonuses.map((b) => el("li", { text: `${b.title} · ${b.kind}` }))),
      el("button", { class: "pb-btn big", type: "button", text: "Plan the chapters", onclick: () => { void run("Planning the chapters", "plan", async () => { await planChapters(p, makeEnv()); }, "structure"); } }));
  }

  function drawPlan(c: HTMLElement): void {
    const p = product; if (!p || !p.sections.length) return show("structure");
    const done = p.sections.filter((s) => s.status === "done").length;
    c.append(el("h2", { text: done ? "Your manuscript" : "Chapter plan" }), el("p", { class: "pb-note", text: done ? `${done} of ${p.sections.length} sections written.` : `${p.sections.length} sections. Ultron writes them in waves and saves after each one.` }));
    c.append(el("ol", { class: "pb-chapters" }, ...p.sections.map((s) => el("li", {}, el("strong", { text: `${sectionLabel(p, s)} · ${s.title}` }), el("small", { text: s.status === "error" ? `Needs retry: ${s.error ?? ""}` : s.purpose })))));
    const needs = p.sections.some((s) => s.status !== "done");
    c.append(el("button", { class: "pb-btn big", type: "button", text: needs ? (done ? "Continue writing" : "Write the book") : "Finish and design", onclick: () => void writeAll() }));
  }

  async function writeAll(): Promise<void> {
    const p = product; if (!p) return;
    await run("Writing your book", "product", async () => {
      const env = makeEnv(p.custom.imageCount > 0);
      if (p.sections.some((s) => s.status !== "done")) await writeManuscript(p, env, choice.kind === "local" ? 2 : 3);
      if (p.sections.some((s) => s.status !== "done")) throw new Error("Some sections did not finish. Your progress is saved; tap Continue writing to retry them.");
      workNote = "Designing the branding"; steps.clear(); paintWork();
      await designBranding(p, env);
      if (p.custom.imageCount > 0) { workNote = "Generating illustrations"; paintWork(); await renderImages(p, env); }
      const pagesTarget = DEPTH_SPEC[p.custom.depth].pages;
      if (pagesTarget) { workNote = "Measuring the book"; steps.clear(); paintWork(); await expandToTarget(p, { ...env, measurePages: measurePdfPages }, pagesTarget); }
      workNote = "Writing the sales page"; paintWork();
      await buildStore(p, env);
      p.stage = "done"; readTab = "read";
      await saveProduct(p);
    }, "plan");
  }

  function drawManuscript(c: HTMLElement): void { drawPlan(c); }

  function drawProduct(c: HTMLElement): void {
    const p = product; if (!p) return show("projects");
    const brand = brandOf(p);
    c.append(el("div", { class: "pb-seg", role: "tablist" }, ...([["read", "Read"], ["export", "Export"], ["store", "Store page"], ["charter", "Charter"]] as const).map(([k, t]) => el("button", { class: "pb-segbtn", type: "button", role: "tab", "aria-selected": readTab === k, text: t, onclick: () => { readTab = k; show("product"); } }))));
    const q = qualityReport(p);
    if (readTab === "read") {
      const look = imageLookup(p);
      const page = el("div", { class: "pb-book", style: `--bk-page:${brand.page};--bk-type:${brand.type};--bk-accent:${brand.accent};--bk-tint:${brand.tint};--bk-muted:${brand.muted};--bk-display:"${brand.displayFont}",Georgia,serif;--bk-body:"${brand.bodyFont}",system-ui,sans-serif` });
      const dis = disclaimerOf(p);
      page.append(el("h1", { class: "bk-title", text: bookTitle(p) }), el("p", { class: "bk-sub", text: p.summary?.subtitle ?? "" }));
      if (dis) page.append(el("p", { class: "bk-fine", text: dis }));
      for (const s of p.sections.filter((x) => x.status === "done")) {
        const sec = el("section", { class: "bk-section" }, el("p", { class: "bk-label", text: sectionLabel(p, s) }), el("h2", { class: "bk-h", text: s.title }), el("hr", { class: "bk-rule" }));
        const html = el("div", { class: "bk-body" }); html.innerHTML = blocksToHtml(s.blocks, (id) => { const a = look(id); return a ? `data:${a.mime};base64,${a.data}` : null; });
        sec.append(html); page.append(sec);
      }
      c.append(el("p", { class: "pb-note", text: `${q.totalWords.toLocaleString()} words · ${p.sections.length} sections${q.issues.length ? ` · ${q.issues.length} editor note${q.issues.length > 1 ? "s" : ""}` : ""}` }),
        ...(q.issues.length ? [el("details", { class: "pb-details" }, el("summary", { text: "Editor notes" }), ...q.issues.map((i) => el("small", { class: "pb-src", text: i })))] : []), page);
    } else if (readTab === "export") {
      c.append(el("h2", { text: "Export" }), el("p", { class: "pb-note", text: "Files are saved on this device and appear in your Agent Workspace. Share them to Drive, email or your e-reader." }));
      const pagesNote = el("p", { class: "pb-note", text: "Measuring the PDF…" });
      void measurePdfPages(p).then((n) => { pagesNote.textContent = `The PDF is ${n} pages (6×9 in).`; }).catch(() => { pagesNote.textContent = ""; });
      c.append(pagesNote);
      const status = el("p", { class: "pb-note", role: "status", "aria-live": "polite" });
      for (const f of Object.keys(FORMAT_INFO) as ExportFormat[]) {
        const info = FORMAT_INFO[f];
        c.append(el("div", { class: "pb-export" }, el("div", {}, el("strong", { text: info.label }), el("small", { text: info.hint })),
          el("div", { class: "pb-row" },
            el("button", { class: "pb-btn small", type: "button", text: "Save", onclick: async (e: Event) => { const b = e.target as HTMLButtonElement; b.disabled = true; status.textContent = `Building ${info.label}…`; try { const meta = await exportProduct(p, f); status.textContent = `Saved ${meta.name} (${(meta.size / 1024).toFixed(0)} KB) to your files.`; } catch (err) { status.textContent = err instanceof Error ? err.message : "Export failed."; } b.disabled = false; } }),
            el("button", { class: "pb-btn small ghost", type: "button", text: "Share", onclick: async (e: Event) => { const b = e.target as HTMLButtonElement; b.disabled = true; status.textContent = `Building ${info.label}…`; try { const blob = await renderExport(p, f); const how = await shareBlob(blob, `${bookTitle(p).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50) || "ebook"}.${info.ext}`); status.textContent = how === "shared" ? "Shared." : "Download started."; } catch (err) { status.textContent = err instanceof Error ? err.message : "Export failed."; } b.disabled = false; } }))));
      }
      c.append(status);
    } else if (readTab === "store" && p.store) {
      const s = p.store;
      c.append(el("div", { class: "pb-card" }, el("h2", { text: s.headline }), el("p", { class: "pb-statement", text: s.subhead }), el("ul", { class: "pb-list" }, ...s.bullets.map((b) => el("li", { text: b }))), el("p", { class: "pb-note", text: `Price idea: ${s.priceSuggestion}` }), ...s.faq.map((f) => el("div", { class: "pb-gloss" }, el("strong", { text: f.q }), el("small", { text: f.a })))),
        el("button", { class: "pb-btn ghost", type: "button", text: "Copy sales copy", onclick: async (e: Event) => { const text = [s.headline, s.subhead, ...s.bullets.map((b) => `• ${b}`), `Price: ${s.priceSuggestion}`, ...s.faq.map((f) => `${f.q}\n${f.a}`)].join("\n\n"); try { await navigator.clipboard.writeText(text); (e.target as HTMLButtonElement).textContent = "Copied"; } catch { (e.target as HTMLButtonElement).textContent = "Copy failed"; } } }));
    } else if (readTab === "charter" && p.charter) {
      const ch = p.charter;
      c.append(el("div", { class: "pb-card" }, el("h2", { text: "Product charter" }), kv("Promise", ch.promise), kv("Audience", ch.audience), kv("Outcome", ch.outcome), kv("Voice", ch.voice)), el("div", { class: "pb-sub", text: "Structure" }), el("ul", { class: "pb-list" }, ...ch.structure.map((x) => el("li", { text: x }))), el("div", { class: "pb-sub", text: "Guardrails" }), el("ul", { class: "pb-list" }, ...ch.guardrails.map((x) => el("li", { text: x }))), el("div", { class: "pb-sub", text: "Before you sell it" }), el("ul", { class: "pb-list" }, ...ch.nextSteps.map((x) => el("li", { text: x }))));
    }
  }
  const kv = (k: string, v: string): HTMLElement => el("div", { class: "pb-gloss" }, el("small", { text: k.toUpperCase() }), el("strong", { text: v }));

  function drawProjects(c: HTMLElement): void {
    c.append(el("h2", { text: "Projects" }), el("p", { class: "pb-note", text: "Everything Ultron builds in this tab, including books started from chat." }));
    const list = el("div", { class: "pb-gallery" }); c.append(list);
    void listProducts().then((cards) => {
      if (!cards.length) { list.append(el("p", { class: "pb-note", text: "No projects yet. Start one from Create." })); return; }
      for (const card of cards) {
        list.append(el("div", { class: "pb-proj" },
          el("button", { class: "pb-proj-open", type: "button", onclick: () => void resume(card.id) },
            el("span", { class: "pb-cover", style: `background:${card.page};border-color:${card.accent}` }, el("i", { style: `background:${card.accent}` })),
            el("span", { class: "pb-proj-copy" }, el("strong", { text: card.title }), el("small", { text: `${card.stage === "done" ? "Finished" : `In progress · ${card.stage}`} · ${card.done}/${card.sections || "?"} sections · ${card.words.toLocaleString()} words`.replace("0/?", "not started") }), el("small", { text: `${ago(card.updatedAt)}${card.source === "chat" ? " · started in chat" : ""}` }))),
          el("button", { class: "pb-link danger", type: "button", "aria-label": `Delete ${card.title}`, text: "Delete", onclick: async (e: Event) => { const b = e.target as HTMLButtonElement; if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to delete"; setTimeout(() => { b.dataset.sure = ""; b.textContent = "Delete"; }, 3000); return; } await deleteProduct(card.id); if (product?.id === card.id) product = null; show("projects"); } })));
      }
    });
  }

  async function resume(id: string): Promise<void> {
    const p = await loadProduct(id);
    if (!p) { error = "That project could not be loaded."; show("projects"); return; }
    product = p; mode = p.mode;
    const done = p.sections.filter((s) => s.status === "done").length;
    const map: Record<Product["stage"], View> = { discover: "home", pockets: "pockets", format: "format", outline: "outline", customise: "customise", vtm: "vtm", structure: "structure", manuscript: "plan", branding: "plan", done: "product" };
    let target = map[p.stage];
    if (p.stage === "manuscript" && !p.sections.length) target = "structure";
    if (p.stage === "outline" && !p.outlines.length) target = "format";
    if (p.stage === "pockets" && !p.pockets.length) target = "home";
    if (done === p.sections.length && p.sections.length && p.stage !== "done") target = "plan";
    show(target);
  }

  function open(opts: { topic?: string; autostart?: boolean } = {}): void {
    if (opts.topic) draft.topic = opts.topic;
    if (product && view !== "home" && !opts.topic && view !== "projects") { show(view === "working" ? "working" : view); return; }
    show("home");
    void refreshOptions();
    if (opts.topic && opts.autostart) void start();
  }

  show("home");
  return { open, resume };
}

export { cardOf };
