// The extension's download page: the button downloads the zip built from extension/ (with the site's origins), the
// three install steps, the demo note; the landing page links to it, and the privacy page says what it reads.
import { inflateRawSync } from "node:zlib";
import { expect, test } from "./test";

test("/extension: the download is the extension's zip, with three install steps and the demo note", async ({ page }) => {
  await page.goto("/extension");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The Rewind extension");
  const download = page.getByRole("link", { name: "Download the Rewind extension" });
  await expect(download).toHaveAttribute("href", "/extension/rewind-extension.zip");
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(file.suggestedFilename()).toBe("rewind-extension.zip");
  const zip = Buffer.from(await (await page.request.get("/extension/rewind-extension.zip")).body());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  // The manifest inside lists the site's origins.
  const at = zip.indexOf(Buffer.from("rewind-extension/manifest.json"));
  expect(at).toBeGreaterThan(0);
  const local = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at);
  const size = zip.readUInt32LE(local + 18);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const manifest = JSON.parse(inflateRawSync(zip.subarray(start, start + size)).toString("utf8"));
  expect(manifest.externally_connectable.matches).toEqual(expect.arrayContaining(["https://rewindit.org/*", "https://www.rewindit.org/*"]));

  const steps = page.locator("[data-install-steps] li");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText("Unzip");
  await expect(steps.nth(1)).toContainText("chrome://extensions");
  await expect(steps.nth(1)).toContainText("Developer mode");
  await expect(steps.nth(2)).toContainText("Load unpacked");
  await expect(page.locator("[data-extension-demo-note]")).toContainText("You don't need it for the demo.");
});

test("the landing page links to the extension page; the privacy page covers the extension", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Import your own course: runs on your computer for now (beta)" }).click();
  await expect(page).toHaveURL(/\/extension$/);
  await page.getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  for (const heading of ["What the extension reads", "Course content stays on your device", "Who processes text", "What Rewind's server stores", "Delete my data", "Contact"]) {
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  }
  await expect(page.locator("main:visible")).toContainText("Anthropic (Claude)");
  await expect(page.locator("main:visible")).toContainText("Google (Gemini)");
});
