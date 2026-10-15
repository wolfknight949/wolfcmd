import { describe, expect, it } from "vitest";

import { stateNotices } from "./state-notices";

const healthy = { readOnly: null, saveError: null, note: null };

describe("stateNotices", () => {
  it("n05 shows nothing while saving works", () => {
    expect(stateNotices(healthy, new Set())).toEqual([]);
  });

  it("n05 a failing save shows until it succeeds and can't be closed", () => {
    const [notice] = stateNotices({ ...healthy, saveError: "Access is denied" }, new Set(["save"]));
    expect(notice?.tone).toBe("warning");
    expect(notice?.dismissible).toBe(false);
    expect(notice?.text).toContain("Access is denied");
    expect(notice?.text).toContain("keeps trying");
  });

  it("n05 a read-only run says why, before any start note, and can be closed", () => {
    const health = { readOnly: "Saved by a newer WolfCmd.", saveError: null, note: "Backup." };
    const notices = stateNotices(health, new Set());
    expect(notices.map((n) => [n.tone, n.text])).toEqual([
      ["warning", "Saved by a newer WolfCmd."],
      ["info", "Backup."],
    ]);
    const closed = new Set(notices.map((n) => n.key));
    expect(stateNotices(health, closed)).toEqual([]);
    // A new reason shows again.
    expect(stateNotices({ ...health, readOnly: "Other." }, closed)).toHaveLength(1);
  });
});
