'use client';

import React from 'react';
import { useRef, useState } from 'react';
import { Shield, Lock, Eye, CheckCircle } from 'lucide-react';

interface SecurityCardProps {
  title?: string;
  description?: string;
  features?: string[];
}

export function SecurityCard({
  title = 'Enterprise-Grade Security',
  description = 'Your data is protected with industry-leading encryption and security protocols.',
  features = [
    'End-to-end encryption',
    'SOC 2 Type II compliant',
    'Zero-knowledge architecture',
    'Regular security audits',
  ],
}: SecurityCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [tiltStyle, setTiltStyle] = useState<React.CSSProperties>({});
  const [glarePosition, setGlarePosition] = useState({ x: 50, y: 50 });

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;

    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const rotateX = ((y - centerY) / centerY) * -10;
    const rotateY = ((x - centerX) / centerX) * 10;

    setTiltStyle({
      transform: `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`,
      transition: 'transform 0.1s ease-out',
    });

    setGlarePosition({
      x: (x / rect.width) * 100,
      y: (y / rect.height) * 100,
    });
  };

  const handlePointerLeave = () => {
    setTiltStyle({
      transform: 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)',
      transition: 'transform 0.5s ease-out',
    });
  };

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className="relative w-full max-w-md mx-auto rounded-2xl overflow-hidden cursor-pointer"
      style={tiltStyle}
    >
      {/* Gradient Border */}
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-orange-400 via-coral-500 to-amber-400 p-[1px]">
        <div className="w-full h-full rounded-2xl bg-[#0a0a0f]" />
      </div>

      {/* Glassmorphism Content */}
      <div className="relative p-8 backdrop-blur-xl bg-white/5 border border-white/10 rounded-2xl shadow-2xl">
        {/* Glare Overlay */}
        <div
          className="absolute inset-0 rounded-2xl pointer-events-none opacity-0 hover:opacity-100 transition-opacity duration-300"
          style={{
            background: `radial-gradient(circle at ${glarePosition.x}% ${glarePosition.y}%, rgba(255,255,255,0.15) 0%, transparent 60%)`,
          }}
        />

        {/* Icon */}
        <div className="mb-6">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center shadow-lg">
            <Shield className="w-7 h-7 text-white" />
          </div>
        </div>

        {/* Title */}
        <h3 className="text-2xl font-bold text-white mb-3">{title}</h3>

        {/* Description */}
        <p className="text-white/60 text-sm leading-relaxed mb-6">{description}</p>

        {/* Features List */}
        <div className="space-y-3">
          {features.map((feature, index) => (
            <div key={index} className="flex items-center gap-3">
              <CheckCircle className="w-4 h-4 text-orange-400 flex-shrink-0" />
              <span className="text-white/80 text-sm">{feature}</span>
            </div>
          ))}
        </div>

        {/* Decorative Elements */}
        <div className="absolute top-4 right-4 flex gap-2">
          <Lock className="w-4 h-4 text-white/20" />
          <Eye className="w-4 h-4 text-white/20" />
        </div>
      </div>
    </div>
  );
}