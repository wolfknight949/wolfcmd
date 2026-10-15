// N-07: the settings controls: ToggleSwitch, Segmented and NumberBox.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NumberBox, parseNumber } from "./NumberBox";
import { Segmented } from "./Segmented";
import { ToggleSwitch } from "./ToggleSwitch";

afterEach(cleanup);

describe("N-07 ToggleSwitch", () => {
  it("n07_toggle_switch: a named switch that flips (N-01: no state words)", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ToggleSwitch aria-label="Smooth" checked={false} onChange={onChange} />,
    );
    const toggle = screen.getByRole("switch", { name: "Smooth" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toBe("");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<ToggleSwitch aria-label="Smooth" checked onChange={onChange} />);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("N-07 Segmented", () => {
  it("n07_segmented: one radio group; choosing a segment reports its value", () => {
    const onChange = vi.fn();
    render(
      <>
        <span id="cursor">Cursor</span>
        <Segmented
          labelledBy="cursor"
          value="bar"
          options={[
            { value: "bar", label: "Bar" },
            { value: "block", label: "Block" },
          ]}
          onChange={onChange}
        />
      </>,
    );
    expect(screen.getByRole("radiogroup", { name: "Cursor" })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Bar" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Block" }));
    expect(onChange).toHaveBeenCalledWith("block");
  });
});

function Box({ onChange }: { readonly onChange: (value: number) => void }) {
  const [value, setValue] = useState(14);
  return (
    <>
      <span id="size">Size</span>
      <NumberBox
        labelledBy="size"
        value={value}
        min={9}
        max={28}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </>
  );
}

describe("N-07 NumberBox", () => {
  it("n07_number_box: buttons and arrows step, typing commits on Enter in range", () => {
    const onChange = vi.fn();
    render(<Box onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Size" });
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenLastCalledWith(15);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(14);
    fireEvent.change(input, { target: { value: "40" } });
    expect(input.value).toBe("40");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(28);
    expect(input.value).toBe("28");
    // Not a number: the value comes back when the box loses the focus.
    fireEvent.change(input, { target: { value: "big" } });
    fireEvent.blur(input);
    expect(input.value).toBe("28");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("n07_parse_number: whole numbers in range", () => {
    expect(parseNumber(" 12 ", 9, 28)).toBe(12);
    expect(parseNumber("12.6", 9, 28)).toBe(13);
    expect(parseNumber("3", 9, 28)).toBe(9);
    expect(parseNumber("", 9, 28)).toBeUndefined();
    expect(parseNumber("1e3", 9, 28)).toBeUndefined();
  });
});
