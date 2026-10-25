// /practice in a browser without the Rewind extension (audit #4): the rewind says so and shows what he
// said, and Play, Space, J, L, -10 and the scrub bar act on that transcript instead of doing nothing.
// Desktop (1280) only. Invented fixture (lib/pipeline/fixtures/practice-real.ts): clip 10:00 to 10:40.
import { expect, test } from "./test";
import { fixtureOutput } from "../lib/pipeline/fixtures/practice-real";

const [withCode] = fixtureOutput.questions;
const FIRST = "The new value goes in the next free slot at the bottom.";
const SECOND = "Then it swaps with its parent while it is smaller than the parent.";
const LAST = "That is why insert is logarithmic in the number of values.";

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop (1280) only");
  await page.route(/^https:\/\/([a-z0-9-]+\.)*zoom\.us\//, (route) => route.abort());
  // No extension: nothing answers chrome.runtime.sendMessage.
  await page.addInitScript(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
  });
});

test("without the extension the rewind shows the transcript, and the controls move through it", async ({ page }) => {
  await page.goto("/practice?set=e2e-fixture");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(withCode.stem);
  const wrong = withCode.choices.find((c) => c.label !== withCode.answer)!;
  await page.getByRole("radio", { name: new RegExp(`^Option ${wrong.label},`) }).click();
  await page.getByRole("button", { name: "Check answer" }).click();
  await page.getByRole("button", { name: /^Rewind to .+'s explanation$/ }).click();

  const player = page.getByRole("region", { name: "Lecture clip" });
  await expect(player.getByRole("alert")).toHaveText(/^The Rewind extension isn't installed, so here's what (Dr\. Fake )?Lee said:$/);
  const transcript = player.getByRole("list", { name: "Transcript" });
  await expect(transcript).toBeVisible();
  const currentLine = transcript.locator('[aria-current="true"]');
  await expect(currentLine).toContainText(FIRST);
  const live = player.locator("[aria-live]");

  // Space and Play say why nothing plays, aloud and on screen.
  await page.locator("body").press("Space");
  await expect(live).toHaveText(/can't play here; the transcript below follows the clip/);
  await expect(player.locator("[data-cant-play]")).toBeVisible();
  // With no recording the Play key is disabled, and says why (the alert above the transcript).
  const play = player.getByRole("button", { name: "Play clip" });
  await expect(play).toBeDisabled();
  await expect(play).toHaveAccessibleDescription(/^The Rewind extension isn't installed/);
  await expect(live).toHaveText(/can't play here/);

  // L and J step 10 s through the transcript: 10:00 -> 10:20 -> 10:10, and say the line.
  await page.locator("body").press("l");
  await page.locator("body").press("l");
  await expect(currentLine).toContainText(SECOND);
  await expect(live).toHaveText(`10:12: ${SECOND}`);
  await page.locator("body").press("j");
  await expect(currentLine).toContainText(FIRST);
  await player.getByRole("button", { name: "Back 10 seconds" }).click();
  await expect(currentLine).toContainText(FIRST);

  // The scrub bar is usable: End goes to the clip's end, a click in its middle to 10:20.
  const slider = player.getByRole("slider", { name: "Clip position" });
  await expect(slider).not.toHaveAttribute("aria-disabled", "true");
  await slider.focus();
  await slider.press("End");
  await expect(currentLine).toContainText(LAST);
  await expect(slider).toHaveAttribute("aria-valuenow", "40");
  const b = (await slider.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(slider).toHaveAttribute("aria-valuenow", "20");
  await expect(currentLine).toContainText(SECOND);

  // A line in the transcript moves the reading position there.
  await transcript.getByRole("button", { name: new RegExp(FIRST.replace(/\./g, "\\.")) }).click();
  await expect(currentLine).toContainText(FIRST);
  await page.screenshot({ path: ".cache/shots/no-extension-1280.png" });
});
