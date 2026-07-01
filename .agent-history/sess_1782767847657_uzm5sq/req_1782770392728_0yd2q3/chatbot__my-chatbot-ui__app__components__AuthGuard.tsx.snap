"use client";

import { useEffect, useState } from "react";
import { apiMe } from "@/app/lib/api";

export default function AuthGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const user = await apiMe();

        if (user) {
          setAuthorized(true);
        } else {
          setAuthorized(false);
        }
      } catch {
        setAuthorized(false);
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        Checking authentication...
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold">
          Please sign in first
        </h1>

        <button
          onClick={() => {
            window.location.href = "/login";
          }}
          className="rounded bg-blue-600 px-4 py-2 text-white"
        >
          Go to Login
        </button>
      </div>
    );
  }

  return <>{children}</>;
}