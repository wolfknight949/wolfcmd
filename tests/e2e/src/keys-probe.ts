// N-02: where the keyboard goes. A probe in the page logs every key with the element it reached,
// every focus change (with the script that moved the focus, if one did) and the text each
// `pty_write` carried (Tauri's invoke is a fetch of ipc.localhost), so a scenario can check that
// every key it typed reached the terminal it meant, and say where a lost one went.
import type { Page } from "playwright-core";

import { flat, screen } from "./ui";
import { waitFor } from "./harness";

interface Probe {
  readonly log: string[];
  readonly writes: string[];
}

/** Installs the probe (once per page load). */
export async function installKeysProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as { __wcKeysProbe?: Probe };
    if (host.__wcKeysProbe !== undefined) return;
    const probe: Probe = { log: [], writes: [] };
    host.__wcKeysProbe = probe;
    const start = performance.now();
    const at = () => (performance.now() - start).toFixed(1).padStart(9);
    /** An element as the log names it: `terminal <panel>`, or its tag, role and name. */
    const name = (target: EventTarget | null): string => {
      if (!(target instanceof Element)) return target === null ? "nothing" : "the window";
      if (target === document.body) return "body";
      const panel = target.closest<HTMLElement>("[data-panel]")?.dataset.panel;
      if (target.classList.contains("xterm-helper-textarea") && panel !== undefined) {
        return `terminal ${panel}`;
      }
      const label =
        target.getAttribute("aria-label") ??
        target.getAttribute("title") ??
        target.getAttribute("data-wc-title") ??
        "";
      const role = target.getAttribute("role") ?? target.tagName.toLowerCase();
      return `<${role}${label === "" ? "" : ` "${label}"`}${panel === undefined ? "" : ` in ${panel}`}>`;
    };
    const caller = () =>
      (new Error().stack ?? "")
        .split("\n")
        .slice(3, 9)
        .map((line) => line.trim().replace(/^at /, ""))
        .join(" < ");
    document.addEventListener(
      "focusin",
      (event) => {
        probe.log.push(
          `${at()} focus -> ${name(event.target)} (from ${name(event.relatedTarget)})`,
        );
      },
      true,
    );
    // The originals, called with the element as `this`.
    const focus: (this: HTMLElement, options?: FocusOptions) => void = Reflect.get(
      HTMLElement.prototype,
      "focus",
    );
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      if (this !== document.activeElement) {
        probe.log.push(`${at()} focus() ${name(this)} by ${caller()}`);
      }
      focus.call(this, options);
    };
    const blur: (this: HTMLElement) => void = Reflect.get(HTMLElement.prototype, "blur");
    HTMLElement.prototype.blur = function (this: HTMLElement) {
      probe.log.push(`${at()} blur() ${name(this)} by ${caller()}`);
      blur.call(this);
    };
    window.addEventListener(
      "keydown",
      (event) => {
        probe.log.push(
          `${at()} key ${JSON.stringify(event.key)} -> ${name(document.activeElement)}`,
        );
      },
      true,
    );
    const fetchIpc = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("ipc.localhost/pty_write") && typeof init?.body === "string") {
        try {
          const { args } = JSON.parse(init.body) as {
            args?: { sessionId: number; seq: number; data: string };
          };
          if (args !== undefined) {
            probe.writes.push(
              `session ${String(args.sessionId)} #${String(args.seq)} ${JSON.stringify(args.data)}`,
            );
          }
        } catch {
          // Not ours to read.
        }
      }
      return fetchIpc(input, init);
    };
  });
}

async function probeOf(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __wcKeysProbe?: Probe }).__wcKeysProbe;
    return { log: [...(probe?.log ?? [])], writes: [...(probe?.writes ?? [])] };
  });
}

let serial = 0;

/** A long line nobody else types: letters, digits and dashes (nothing a shell would expand). */
function token(label: string): string {
  serial += 1;
  const base = `typed-${label}-${String(serial)}-`;
  let text = base;
  while (text.length < 72) text += Math.random().toString(36).slice(2);
  return text.slice(0, 72);
}

/**
 * Types `echo <a long token>` and Enter at once (no wait before the first key), then checks that
 * every key reached `panel`'s terminal and that its shell echoed the token exactly. The error
 * shows where the keys went.
 */
export async function typeInto(page: Page, panel: string, label: string): Promise<void> {
  const from = await probeOf(page);
  const text = token(label);
  await page.keyboard.type(`echo ${text}`);
  await page.keyboard.press("Enter");
  const expected = `terminal ${panel}`;
  const report = async () => {
    const now = await probeOf(page);
    return [
      `--- keys and focus (${label}) ---`,
      ...now.log.slice(Math.max(0, from.log.length - 5)),
      "--- writes ---",
      ...now.writes.slice(from.writes.length),
    ].join("\n");
  };
  const keys = (await probeOf(page)).log
    .slice(from.log.length)
    .filter((entry) => entry.includes(' key "'));
  const astray = keys.filter((entry) => !entry.endsWith(`-> ${expected}`));
  if (astray.length > 0) {
    throw new Error(`${String(astray.length)} key(s) missed ${expected}\n${await report()}`);
  }
  // The shell echoes the token on the row after the command (rows run together).
  try {
    await waitFor(
      `the echo of ${text}`,
      async () => flat(await screen(page, panel)).includes(`${text}${text}`),
      20_000,
    );
  } catch (error) {
    throw new Error(
      `${String(error)}\n--- screen ---\n${await screen(page, panel)}\n${await report()}`,
      { cause: error },
    );
  }
}
