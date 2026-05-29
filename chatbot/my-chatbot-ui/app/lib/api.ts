// src/api.ts

const BASE_URL = 'http://localhost:9000/api/agent';

export interface Session {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface Message {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  intent: string | null;
  created_at: string;
}

// List all sessions
export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${BASE_URL}/sessions`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.sessions;
}

// Get messages for a session
export async function fetchSessionMessages(sessionId: string): Promise<Message[]> {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.messages;
}

// Delete a session
export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
}

// Send a message (SSE stream)
export function sendMessage(
  message: string,
  sessionId: string | null,
  onChunk: (chunk: string) => void,
  onDone: (sessionId: string) => void,
  onError: (err: string) => void
): () => void {
  const controller = new AbortController();

  fetch(`${BASE_URL}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId }),
    signal: controller.signal,
  }).then(async (res) => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let returnedSessionId = sessionId ?? '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.type === 'start') {
            returnedSessionId = parsed.session_id ?? returnedSessionId;
          } else if (parsed.type === 'content') {
            onChunk(parsed.content);
          } else if (parsed.type === 'done') {
            onDone(returnedSessionId);
          } else if (parsed.type === 'error') {
            onError(parsed.error);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') onError(err.message);
  });

  return () => controller.abort();
}
