// Skeletons (PLAN, Usability) and the rewind-motion review fixes (Oct 23).
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "./test";
import { formatTime } from "../lib/format";
import type { PracticeSeed } from "../lib/demo/types";

const SEED = "private/demo/seed.json";
const seed: PracticeSeed | null = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : null;

test.skip(!seed, "needs the local practice seed (npm run spike:seed)");

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
});

type Box = [number, number, number, number];

/**
 * With JavaScript off the Suspense fallback stays on screen and the streamed content waits in a hidden div;
 * measure the skeleton, put the content in its place (as React does), and measure again.
 */
async function measureSwap(browser: Browser, viewport: { width: number; height: number }, path: string, pairs: [string, string, string][], grow?: string) {
  const ctx = await browser.newContext({ viewport, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(path);
  // Load every font now: a skeleton has no glyphs, so its fonts would otherwise load only after the swap.
  await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load())));
  const boxes = (sels: string[]) =>
    page.evaluate(
      (sels) =>
        sels.map((s) =>
          [...document.querySelectorAll(s)]
            .filter((e) => e.getClientRects().length && !e.closest("[hidden]"))
            .map((e) => {
              const r = e.getBoundingClientRect();
              return [r.x, r.y, r.width, r.height] as Box;
            }),
        ),
      sels,
    );
  const before = await boxes(pairs.map((p) => p[1]));
  await page.evaluate(() => {
    const start = document.getElementById("B:0")!;
    const fallback: ChildNode[] = [];
    for (let n = start.nextSibling; n && !(n.nodeType === 8 && (n as Comment).data === "/$"); n = n.nextSibling) fallback.push(n);
    fallback.at(-1)!.after(...document.getElementById("S:0")!.childNodes);
    for (const f of fallback) f.remove();
  });
  // Load every font now: a skeleton has no glyphs, so its fonts would otherwise load only after the swap.
  await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load())));
  const after = await boxes(pairs.map((p) => p[2]));
  await ctx.close();
  // A text block whose length the skeleton can't know (the question's stem) may grow; what sits below it
  // then moves by exactly that growth and by nothing else.
  const grows = grow ? pairs.findIndex((p) => p[0] === grow) : -1;
  const growth = grows >= 0 ? after[grows][0][3] - before[grows][0][3] : 0;
  const growBottom = grows >= 0 ? before[grows][0][1] + before[grows][0][3] : Infinity;
  return pairs.map(([name], i) => {
    expect(before[i].length, `${name}: skeleton has it`).toBeGreaterThan(0);
    const n = Math.min(before[i].length, after[i].length);
    let worst = 0;
    for (let j = 0; j < n; j++) {
      // Below it means in its column (on desktop the answers sit beside the stem, not under it).
      const [x, y, w] = before[i][j];
      const g = grows >= 0 ? before[grows][0] : null;
      const under = !!g && y >= growBottom - 0.5 && x < g[0] + g[2] && x + w > g[0];
      const expectedDy = under ? growth : 0;
      worst = Math.max(worst, Math.abs(after[i][j][0] - before[i][j][0]), Math.abs(after[i][j][1] - before[i][j][1] - expectedDy));
    }
    return { name, worst, growth };
  });
}

test("the practice sheet's skeleton has the sheet's geometry: nothing moves more than 2 px when the question swaps in", async ({ browser, viewport }) => {
  const shifts = await measureSwap(
    browser,
    viewport!,
    "/practice?set=seed",
    [
      ["sheet", "main > div:first-child", "main > div:first-child"],
      ["back", "a[aria-label=Back]", "a[aria-label=Back]"],
      ["progress", "[data-skel=progress]", "[aria-label^='Question ']"],
      ["stem", "[data-skel=stem] > div", "h1"],
      ["answers", "[data-skel=answer]", "[role=radio]"],
      ["check", "[data-skel=check]", "main button.btn-primary"],
      ["skip", "[data-skel=skip]", "main button.btn-secondary"],
    ],
    "stem",
  );
  test.info().annotations.push({ type: "stem growth (px)", description: String(shifts[0].growth) });
  for (const s of shifts) expect(s.worst, s.name).toBeLessThanOrEqual(2);
});

