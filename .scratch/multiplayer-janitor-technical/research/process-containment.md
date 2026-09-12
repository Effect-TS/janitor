# Process containment feasibility

Investigation for the remote repository execution fixture, 2026-09-11. No source changes, installs, or remote deployment were performed.

## Local evidence

The existing fixture image `localhost/janitor-repository-fixture:probe`, image ID `df143772c737`, derives from the pinned `cloudflare/sandbox:0.12.9` digest in the fixture Dockerfile. Disposable `docker run --rm --read-only` invocations showed:

- `unshare`, `nsenter`, `setpriv`, and `pgrep` exist. `unshare` is util-linux 2.37.2.
- `tini`, `dumb-init`, `python3`, `gcc`, `cc`, and `killall` were absent from the command lookup.
- `unshare --user --map-root-user --pid --fork /bin/sh -c 'echo $$'` succeeded and printed PID 1.
- `/sys/fs/cgroup` is mounted read-only. The presence of `cgroup.kill` and `cgroup.freeze` files does not establish permission to use them.
- `unshare --user --map-root-user --pid --fork --kill-child --mount-proc ...` failed with `mount /proc failed: Operation not permitted`.
- A shell used as namespace init launched a detached `setsid` shell, which scheduled output after 300 ms. Init exited after 50 ms. The delayed output did not appear during a further 500 ms wait. This is a small termination probe, not a complete adapter proof.

The detached-descendant probe was:

```sh
unshare --user --map-root-user --pid --fork --kill-child /bin/sh -c \
  'setsid /bin/sh -c "sleep 0.3; echo ESCAPED" & sleep 0.05; echo ROOT-DONE'
sleep 0.5
echo CHECK-DONE
```

Output contained `ROOT-DONE` and `CHECK-DONE`, with no `ESCAPED`.

## Candidate boundary

A PID namespace per bridge process invocation is a plausible deterministic descendant boundary. Linux kills the namespace's remaining processes when its init process terminates. `setsid` changes a process group/session and does not escape that namespace. Commands that launch background servers would lose them when the foreground command exits, which must be deliberate fixture and product behavior. See [Linux PID namespaces](https://www.man7.org/linux/man-pages/man7/pid_namespaces.7.html).

`unshare --fork --kill-child` provides parent-death handling for the namespace init child. A bridge would still need to await wrapper completion, distinguish startup failure from the command's exit, and prove cancellation, bridge death, and checkpoint ordering. The remount failure means `/proc` remains the outer view in the locally passing invocation. Process-inspection utilities and subprocess implementations need compatibility tests. See [unshare](https://man7.org/linux/man-pages/man1/unshare.1.html).

A subreaper alone adopts orphaned descendants; it does not automatically terminate them. It needs a native helper plus explicit descendant management, and does not itself provide the kernel namespace termination guarantee. The pinned image has no discovered ready-made init/subreaper helper. See [PR_SET_CHILD_SUBREAPER](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).

Writable delegated cgroups could supply a different boundary, but local evidence does not support their availability. Kernel cgroup v2 documents group killing and freezing; neither should be inferred from file existence. See [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html).

## Remote evidence and remaining uncertainty

Cloudflare documents rootless Docker-in-Docker, with privileged containers unavailable. This supports investigating user/PID namespaces but does not verify this exact invocation in the deployed fixture. The guide also uses a different image build, so it is not proof for the pinned fixture image. See [Cloudflare Docker-in-Docker](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/).

Before making this the contract, run the same namespace and detached-descendant checks remotely. Verify original command exit codes, stdin/stdout/stderr, cancellation, bridge death, and no descendants writing during checkpoint publication. Unsupported namespace creation must fail closed. Do not silently substitute process-group killing or a one-time `/proc` scan.

## Executed Cloudflare follow-up

The authorized remote foreground probe passed against the pinned Sandbox image. Detached-child delayed writes were prevented, and cancellation completed before freeze. See [raw result](remote-containment-result.json) and [cleanup evidence](remote-containment-cleanup.json). This establishes the tested namespace behavior remotely; native OpenCode shell semantics and process-inspection compatibility remain separate checks.
