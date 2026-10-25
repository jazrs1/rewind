// The static design lint on invented snippets: each rule catches its case and lets the token form through.
import { describe, expect, it } from "vitest";
import { fontFindings, hexFindings, motionFindings, pronounFindings, typeFindings } from "./lint.ts";

describe("design lint", () => {
  it("raw hex outside @theme fails; tokens, @theme and url(#id) pass", () => {
    expect(hexFindings("a.tsx", `<rect fill="#3B4043" />`, false).map((f) => f.text)).toEqual(["#3B4043"]);
    expect(hexFindings("a.tsx", `<rect fill="var(--color-pencil)" clipPath="url(#abc123)" />`, false)).toEqual([]);
    const css = `@theme static {\n  --color-x: #123456;\n}\n.a { color: #fff; }\n/* #abcdef in a comment */`;
    expect(hexFindings("g.css", css, true).map((f) => [f.text, f.line])).toEqual([["#fff", 4]]);
  });

  it("fonts outside the four fail", () => {
    expect(fontFindings("a.css", `.x { font-family: Arial, sans-serif; }`)).toHaveLength(1);
    expect(fontFindings("a.tsx", `className="font-[Comic_Sans]"`)).toHaveLength(1);
    expect(fontFindings("a.css", `.x { font-family: var(--font-serif); }`)).toEqual([]);
  });

  it("durations and easings outside the tokens fail", () => {
    expect(motionFindings("a.tsx", `className="transition duration-300 ease-[cubic-bezier(1,0,0,1)]"`, false).map((f) => f.text)).toEqual(["duration-300", "ease-[cubic-bezier(1,0,0,1)]"]);
    expect(motionFindings("a.tsx", `className="duration-150 delay-200"`, false)).toEqual([]);
    expect(motionFindings("a.tsx", `el.animate(k, { duration: 250, easing: "ease-in" })`, false)).toHaveLength(2);
    expect(motionFindings("a.tsx", `el.animate(k, { duration: DUR[3], easing: EASE.out })`, false)).toEqual([]);
    expect(motionFindings("g.css", `.a { animation: x 400ms ease-out; }`, true)).toHaveLength(1);
    expect(motionFindings("g.css", `.a { animation: x var(--dur-2) var(--ease-out); }\n.b { animation-duration: 0.01ms !important; }`, true)).toEqual([]);
  });

  it("an @theme block declares only the motion tokens, at their values (--stagger-stop is the tape's 40 ms)", () => {
    expect(motionFindings("t.css", `@theme static {\n  --stagger-stop: 40ms;\n  --stagger: 60ms;\n}\n.a { animation: x var(--dur-3) var(--ease-settle) calc(var(--i) * var(--stagger-stop)); }`, true)).toEqual([]);
    expect(motionFindings("t.css", `@theme static {\n  --stagger-stop: 45ms;\n  --dur-slow: 500ms;\n}`, true).map((f) => [f.text, f.line])).toEqual([
      ["--stagger-stop: 45ms", 2],
      ["--dur-slow: 500ms", 3],
    ]);
  });

  it("type sizes off the scale are listed; serif question sizes may sit in 22–30", () => {
    expect(typeFindings("a.tsx", `className="text-[14px]"`).map((f) => f.text)).toEqual(["text-[14px]"]);
    expect(typeFindings("a.tsx", `className="text-[15px]"`)).toEqual([]);
    expect(typeFindings("a.tsx", `className="font-serif text-[25px]"`)).toEqual([]);
  });
});

describe("pronouns (no he/him/his for professors in UI copy)", () => {
  it("flags he, him and his in UI strings and JSX text, not in comments or other words", () => {
    expect(pronounFindings("components/a.tsx", `const l = "Hear how he explains it";`)).toHaveLength(1);
    expect(pronounFindings("components/a.tsx", `<p>Rewind to his explanation</p>`)).toHaveLength(1);
    expect(pronounFindings("components/a.tsx", "const n = `ask him`;")).toHaveLength(1);
    expect(pronounFindings("components/a.tsx", `// he said so\nconst l = "the theme, this, help";`)).toEqual([]);
    expect(pronounFindings("components/a.tsx", `const l = "Kapoor explains this at 57:43";`)).toEqual([]);
  });
  it("skips the Ask tab's files", () => {
    expect(pronounFindings("components/ask/Ask.tsx", `const l = "he said";`)).toEqual([]);
  });
});