test("the radar's skeleton has the list's geometry: nothing moves more than 2 px when the list swaps in", async ({ browser, viewport }) => {
  test.skip(!seed?.radar?.length, "needs radar moments");
  const shifts = await measureSwap(browser, viewport!, "/radar", [
    ["heading", "h1", "h1"],
    ["intro", "[data-skel=intro]", "header p"],
    ["filters", "[data-skel=chips]", "[role=group]"],
    ["cards", "[data-skel=card]", "main ol > li"],
  ]);
  for (const s of shifts) expect(s.worst, s.name).toBeLessThanOrEqual(2);
});

test("skeletons shimmer slowly, and hold still with reduced motion", async ({ browser, viewport }) => {
  // JavaScript off keeps the Suspense fallback on screen.
  const ctx = await browser.newContext({ viewport, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto("/radar");
  const glint = () => page.locator(".skeleton").first().evaluate((el) => ({ d: getComputedStyle(el, "::after").animationDuration, show: getComputedStyle(el, "::after").display }));
  expect(await glint()).toEqual({ d: "1.5s", show: "block" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await glint()).show).toBe("none");
  await ctx.close();
});

/** A fake extension whose embedded frame isn't ready until `readyAfter` ms, then plays from the clip start. */
async function slowEmbed(page: Page, start: number, readyAfter: number) {
  await page.addInitScript(
    ([start, readyAfter]) => {
      const t0 = Date.now();
      (window as unknown as { chrome: unknown }).chrome = {
        runtime: {
          sendMessage(_id: string, msg: { embed?: boolean; type: string }, cb: (r: unknown) => void) {
            const ready = Date.now() - t0 > readyAfter;
            const state = { currentTime: start, paused: true, rate: 1, duration: 6081 };
            setTimeout(() => cb(ready ? { ok: true, state, media: { kind: "audio", videoWidth: null, videoHeight: null } } : { ok: false, error: "no-frame" }), 10);
          },
        },
      };
    },
    [start, readyAfter],
  );
}

test("while the recording loads, the controls are skeletons in the same boxes, with one line after 3 s", async ({ page }) => {
  test.setTimeout(30_000);
  const q = seed!.questions[0];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await slowEmbed(page, q.match.start, 5500);
  await page.goto("/practice?set=seed");
  await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
  const clip = page.getByRole("region", { name: "Lecture clip" });
  await expect(clip.locator("[data-skel=play]")).toBeVisible();
  await expect(clip).toHaveAttribute("aria-busy", "true");
  // "From the start of the example" needs the recording too: a shape until it's ready.
  await expect(clip.locator("[data-skel=example]").filter({ visible: true })).toBeVisible();
  await expect(clip.getByRole("button", { name: /^From the start of the example/ })).toHaveCount(0);
  // The counter already reads the clip start; no spinner, no blank.
  await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start));
  const line = page.getByText(/^Loading the Zoom recording…$/).filter({ visible: true });
  await expect(line).toHaveCount(0);
  const shapes = await Promise.all(["back", "play", "speed"].map((k) => clip.locator(`[data-skel=${k}]`).boundingBox()));
  await expect(line.first()).toBeVisible({ timeout: 4000 });
  const panel = clip.locator(".bg-deck-raised").first();
  const panelWaiting = (await panel.boundingBox())!;
  // Ready: the real controls take the shapes' places.
  const play = clip.getByRole("button", { name: /^(Play|Pause) clip$/ });
  await expect(play).toBeVisible({ timeout: 8000 });
  const real = await Promise.all([clip.getByRole("button", { name: "Back 10 seconds" }), play, clip.getByRole("button", { name: /^Playback speed/ })].map((l) => l.boundingBox()));
  real.forEach((r, i) => {
    expect(Math.abs(r!.x - shapes[i]!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(r!.y - shapes[i]!.y)).toBeLessThanOrEqual(2);
  });
  await expect(clip).toHaveAttribute("aria-busy", "false");
  await expect(clip.getByRole("button", { name: /^From the start of the example/ })).toBeVisible();
  // The line saying what is happening held its own space: the panel keeps its size when the controls swap in.
  expect(Math.abs((await panel.boundingBox())!.height - panelWaiting.height)).toBeLessThanOrEqual(2);
});

test("on a phone, a radar moment's caption stays inside the slide frame, its source label under the frame, for every moment", async ({ page, viewport }) => {
  test.skip(!seed?.radar?.length || (viewport?.width ?? 0) !== 390, "radar moments at 390 px");
  await page.goto("/radar");
  const items = page.locator("main > ol > li");
  for (let i = 0; i < seed!.radar!.length; i++) {
    await items.nth(i).getByRole("button", { name: /^Play the moment at / }).click();
    const figure = items.nth(i).locator("figure [data-slide-panel]");
    const caption = figure.locator("[data-slide-caption]");
    await expect(caption).not.toHaveText(" ");
    const [f, c, label] = await Promise.all([figure.boundingBox(), caption.boundingBox(), items.nth(i).locator("figcaption").getByText("No slide matched this moment").boundingBox()]);
    expect(label!.y, `moment ${i}: source label under the frame`).toBeGreaterThanOrEqual(f!.y + f!.height - 0.5);
    expect(c!.y, `moment ${i}: caption inside the frame`).toBeGreaterThanOrEqual(f!.y - 0.5);
    expect(c!.y + c!.height, `moment ${i}: caption inside the frame`).toBeLessThanOrEqual(f!.y + f!.height + 0.5);
    expect(c!.x).toBeGreaterThanOrEqual(f!.x - 0.5);
    expect(c!.x + c!.width).toBeLessThanOrEqual(f!.x + f!.width + 0.5);
  }
});

test.describe("rewind motion review fixes", () => {
  /** `slideReady`: wait until the question's slide is decoded before the miss (the page preloads it while you answer; on a cold or busy dev server that can take longer than the test's clicks). */
  async function missWithProbe(page: Page, probe: string, { slideReady = false }: { slideReady?: boolean } = {}) {
    const q = seed!.questions[0];
    await page.goto("/practice?set=seed");
    if (slideReady) {
      const src = /^(\/|https?:\/\/)/.test(q.match.slide.image) ? q.match.slide.image : `/api/dev-slides/${q.match.slide.image}`;
      await page.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
      }, src);
    }
    await page.getByRole("radio", { name: new RegExp(`^Option ${q.choices.find((c) => c.label !== q.answer)!.label},`) }).click();
    // Sample every frame from the click on (the probe is a function body run each frame; it returns false to stop).
    await page.evaluate((probe) => {
      const w = window as unknown as { __frames: unknown[] };
      w.__frames = [];
      const step = new Function("frames", probe) as (f: unknown[]) => boolean;
      const loop = () => {
        if (step(w.__frames) !== false) requestAnimationFrame(loop);
      };
      (window as unknown as { __probe: () => void }).__probe = () => requestAnimationFrame(loop);
    }, probe);
    await page.getByRole("button", { name: "Check answer" }).click();
    // The rewind starts on /^Rewind to .+'s explanation$/, after the grading beat.
    const rewind = page.getByRole("button", { name: /^Rewind to .+'s explanation$/ });
    await rewind.evaluate((b) => b.addEventListener("click", () => (window as unknown as { __probe: () => void }).__probe(), { capture: true, once: true }));
    await rewind.click();
    return q;
  }
  const frames = <T,>(page: Page) => page.evaluate(() => (window as unknown as { __frames: T[] }).__frames);

  test("every frame of the rolling counter reads one time between the start and the clip time, never rising", async ({ page }) => {
    const q = await missWithProbe(
      page,
      `const od = document.querySelector("[data-odometer]");
       if (!od) return frames.length === 0;
       const units = { h: 3600, m10: 600, m1: 60, s10: 10, s1: 1 };
       let t = 0;
       for (const el of od.querySelectorAll("[data-w]")) {
         if (!(el.dataset.w in units) || el.style.display === "none") continue;
         const y = parseFloat(el.firstElementChild.style.transform.replace("translateY(", "")) || 0;
         const base = el.dataset.w === "m10" || el.dataset.w === "s10" ? 6 : 10;
         // The digit on show: the whole cell under the window (a rolling seconds digit counts as its fraction).
         const pos = -y;
         t += (el.dataset.w === "s1" ? pos : Math.floor(pos + 1e-6) % base) * units[el.dataset.w];
       }
       frames.push(t);
       return true;`,
    );
    await expect(page.locator("[data-counter]")).toHaveText(formatTime(q.match.start), { timeout: 3000 });
    const ts = await frames<number>(page);
    expect(ts.length).toBeGreaterThan(20);
    const start = Math.floor(q.match.start);
    for (let i = 0; i < ts.length; i++) {
      expect(ts[i], `frame ${i}`).toBeGreaterThanOrEqual(start - 1e-3);
      if (i > 0) expect(ts[i], `frame ${i} after ${ts[i - 1]}`).toBeLessThanOrEqual(ts[i - 1] + 1e-3);
    }
  });

  test("the fold never shows the old sheet's print and the strip's (or the deck's) at once", async ({ page }) => {
    await missWithProbe(
      page,
      `const g = document.querySelector("[data-strip-ghost]");
       if (!g) return false;
       const op = (el) => parseFloat(getComputedStyle(el).opacity);
       const rise = [...document.querySelectorAll("main [data-rise]:not([data-rise=solid])")].filter((e) => e.getClientRects().length);
       frames.push({ old: op(g.children[1]), fresh: op(g.children[2]), deck: Math.max(0, ...rise.map(op)) });
       return true;`,
    );
    await expect(page.locator("[data-strip-ghost]")).toHaveCount(0, { timeout: 1000 });
    const fs = await frames<{ old: number; fresh: number; deck: number }>(page);
    expect(fs.length).toBeGreaterThan(5);
    for (const f of fs) expect(f.old > 0.01 && Math.max(f.fresh, f.deck) > 0.01, JSON.stringify(f)).toBe(false);
  });

  test("with reduced motion the first frame after a miss is already the final layout", async ({ page, viewport }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await missWithProbe(
      page,
      `const fig = document.querySelector("figure");
       if (!fig) return frames.length < 30;
       const img = fig.querySelector("img");
       const oval = document.querySelector("main ul .bg-print");
       frames.push({ w: Math.round(fig.getBoundingClientRect().width), img: img ? getComputedStyle(img).opacity : "none", oval: oval ? getComputedStyle(oval).opacity : "none", skel: document.querySelectorAll("[data-skel]").length });
       return frames.length < 8;`,
      // What's measured is the layout and motion, not the network: the slide is ready, as it is after answering.
      { slideReady: true },
    );
    await expect(page.getByText(/You marked/).filter({ visible: true }).first()).toBeVisible();
    await page.waitForTimeout(300);
    const fs = await frames<{ w: number; img: string; oval: string; skel: number }>(page);
    expect(fs.length, `frames at ${viewport?.width}`).toBeGreaterThan(2);
    for (const f of fs) expect(f).toEqual({ ...fs.at(-1), img: "1", oval: "1", skel: 0 });
  });

  test("during the rewind the setup line shows once, in the overlay", async ({ page }) => {
    const q = seed!.questions.find((x) => x.match.setup);
    test.skip(!q, "needs a question with a setup line");
    await page.goto("/practice?set=seed");
    for (let i = 0; i < seed!.questions.indexOf(q!); i++) await page.getByRole("button", { name: "Skip for now" }).click();
    await page.getByRole("radio", { name: new RegExp(`^Option ${q!.choices.find((c) => c.label !== q!.answer)!.label},`) }).click();
    await page.getByRole("button", { name: "Check answer" }).click();
    await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();
    await expect(page.locator("[data-odometer]")).toHaveCount(1);
    // The overlay has it; the "Where <lecturer> is" line above the frame keeps its place unseen.
    await expect(page.getByText(q!.match.setup!, { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByText(/^Where .+ is:/)).toBeHidden();
    await expect(page.locator("[data-counter]")).toBeVisible({ timeout: 3000 });
    await expect(page.getByText(/^Where .+ is:/)).toBeVisible();
  });
});
