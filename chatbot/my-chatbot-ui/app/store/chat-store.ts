import { create } from "zustand";

export interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  streaming?: boolean;
}

interface ChatStore {
  sessionId: string | null;

  messages: UIMessage[];

  isSending: boolean;

  setSessionId: (id: string | null) => void;

  addMessage: (msg: UIMessage) => void;

  updateMessage: (id: string, content: string) => void;

  setSending: (v: boolean) => void;

  clear: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  sessionId: null,

  messages: [],

  isSending: false,

  setSessionId: (id) => set({ sessionId: id }),

  addMessage: (msg) =>
    set((s) => ({
      messages: [...s.messages, msg],
    })),

  updateMessage: (id, content) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id
          ? {
              ...m,
              content,
            }
          : m
      ),
    })),

  setSending: (v) => set({ isSending: v }),

  clear: () =>
    set({
      messages: [],
      sessionId: null,
    }),
}));