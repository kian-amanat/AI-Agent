'use client';

import React, { useRef } from 'react';
import { motion, useScroll, useSpring, useTransform } from 'framer-motion';
import {
  Search,
  ClipboardList,
  Wrench,
  ShieldCheck,
  Lock,
  History,
  ArrowUpRight,
} from 'lucide-react';
import Link from 'next/link';

type Feature = {
  title: string;
  description: string;
};

type SecurityFeature = {
  icon: React.ElementType;
  title: string;
  description: string;
};

export default function LandingPage() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const featureTrackX = useTransform(scrollYProgress, [0, 1], ['0%', '-60%']);

  const features: Feature[] = [
    {
      title: 'Multi-task',
      description: 'Give it a list; it decomposes and executes every task',
    },
    {
      title: 'One-click Undo',
      description: 'Every change is snapshotted before it’s applied',
    },
    {
      title: 'Persistent memory',
      description: 'Learns your project’s patterns across sessions',
    },
    {
      title: 'Ask mode',
      description: 'Approve every plan before a single file changes',
    },
  ];

  const securityFeatures: SecurityFeature[] = [
    {
      icon: Lock,
      title: 'Local-first keys',
      description: 'API keys live in a local settings file, never on our servers',
    },
    {
      icon: History,
      title: 'Undo snapshots',
      description: 'Every edit is reversible from local history',
    },
    {
      icon: ShieldCheck,
      title: 'You hold the keys',
      description: 'In Ask mode, nothing executes without your explicit approval',
    },
  ];

  return (
    <div className="bg-[#08080a] text-white overflow-x-hidden min-h-screen">
      <motion.div
        className="fixed top-0 left-0 right-0 z-[60] h-1 origin-left bg-gradient-to-r from-[#ff5e4d] to-[#ffa03d]"
        style={{ scaleX }}
      />

      <motion.div
        animate={{ scale: [1, 1.12, 1], opacity: [0.08, 0.14, 0.08] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
        className="pointer-events-none absolute -top-40 -left-40 h-[560px] w-[560px] rounded-full bg-[#ff5e4d] blur-[160px]"
      />
      <motion.div
        animate={{ scale: [1, 1.08, 1], opacity: [0.05, 0.1, 0.05] }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
        className="pointer-events-none absolute top-96 right-0 h-[400px] w-[400px] rounded-full bg-[#ff8a3d] blur-[140px]"
      />

      <header className="fixed top-0 w-full z-50 backdrop-blur-md bg-white/[0.04] border-b border-white/[0.08]">
        <nav className="container mx-auto px-6 py-3 flex items-center">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#ff5e4d] to-[#ff8a3d] flex items-center justify-center">
              <span className="text-xs font-bold text-white">AI</span>
            </div>
            <span className="text-white font-semibold text-lg">Kodo</span>
          </div>

          <div className="flex-1 flex justify-center gap-8">
            <a
              href="#how-it-works"
              className="text-white/60 hover:text-[#ff8a3d] transition-colors text-sm tracking-wider uppercase"
            >
              How it works
            </a>
            <a
              href="#features"
              className="text-white/60 hover:text-[#ff8a3d] transition-colors text-sm tracking-wider uppercase"
            >
              Features
            </a>
            <a
              href="#security"
              className="text-white/60 hover:text-[#ff8a3d] transition-colors text-sm tracking-wider uppercase"
            >
              Security
            </a>
          </div>

          <Link
            href="/"
            className="rounded-2xl bg-gradient-to-r from-[#ff5e4d] to-[#ff8a3d] py-2 px-6 text-sm font-semibold text-white shadow-lg shadow-[#ff5e4d]/30 transition-all duration-300 hover:shadow-[#ff5e4d]/40 active:scale-[0.98] backdrop-blur-sm border border-white/10"
          >
            Open App
          </Link>
        </nav>
      </header>

      <div className="relative z-10 bg-[#08080a] rounded-b-3xl border-b border-white/10">
        <section className="min-h-screen flex items-center justify-center relative overflow-hidden">
          <div
            className="relative w-full h-full"
            style={{ transformStyle: 'preserve-3d' }}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const rx = -((e.clientY - r.top) / r.height - 0.5) * 10;
              const ry = ((e.clientX - r.left) / r.width - 0.5) * 10;

              document.querySelectorAll<HTMLElement>('.depth-layer').forEach((el, i) => {
                const depth = (i + 1) * 0.05;
                el.style.transform = `perspective(1000px) rotateX(${rx * depth}deg) rotateY(${ry * depth}deg)`;
              });
            }}
            onPointerLeave={() => {
              document.querySelectorAll<HTMLElement>('.depth-layer').forEach((el) => {
                el.style.transform = '';
              });
            }}
          >
            <div className="depth-layer absolute inset-0 m-auto w-[120%] h-[120%] -z-10 opacity-20">
              <div className="absolute inset-0 backdrop-blur-sm bg-white/[0.03] border border-white/[0.06] rounded-2xl" />
              <div className="absolute inset-4 grid grid-cols-12 gap-4 p-4">
                {Array.from({ length: 24 }).map((_, i) => (
                  <div key={i} className="h-4 w-full bg-white/[0.05] rounded" />
                ))}
              </div>
            </div>

            <div className="depth-layer absolute -top-20 -left-20 w-64 h-64 rounded-full bg-[#ff5e4d] blur-[80px] opacity-20 -z-5" />
            <div className="depth-layer absolute top-1/2 right-0 w-96 h-96 rounded-full bg-[#ff8a3d] blur-[100px] opacity-10 -z-5" />

            <div className="depth-layer max-w-4xl mx-auto px-6 text-center relative z-10">
              <motion.div
                initial="hidden"
                animate="visible"
                variants={{
                  hidden: {},
                  visible: {
                    transition: {
                      staggerChildren: 0.12,
                      delayChildren: 0.1,
                    },
                  },
                }}
              >
                <motion.h1
                  variants={{
                    hidden: { opacity: 0, y: 18 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  className="text-6xl md:text-8xl font-bold leading-[1.05] tracking-tight mb-6"
                >
                  Meet Kodo — the AI agent that{' '}
                  <span className="bg-gradient-to-r from-[#ff5e4d] to-[#ff8a3d] bg-clip-text text-transparent">
                    ships your code
                  </span>
                </motion.h1>

                <motion.p
                  variants={{
                    hidden: { opacity: 0, y: 18 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  className="text-white/60 text-lg md:text-xl max-w-2xl mx-auto mb-12 leading-relaxed"
                >
                  Kodo explores your codebase, plans surgical changes, applies them safely, and verifies everything — while you stay in control.
                </motion.p>

                <motion.button
                  variants={{
                    hidden: { opacity: 0, y: 18 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  className="group relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#ff5e4d] to-[#ff8a3d] py-4 px-8 text-sm font-semibold text-white shadow-lg shadow-[#ff5e4d]/30 transition-all duration-300 hover:shadow-[#ff5e4d]/40 active:scale-[0.98] backdrop-blur-sm border border-white/10"
                >
                  <div className="relative z-10 flex items-center gap-2">
                    <span>Start building</span>
                    <motion.span
                      initial={{ x: 0 }}
                      whileHover={{ x: 4 }}
                      transition={{ duration: 0.3, ease: 'easeOut' }}
                      className="inline-block"
                    >
                      →
                    </motion.span>
                  </div>
                  <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                </motion.button>
              </motion.div>
            </div>
          </div>
        </section>

        <section id="features" className="min-h-screen py-32 relative overflow-hidden">
          <div className="container mx-auto px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="text-5xl font-bold text-center mb-24"
            >
              <span className="bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
                Built to ship, not to demo
              </span>
            </motion.h2>

            <div ref={wrapperRef} className="relative h-[300vh]">
              <div className="sticky top-0 flex h-screen items-center overflow-hidden">
                <motion.div style={{ x: featureTrackX }} className="flex gap-8 pl-[10vw]">
                  {features.map((feature) => (
                    <FeatureCard key={feature.title} feature={feature} />
                  ))}
                </motion.div>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="py-32 bg-white/5 relative">
          <div className="container mx-auto px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="text-5xl font-bold text-center mb-24"
            >
              <span className="bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
                How it works
              </span>
            </motion.h2>

            <div className="max-w-3xl mx-auto relative">
              <motion.div
                initial={{ scaleY: 0 }}
                whileInView={{ scaleY: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 1.2, ease: 'easeInOut' }}
                className="absolute left-4 top-0 bottom-0 w-0.5 bg-gradient-to-b from-[#ff8a3d] to-transparent origin-top"
              />

              <motion.div
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: '-80px' }}
                variants={{
                  hidden: {},
                  visible: {
                    transition: {
                      staggerChildren: 0.2,
                      delayChildren: 0.1,
                    },
                  },
                }}
                className="space-y-20 relative z-10"
              >
                <StepCard
                  icon={<Search className="w-5 h-5" />}
                  title="Explore"
                  description="Reads only the files that matter, using code search and project memory"
                />
                <StepCard
                  icon={<ClipboardList className="w-5 h-5" />}
                  title="Plan"
                  description="Designs a minimal, surgical patch plan"
                />
                <StepCard
                  icon={<Wrench className="w-5 h-5" />}
                  title="Execute"
                  description="Applies changes with syntax validation before anything touches disk"
                />
                <StepCard
                  icon={<ShieldCheck className="w-5 h-5" />}
                  title="Verify"
                  description="Runs typecheck and lint, and retries automatically if something’s off"
                />
              </motion.div>
            </div>
          </div>
        </section>

        <section id="security" className="py-32 relative overflow-hidden">
          <div className="container mx-auto px-6">
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="text-5xl font-bold text-center mb-24"
            >
              <span className="bg-gradient-to-r from-[#ff5e4d] to-[#ff8a3d] bg-clip-text text-transparent">
                Your code never leaves your machine
              </span>
            </motion.h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
              {securityFeatures.map((feature) => (
                <SecurityCard key={feature.title} feature={feature} />
              ))}
            </div>
          </div>
        </section>
      </div>

      <CinematicFooter />
    </div>
  );
}

const FeatureCard = ({ feature }: { feature: Feature }) => {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rx = -((e.clientY - r.top) / r.height - 0.5) * 10;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 10;
    e.currentTarget.style.transform = `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  };

  const onLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.style.transform = '';
  };

  return (
    <motion.div
      ref={ref}
      variants={{
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="relative w-80 h-64 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-6 group hover:shadow-[0_20px_40px_rgba(255,138,61,0.3)] transition-all duration-300"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      style={{
        transformStyle: 'preserve-3d',
        transformOrigin: 'center',
      }}
    >
      <h3 className="text-xl font-semibold text-white mb-4">{feature.title}</h3>
      <p className="text-white/60">{feature.description}</p>
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.05] via-transparent to-white/[0.05] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none rounded-2xl" />
    </motion.div>
  );
};

const StepCard = ({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) => {
  const container = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.6,
        ease: [0.22, 1, 0.36, 1],
      },
    },
  };

  return (
    <motion.div variants={container} className="relative pl-16">
      <div className="absolute left-0 top-0 flex items-center justify-center w-10 h-10 rounded-full bg-gradient-to-br from-[#ff5e4d] to-[#ff8a3d]">
        {React.isValidElement(icon)
          ? React.cloneElement(icon, { className: 'w-5 h-5 text-white' })
          : icon}
      </div>
      <h3 className="text-2xl font-semibold text-white mb-3">{title}</h3>
      <p className="text-white/60 leading-relaxed">{description}</p>
    </motion.div>
  );
};

const SecurityCard = ({ feature }: { feature: SecurityFeature }) => {
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rx = -((e.clientY - r.top) / r.height - 0.5) * 10;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 10;
    e.currentTarget.style.transform = `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  };

  const onLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.style.transform = '';
  };

  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-2xl border border-white/[0.06] bg-white/[0.03] p-6 group hover:shadow-[0_20px_40px_rgba(255,138,61,0.3)] transition-all duration-300"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      style={{
        transformStyle: 'preserve-3d',
        transformOrigin: 'center',
      }}
    >
      <div className="flex items-center gap-4 mb-6">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#ff5e4d] to-[#ff8a3d] flex items-center justify-center">
          <feature.icon className="w-5 h-5 text-white" />
        </div>
        <h3 className="text-xl font-semibold text-white">{feature.title}</h3>
      </div>
      <p className="text-white/60">{feature.description}</p>
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.05] via-transparent to-white/[0.05] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none rounded-2xl" />
    </motion.div>
  );
};

function CinematicFooter() {
  return (
    <footer className="relative z-20 border-t border-white/10 bg-[#08080a]">
      <div className="container mx-auto px-6 py-12 flex flex-col md:flex-row items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#ff5e4d] to-[#ff8a3d] flex items-center justify-center">
              <span className="text-xs font-bold text-white">AI</span>
            </div>
            <span className="font-semibold text-white">Kodo</span>
          </div>
          <p className="text-white/50 text-sm">
            Build faster. Ship safer. Stay in control.
          </p>
        </div>

        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-medium text-white hover:bg-white/10 transition-colors"
        >
          Back to top
          <ArrowUpRight className="w-4 h-4" />
        </Link>
      </div>
    </footer>
  );
}