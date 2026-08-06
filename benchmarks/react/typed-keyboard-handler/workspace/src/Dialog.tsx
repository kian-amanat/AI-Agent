import { useState } from "react";

export function Dialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title] = useState("Settings");

  if (!open) return null;

  // TODO: close the dialog when the user presses Escape

  return (
    <div className="dialog" role="dialog">
      <h2>{title}</h2>
    </div>
  );
}
