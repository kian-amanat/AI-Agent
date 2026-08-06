import { useState } from "react";
import { listCommands } from "../commands";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const commands = listCommands().filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase())
  );

  if (!open) return null;

  // TODO: close on Escape
  // TODO: run the selected command on Enter

  return (
    <div className="palette">
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul>
        {commands.map((c, i) => (
          <li key={c.id} className={i === selected ? "selected" : ""}>
            {c.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
