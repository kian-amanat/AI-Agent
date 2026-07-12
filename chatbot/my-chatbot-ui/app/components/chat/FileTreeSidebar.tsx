"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown, ChevronRight, File, Folder, FolderOpen,
  Loader2, RefreshCw, Search, X,
} from "lucide-react";
import { fetchWorkspaceFiles, type WorkspaceFileEntry } from "../../lib/api";

type TreeNode = {
  name:     string;
  path:     string;
  type:     "file" | "dir";
  children: TreeNode[];
};

function buildTree(entries: WorkspaceFileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  for (const entry of entries) {
    const parts  = entry.path.split("/");
    const name   = parts[parts.length - 1];
    const node: TreeNode = { name, path: entry.path, type: entry.type, children: [] };
    map.set(entry.path, node);

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parent     = map.get(parentPath);
      if (parent) parent.children.push(node);
      else root.push(node); // orphan — attach at root
    }
  }
  return root;
}

function TreeNode({
  node,
  depth,
  onFileClick,
  filter,
}: {
  node:        TreeNode;
  depth:       number;
  onFileClick: (path: string) => void;
  filter:      string;
}) {
  const [open, setOpen] = useState(depth === 0);

  const matchesFilter = !filter || node.path.toLowerCase().includes(filter.toLowerCase());
  const childrenMatch = node.children.some((c) =>
    !filter || c.path.toLowerCase().includes(filter.toLowerCase())
  );

  if (filter && !matchesFilter && !childrenMatch && node.type === "file") return null;
  if (filter && node.type === "dir" && !childrenMatch && !matchesFilter) return null;

  if (node.type === "file") {
    if (filter && !matchesFilter) return null;
    const ext = node.name.includes(".") ? node.name.split(".").pop() : "";
    return (
      <button
        onClick={() => onFileClick(node.path)}
        title={node.path}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-[3px] text-left text-[12px] text-white/55 transition-colors hover:bg-white/[0.04] hover:text-white/85 group"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <File className="h-3 w-3 shrink-0 text-white/25 group-hover:text-white/45" />
        <span className="min-w-0 truncate">{node.name}</span>
        {ext && (
          <span className="ml-auto shrink-0 text-[10px] text-white/20">{ext}</span>
        )}
      </button>
    );
  }

  const isOpenForced = filter ? childrenMatch : open;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-[3px] text-left text-[12px] font-medium text-white/60 transition-colors hover:bg-white/[0.03] hover:text-white/85"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {isOpenForced
          ? <ChevronDown  className="h-3 w-3 shrink-0 text-white/25" />
          : <ChevronRight className="h-3 w-3 shrink-0 text-white/20" />
        }
        {isOpenForced
          ? <FolderOpen className="h-3 w-3 shrink-0 text-[#ff8a3d]/60" />
          : <Folder     className="h-3 w-3 shrink-0 text-white/30" />
        }
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {isOpenForced && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              filter={filter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTreeSidebar({
  open,
  onClose,
  onFileSelect,
}: {
  open:         boolean;
  onClose:      () => void;
  onFileSelect: (path: string) => void;
}) {
  const [entries, setEntries]   = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading]   = useState(false);
  const [filter,  setFilter]    = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchWorkspaceFiles();
      setEntries(data);
    } catch (err) {
      console.error("FileTreeSidebar: failed to load files", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && entries.length === 0) void load();
  }, [open, entries.length, load]);

  const tree = useMemo(() => buildTree(entries), [entries]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 260, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="flex h-full shrink-0 flex-col overflow-hidden border-l border-white/[0.06] bg-[#141414]"
        >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
            <Folder className="h-3.5 w-3.5 shrink-0 text-[#ff8a3d]/70" />
            <span className="flex-1 text-[12px] font-semibold text-white/70">Files</span>
            <button
              onClick={() => void load()}
              title="Refresh"
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/[0.05] hover:text-white/70"
            >
              {loading
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <RefreshCw className="h-3 w-3" />
              }
            </button>
            <button
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/[0.05] hover:text-white/70"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          {/* Search */}
          <div className="relative px-2 py-2">
            <Search className="absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-white/20" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files…"
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-1.5 pl-7 pr-3 text-[12px] text-white/70 placeholder:text-white/22 outline-none focus:border-white/[0.10]"
            />
          </div>

          {/* Tree */}
          <div className="flex-1 overflow-y-auto px-1 pb-4">
            {loading && entries.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-white/25">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : tree.length === 0 ? (
              <p className="px-4 py-4 text-[12px] text-white/25">No files found.</p>
            ) : (
              tree.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  onFileClick={onFileSelect}
                  filter={filter}
                />
              ))
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
