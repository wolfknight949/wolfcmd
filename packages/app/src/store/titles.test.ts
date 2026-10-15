// Live titles: kept while a panel is in the document, dropped once it leaves.
import type { Document } from "@wolfcmd/bindings";
import { afterEach, describe, expect, it } from "vitest";

import { leaf } from "../model/layout";
import { terminalPanel } from "../model/panels";
import { forgetTitles, setTitle, titles } from "./titles";

const doc = (panelIds: readonly string[]): Document => ({
  version: 2,
  active: "w1",
  workspaces: [
    {
      id: "w1",
      name: "",
      folder: null,
      activeTab: "t1",
      tabs: panelIds.map((id) => ({
        id: `t-${id}`,
        name: "",
        focused: id,
        layout: leaf(terminalPanel(id)),
      })),
    },
  ],
});

afterEach(() => {
  titles.setState({}, true);
});

describe("N-02 live titles", () => {
  it("n02_titles_forget: a closed panel's title is dropped, the others' kept", () => {
    setTitle("p1", "vim");
    setTitle("p2", "npm run dev");
    const before = titles.getState();
    forgetTitles(doc(["p1", "p2"]));
    expect(titles.getState()).toBe(before);
    forgetTitles(doc(["p2"]));
    expect(titles.getState()).toEqual({ p2: "npm run dev" });
  });
});
