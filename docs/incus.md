# Incus sandbox

Run the agent inside an [Incus](https://linuxcontainers.org/incus/) system
container.

```bash
# Not offered by default — see "Verification status" immediately below.
KODO_ENABLE_UNVERIFIED_INCUS=1 kodo run "..." --sandbox incus
KODO_ENABLE_UNVERIFIED_INCUS=1 kodo chat --sandbox incus
```

## Verification status — read this first

**`--sandbox incus` is NOT offered by default.** `kodo --help` lists only
`host` and `docker`, and asking for Incus without the opt-in above is refused
with an explanation. This is not a capability check — Incus may work perfectly
on your machine — it is a *claims* check. `--sandbox` is a security promise,
and Kodo will not imply that the same evidence stands behind Incus as behind
Docker when it does not.


**IncusRuntime is implemented but has NOT been verified against a live Incus
daemon.** Incus was not installed on the machine where it was written and
tested, so `backend1/tests/incusRuntime.test.mjs` **skips** its live section
there rather than passing vacuously.

What that means concretely:

| Claim | Status |
|---|---|
| Contract completeness, fail-closed behaviour, `derive()` refusal | **Verified** — those tests run everywhere. |
| Processes execute inside the instance | **Not verified** |
| Files written through the runtime land in the instance, not the host | **Not verified** |
| Host files invisible to the runtime | **Not verified** |
| Worktrees inside the instance | **Not verified** |
| `verifyIsolation()` against a real daemon | **Not verified** |

This is safe by construction rather than by promise: `createRuntime()` refuses
to start any sandbox whose `verifyIsolation()` does not empirically return
`isolated: true`. On a machine without a working Incus, `--sandbox incus` fails
closed with a real error. It cannot silently run on your host.

Treat Incus as **reviewed but unproven**. Docker is the verified path today.

If you run the tests on a machine with Incus, please record the daemon version,
image and results here.

## Prerequisites

- Incus installed and the daemon running (`incus info` must succeed).
- A configured storage pool and profile (`incus admin init`).
- Linux. Incus does not run natively on macOS.

```bash
kodo doctor
```

will list `incus` under available sandboxes only when the daemon actually
answers.

## Usage

```bash
kodo run "run the migration and verify it" --sandbox incus
```

Kodo will:

1. `incus launch images:debian/12 kodo-<random>`
2. Wait for the instance to actually be usable — `launch` returns before init
   has finished, and a first `exec` would otherwise fail confusingly.
3. Detach the default NIC unless networking was requested.
4. Attach your workspace as a disk device at `/workspace`.
5. Verify isolation empirically, and refuse to proceed if it cannot.

Choose the image with:

```bash
KODO_INCUS_IMAGE=images:ubuntu/24.04 kodo run "..." --sandbox incus
```

## How the workspace is handled

Attached as a disk device at `/workspace`. All file operations go through
`incus exec` — never through `incus file push/pull`, which is a host-side
transfer API and would reintroduce the same ambiguity about "did this really
happen inside the container" that the Docker bind-mount shortcut does.

## Cleanup

The instance is deleted when the run finishes, including on failure. If one is
ever left behind:

```bash
incus list | grep kodo-
incus delete --force kodo-<name>
```

## Known limitation: unprivileged bind mounts

Unprivileged Incus containers commonly need idmap configuration before a host
directory can be attached. If the workspace mount fails, Kodo says so
explicitly rather than starting an instance that cannot see your project:

```
Could not mount the workspace into the Incus instance: …
Unprivileged Incus containers often need idmap configuration for host bind mounts.
```

Either configure `raw.idmap` on the profile, or run Kodo's Incus sandbox with a
privileged profile — understanding what that gives up.

## Failure behaviour

Identical to Docker: if the daemon is missing, the instance will not start, or
isolation cannot be proven, the run fails with exit code `5` and Kodo does not
fall back to the host.
