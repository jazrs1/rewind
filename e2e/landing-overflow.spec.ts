import { expect, test } from "@playwright/test";

// John saw the sample question card cut off at the right edge between 1280 and 1920 px. Nothing on the landing may
// extend past the viewport, and the card keeps the same margin on the right as the page has on the left.
for (const width of [1280, 1440, 1600, 1920]) {
  test(`landing at ${width} px: nothing extends past the viewport`, async ({ page, isMobile }) => {
    test.skip(!!isMobile, "desktop widths only");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.locator('[aria-label="Sample question"]').waitFor();
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const past = [...document.querySelectorAll("body *")]
        .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > vw + 0.5; })
        .map((el) => el.tagName.toLowerCase());
      const card = document.querySelector('[aria-label="Sample question"]')!.getBoundingClientRect();
      const left = document.querySelector("main h1")!.getBoundingClientRect().left;
      return { vw, sw: document.documentElement.scrollWidth, past, rightGap: vw - card.right, left };
    });
    expect(r.past).toEqual([]);
    expect(r.sw).toBeLessThanOrEqual(r.vw);
    expect(r.rightGap).toBeGreaterThanOrEqual(r.left - 1);
  });
}
