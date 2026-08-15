# Kodo in a container.
#
#   docker build -t kodo/kodo .
#   docker run --rm -it -v "$PWD:/workspace" kodo/kodo
#   docker run --rm -it -v "$PWD:/workspace" -p 4173:4173 kodo/kodo ui start --host 0.0.0.0 --yes-i-know
#
# The container IS the isolation boundary. Kodo is an agent that edits files and
# runs shell commands; running it in a container means the only part of your
# machine it can reach is the directory you explicitly mounted. That is the
# whole security proposition, so nothing here weakens it:
#
#   * Runs as a non-root user. An agent with root inside the container can write
#     root-owned files into your mounted workspace, which you then cannot delete
#     without sudo on the host.
#   * No --privileged, no docker.sock mount, no host networking in any documented
#     invocation. Mounting the Docker socket would hand the agent the ability to
#     start a privileged container and escape entirely — it is not a convenience,
#     it is the removal of the boundary.
#   * Credentials arrive by environment variable at run time and are never baked
#     into a layer. An image layer is not a secret store.

FROM node:22-bookworm-slim

# git: the agent inspects repository state and it is how you undo its work.
# ca-certificates: TLS to the model provider.
# ripgrep: the agent's search tool falls back to something much slower without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      ripgrep \
      python3 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    KODO_HOME=/home/kodo/.kodo \
    KODO_CORE_PATH=/opt/kodo/backend1/core/index.mjs

WORKDIR /opt/kodo

# Dependencies first, as their own layer — source edits should not re-install
# node_modules on every build.
COPY backend1/package.json backend1/package-lock.json ./backend1/
RUN npm --prefix backend1 ci --omit=dev

COPY backend1/ ./backend1/
COPY cli/ ./cli/
COPY package.json ./

RUN ln -s /opt/kodo/cli/bin/kodo.mjs /usr/local/bin/kodo \
 && chmod +x /opt/kodo/cli/bin/kodo.mjs

# A real user, with a home it owns. `node` already exists in this base image but
# a dedicated user makes the intent explicit and the UID stable.
RUN useradd --create-home --uid 10001 --shell /bin/bash kodo \
 && mkdir -p /workspace /home/kodo/.kodo \
 && chown -R kodo:kodo /home/kodo /workspace

USER kodo
WORKDIR /workspace

# The UI server inside the container must bind 0.0.0.0 to be reachable through
# a published port — the container's network namespace is the boundary, not the
# loopback interface. Kodo still requires --yes-i-know for that bind, so the
# decision stays explicit and visible in the command you typed.
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD kodo status >/dev/null 2>&1 || exit 1

ENTRYPOINT ["kodo"]
CMD []
