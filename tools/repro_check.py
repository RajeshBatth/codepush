#!/usr/bin/env python3
"""Reproducible-build check for the OTA unit split.

Builds the same commit N times, each in a fresh checkout at a DIFFERENT path
(CI agents have different workspace paths, which is the usual source of
non-determinism), then compares the hashes of every file under the output dir.
Optionally compares against a reference file of hashes of the embedded bundles.

Example:
  python3 tools/repro_check.py --repo ~/work/monorepo --rev release/11.9 \
      --build-cmd "yarn build:bundles --platform android" --out-dir build/bundles \
      --runs 2 --env-b TZ=Asia/Kolkata --env-b LANG=C --reference base-hashes.json

Reference file format: {"<relative path under out-dir>": "<sha256 or md5 hex>"}
Exit code 0 = all runs identical (and match reference if given), 1 otherwise.
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile, time


def digest(path, algo):
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_tree(root, algos):
    out = {}
    for dirpath, _, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            out[rel] = {a: digest(full, a) for a in algos}
    return out


def run_build(repo, rev, build_cmd, out_dir, extra_env, workdir, install_cmd):
    checkout = os.path.join(workdir, "checkout")
    subprocess.run(["git", "clone", "--quiet", "--local", "--no-checkout", repo, checkout], check=True)
    subprocess.run(["git", "-C", checkout, "checkout", "--quiet", rev], check=True)
    env = dict(os.environ, **extra_env)
    if install_cmd:
        subprocess.run(install_cmd, shell=True, cwd=checkout, env=env, check=True)
    subprocess.run(build_cmd, shell=True, cwd=checkout, env=env, check=True)
    return hash_tree(os.path.join(checkout, out_dir), ALGOS)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, help="path to the git repo (monorepo)")
    ap.add_argument("--rev", default="HEAD", help="commit/tag/branch to build")
    ap.add_argument("--build-cmd", required=True, help="command that produces the bundles")
    ap.add_argument("--install-cmd", default="", help="optional command run before the build (e.g. yarn install --frozen-lockfile)")
    ap.add_argument("--out-dir", required=True, help="bundle output dir, relative to the repo root")
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--env-b", action="append", default=[], metavar="K=V",
                    help="env vars applied only to runs after the first (perturbation)")
    ap.add_argument("--sleep-between", type=int, default=2, help="seconds between runs (changes timestamps)")
    ap.add_argument("--reference", help="JSON of expected hashes (e.g. from base.json)")
    ap.add_argument("--keep", action="store_true", help="keep temp checkouts")
    args = ap.parse_args()

    env_b = dict(kv.split("=", 1) for kv in args.env_b)
    runs, tmps = [], []
    for i in range(args.runs):
        tmp = tempfile.mkdtemp(prefix=f"repro{i}-")
        tmps.append(tmp)
        print(f"[run {i + 1}/{args.runs}] building in {tmp}", flush=True)
        runs.append(run_build(os.path.abspath(os.path.expanduser(args.repo)), args.rev, args.build_cmd,
                              args.out_dir, env_b if i > 0 else {}, tmp, args.install_cmd))
        if i < args.runs - 1:
            time.sleep(args.sleep_between)

    ok = True
    files = sorted(set().union(*[set(r) for r in runs]))
    print(f"\n{len(files)} files compared across {args.runs} runs\n")
    for rel in files:
        entries = [r.get(rel) for r in runs]
        if any(e is None for e in entries):
            print(f"MISSING   {rel} (absent in run(s) {[i + 1 for i, e in enumerate(entries) if e is None]})")
            ok = False
        elif len({e["sha256"] for e in entries}) != 1:
            print(f"DIFFERS   {rel}")
            for i, e in enumerate(entries):
                print(f"            run{i + 1} sha256={e['sha256'][:16]} md5={e['md5'][:12]}")
            ok = False
        else:
            print(f"same      {rel}  sha256={entries[0]['sha256'][:16]} md5={entries[0]['md5'][:12]}")

    if args.reference:
        with open(args.reference) as f:
            ref = json.load(f)
        print("\nreference comparison:")
        for rel, want in sorted(ref.items()):
            got = runs[0].get(rel)
            if got is None:
                print(f"REF-MISSING {rel}")
                ok = False
                continue
            algo = "sha256" if len(want) == 64 else "md5"
            if got[algo] == want:
                print(f"ref-ok      {rel}")
            else:
                print(f"REF-DIFFERS {rel} ({algo}: expected {want[:16]}, got {got[algo][:16]})")
                ok = False

    if not args.keep:
        for t in tmps:
            shutil.rmtree(t, ignore_errors=True)
    print("\nRESULT:", "REPRODUCIBLE" if ok else "NOT REPRODUCIBLE")
    sys.exit(0 if ok else 1)


ALGOS = ("sha256", "md5")

if __name__ == "__main__":
    main()
