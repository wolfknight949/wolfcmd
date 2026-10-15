// N-03: Rename… from a workspace's context menu: one field with the current name selected; Enter
// renames, Esc cancels. An empty name gives the workspace its default name again (its folder's).
import { Button, Dialog, TextField } from "@wolfcmd/ui-kit";
import { type RefObject, useState } from "react";

export interface RenameDialogProps {
  readonly title: string;
  /** The name the user gave, or "" (then `placeholder` shows what it is called now). */
  readonly name: string;
  readonly placeholder: string;
  readonly onRename: (name: string) => void;
  readonly onClose: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}

export function RenameDialog({
  title,
  name,
  placeholder,
  onRename,
  onClose,
  returnFocus,
}: RenameDialogProps) {
  const [value, setValue] = useState(name);
  const rename = () => {
    onRename(value);
    onClose();
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      onSubmit={rename}
      returnFocus={returnFocus}
      footer={
        <>
          <Button variant="accent" submit>
            Rename
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <TextField
        autoFocus
        label="Name"
        value={value}
        placeholder={placeholder}
        hint="Empty: the default name"
        onChange={setValue}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
      />
    </Dialog>
  );
}
