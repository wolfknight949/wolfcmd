// N-06: the items of the bar on the window's right edge, as a registry. The bar draws what is
// registered, in `order`; it knows no item by name, so plugins' buttons can join the built-in
// Add and Agents buttons later through the same `register`. N-07: an item can sit at the bar's
// bottom (Settings), like the gear at the foot of an activity bar.
import type { ComponentType } from "react";

import type { Actions } from "../actions";
import { createRegistry, type Registered, type Registry } from "./registry";

/** What every bar item's component gets. */
export interface BarItemProps {
  readonly actions: Actions;
}

export interface BarItem extends Registered {
  /** Draws the item (usually a `BarButton`, maybe with its menu or flyout). */
  readonly Component: ComponentType<BarItemProps>;
  /** N-07: the group it sits in; `bottom` items sit at the bar's foot (default: `top`). */
  readonly placement?: "top" | "bottom";
}

export type BarRegistry = Registry<BarItem>;

export const createBarRegistry = (): BarRegistry => createRegistry<BarItem>("bar item");

/** N-07: the items split by placement, each group in order. */
export function barGroups(items: readonly BarItem[]): {
  readonly top: readonly BarItem[];
  readonly bottom: readonly BarItem[];
} {
  return {
    top: items.filter((item) => item.placement !== "bottom"),
    bottom: items.filter((item) => item.placement === "bottom"),
  };
}
