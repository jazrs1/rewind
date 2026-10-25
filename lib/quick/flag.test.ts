import { describe, expect, it } from "vitest";
import { quickBuildOn } from "./flag.ts";
import { isDemoMode } from "../demo/guard.ts";

describe("the Quick build flag", () => {
  it("is off unless it is exactly 1", () => {
    expect(quickBuildOn({})).toBe(false);
    expect(quickBuildOn({ NEXT_PUBLIC_REWIND_QUICK_BUILD: "" })).toBe(false);
    expect(quickBuildOn({ NEXT_PUBLIC_REWIND_QUICK_BUILD: "true" })).toBe(false);
    expect(quickBuildOn({ NEXT_PUBLIC_REWIND_QUICK_BUILD: "0" })).toBe(false);
    expect(quickBuildOn({ NEXT_PUBLIC_REWIND_QUICK_BUILD: "1" })).toBe(true);
  });

  it("is off in this test environment by default", () => {
    expect(quickBuildOn()).toBe(false);
  });

  it("does not change demo mode", () => {
    expect(isDemoMode({ NODE_ENV: "production", NEXT_PUBLIC_REWIND_QUICK_BUILD: "1" })).toBe(true);
    expect(isDemoMode({ NODE_ENV: "development" })).toBe(false);
  });
});
