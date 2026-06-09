import { useState, useRef, useCallback } from "react";

interface UseVoiceInputReturn {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  isTranscribing: boolean;
  transcribedText: string;
  error: string | null;
  resetTranscription: () => void;
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribedText, setTranscribedText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = "audio/webm";
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to access microphone";
      setError(message);
      console.error("Microphone access error:", err);
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || !streamRef.current) {
        resolve(null);
        return;
      }

      const mediaRecorder = mediaRecorderRef.current;
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        streamRef.current?.getTracks().forEach((track) => track.stop());
        setIsRecording(false);
        resolve(audioBlob);
      };

      mediaRecorder.stop();
    });
  }, []);

  const transcribeAudio = useCallback(
    async (audioBlob: Blob, sessionId?: string): Promise<string> => {
      try {
        setIsTranscribing(true);
        setError(null);
        setTranscribedText("");

        const formData = new FormData();
        formData.append("audio", audioBlob, "recording.webm");
        if (sessionId) {
          formData.append("session_id", sessionId);
        }

        const response = await fetch("http://localhost:9000/api/agent/transcribe", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Transcription failed");
        }

        const data = await response.json();
        const text = data.transcribed_text || "";
        setTranscribedText(text);
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Transcription error";
        setError(message);
        console.error("Transcription error:", err);
        return "";
      } finally {
        setIsTranscribing(false);
      }
    },
    []
  );

  const resetTranscription = useCallback(() => {
    setTranscribedText("");
    setError(null);
  }, []);

  return {
    isRecording,
    startRecording,
    stopRecording,
    isTranscribing,
    transcribedText,
    error,
    resetTranscription,
  };
}

export async function handleVoiceInput(
  onTranscribed: (text: string) => void,
  sessionId?: string
): Promise<void> {
  const { useVoiceInput: hook } = await import("./useVoiceInput");
  // This is a helper for direct voice flow - use the hook above in components instead
}
