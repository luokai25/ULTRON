import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const mg = await loadSource("media-gen.ts");
const tf = await loadSource("think-filter.ts");

test("what counts as a request to make a picture or a video", () => {
  const yes = { image: ["generate an image of a red fox in snow", "make me a logo for my coffee shop", "draw me a dragon over a castle at night", "create a poster about summer music", "can you make a picture of the moon over the sea", "design an icon for a weather app"], video: ["make a video about a rocket launch", "create a short animation of a bouncing ball", "generate a video of a city at night", "produce a reel about healthy breakfast ideas"] };
  for (const [kind, list] of Object.entries(yes)) for (const m of list) assert.equal(mg.detectMediaIntent(m)?.kind, kind, m);
  for (const no of ["how do I make a video go viral", "what is an image classifier", "write a python function that draws a circle", "make me an ebook about drawing", "explain how photos are compressed", "draw conclusions from this data", "make a presentation about images"]) assert.equal(mg.detectMediaIntent(no), null, no);
  assert.equal(mg.detectMediaIntent("generate an image of a red fox in snow please").prompt, "red fox in snow");
});

const png = Buffer.alloc(9000, 7).toString("base64");
const fakeHttp = (over = {}) => ({
  bytes: async (url) => (over.pollinations === "fail" && url.includes("pollinations") ? { status: 500, mime: "", base64: "" } : over.pollinations === "html" ? { status: 200, mime: "text/html", base64: png } : { status: 200, mime: "image/jpeg", base64: png }),
  get: async (url) => { over.log?.push(url); if (url.includes("/generate/check/")) { over.checks = (over.checks ?? 0) + 1; return { status: 200, url, contentType: "application/json", text: JSON.stringify(over.checks < 3 ? { done: false, queue_position: 2, wait_time: 8 } : { done: true }) }; } if (url.includes("/generate/status/")) return { status: 200, url, contentType: "application/json", text: JSON.stringify({ generations: [{ img: "https://r2.example/img.webp" }] }) }; return { status: 404, url, contentType: "", text: "" }; },
  request: async (m, url, o) => { over.log?.push(`${m} ${url}`); over.sent = JSON.parse(o.body); over.headers = o.headers; return { status: 202, url, contentType: "application/json", text: JSON.stringify({ id: "job1" }) }; },
});

test("Pollinations is tried first and its answer is validated", async () => {
  const log = [];
  const ok = await mg.generateImage("a red fox", { http: { ...fakeHttp(), bytes: async (u) => { log.push(u); return { status: 200, mime: "image/jpeg", base64: png }; } }, sleep: async () => {} });
  assert.equal(ok.engine, "pollinations"); assert.ok(ok.bytes.length > 5000);
  assert.match(log[0], /image\.pollinations\.ai\/prompt\/a%20red%20fox\?width=1024/);
  assert.equal(await mg.viaPollinations("x", { http: fakeHttp({ pollinations: "html" }) }), null, "an HTML error page is not an image");
});

test("when Pollinations fails the AI Horde anonymous queue is used, with progress updates and no key", async () => {
  const over = { pollinations: "fail", log: [] }; const status = [];
  let clock = 0;
  const img = await mg.generateImage("a red fox", { http: fakeHttp(over), sleep: async (ms) => { clock += ms; }, now: () => clock, status: (s) => status.push(s) });
  assert.equal(img.engine, "horde");
  assert.equal(over.headers.apikey, "0000000000", "the anonymous Horde key, nothing personal");
  assert.equal(over.sent.params.n, 1); assert.equal(over.sent.censor_nsfw, true);
  assert.ok(status.some((s) => /queue/i.test(s)));
  assert.equal(await mg.generateImage("x", { http: { ...fakeHttp({ pollinations: "fail" }), request: undefined }, sleep: async () => {} }), null, "everything down means null, not a crash");
});

test("video scene planning accepts model output and falls back sensibly", () => {
  assert.equal(mg.parseScenes({ scenes: [{ caption: "Liftoff", imagePrompt: "a rocket leaving the pad at dawn, cinematic" }, { caption: "", imagePrompt: "x" }, { caption: "Orbit", image_prompt: "earth from orbit, blue marble, cinematic" }] }).length, 2);
  const fb = mg.fallbackScenes("a rocket launch"); assert.equal(fb.length, 4); assert.ok(fb.every((s) => s.imagePrompt.includes("rocket")));
});

test("reasoning is split from the answer, including while it streams", () => {
  const a = tf.splitThinking("<think>The user wants X.\nLet me plan.</think>Here is the answer.");
  assert.deepEqual([a.thought, a.answer, a.open], ["The user wants X.\nLet me plan.", "Here is the answer.", false]);
  const streaming = tf.splitThinking("<think>Still working on this");
  assert.deepEqual([streaming.thought, streaming.answer, streaming.open], ["Still working on this", "", true]);
  const lone = tf.splitThinking("reasoning here</think>\nFinal answer.");
  assert.deepEqual([lone.thought, lone.answer], ["reasoning here", "Final answer."]);
  assert.deepEqual(tf.splitThinking("no tags here"), { thought: "", answer: "no tags here", open: false });
  assert.equal(tf.visibleReply("<think>only reasoning</think>"), "only reasoning", "never shows an empty reply");
  assert.equal(tf.stripThinking("<think>a</think>Hi <think>b</think>there"), "Hi there");
});
