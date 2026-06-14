'use client';

import React from 'react';
import LoginForm from '../components/LoginForm';

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#161616] font-sans p-4">
      <LoginForm />
    </div>
  );
}