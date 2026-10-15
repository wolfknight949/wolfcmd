// N-03: the panel types every WolfCmd has: today the terminal. `TabView` draws cards through
// this registry unless given another; a plugin's type will register here the same way.
import { TERMINAL_TYPE } from "./TerminalType";
import { createPanelTypes } from "./types";

export const panelTypes = createPanelTypes();
panelTypes.register(TERMINAL_TYPE);
