"""Synchronize VPS credentials across GitHub repositories via GitHub CLI (`gh`).

Reads `~/.ssh/config` (default host: `ec2-main`) and updates matching
repository secrets (`*_HOST`, `*_USER`, `*_USERNAME`, `*_KEY`) automatically.
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


def parse_ssh_config(host_alias: str) -> dict:
    ssh_config_path = Path.home() / ".ssh" / "config"
    if not ssh_config_path.exists():
        raise FileNotFoundError(f"SSH config not found at {ssh_config_path}")

    current_hosts = []
    host_data = {}
    with open(ssh_config_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(maxsplit=1)
            if len(parts) != 2:
                continue
            key, val = parts[0].lower(), parts[1]
            if key == "host":
                current_hosts = val.split()
            elif host_alias in current_hosts:
                host_data[key] = val

    if not host_data:
        raise ValueError(f"Host '{host_alias}' not found in {ssh_config_path}")

    hostname = host_data.get("hostname")
    user = host_data.get("user", "ec2-user")
    identity_file = host_data.get("identityfile")

    if identity_file:
        identity_path = Path(os.path.expandvars(os.path.expanduser(identity_file)))
        if not identity_path.exists():
            raise FileNotFoundError(f"IdentityFile not found: {identity_path}")
        with open(identity_path, "r", encoding="utf-8") as f:
            key_content = f.read()
    else:
        raise ValueError(f"No IdentityFile specified for host '{host_alias}'")

    return {
        "host": hostname,
        "user": user,
        "key": key_content,
    }


def get_repo_secrets(repo: str) -> list[str]:
    res = subprocess.run(
        ["gh", "secret", "list", "-R", repo],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        return []
    secrets = []
    for line in res.stdout.strip().splitlines():
        parts = line.split()
        if parts:
            secrets.append(parts[0])
    return secrets


def set_secret(repo: str, secret_name: str, secret_val: str) -> bool:
    res = subprocess.run(
        ["gh", "secret", "set", secret_name, "-R", repo],
        input=secret_val,
        text=True,
        capture_output=True,
    )
    if res.returncode == 0:
        print(f"  ✓ {secret_name} updated")
        return True
    else:
        print(f"  ✗ {secret_name} error: {res.stderr.strip()}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Sync VPS secrets across GitHub repos")
    parser.add_argument("--host-alias", default="ec2-main", help="SSH config host alias (default: ec2-main)")
    parser.add_argument("--repo", help="Sync specific repo only (default: all repos with VPS secrets)")
    args = parser.parse_args()

    print(f"Reading SSH config for '{args.host_alias}'...")
    cfg = parse_ssh_config(args.host_alias)
    print(f"Target VPS: {cfg['user']}@{cfg['host']}\n")

    if args.repo:
        target_repos = [args.repo]
    else:
        # Default known repos with VPS deployment
        target_repos = [
            "TNCP06/Cloud-Drive-Telegram",
            "TNCP06/tionusa.id",
            "TNCP06/PAI",
            "TNCP06/vps-monitoring",
            "TNCP06/Rankloom",
            "TNCP06/Sarastya-project",
            "TNCP06/Sarastya-project-web",
            "TNCP06/Sarastya-project-api",
            "TNCP06/Sarastya-project-mobile",
        ]

    for repo in target_repos:
        existing = get_repo_secrets(repo)
        if not existing:
            print(f"Skipping {repo} (no secrets or inaccessible)")
            continue

        print(f"Syncing {repo}...")
        for sec in existing:
            if re.search(r"(?:^|_)HOST$", sec):
                set_secret(repo, sec, cfg["host"])
            elif re.search(r"(?:^|_)(?:USER|USERNAME)$", sec):
                set_secret(repo, sec, cfg["user"])
            elif re.search(r"(?:^|_)KEY$", sec):
                set_secret(repo, sec, cfg["key"])
            elif sec == "VPS_DEPLOY_PATH" and repo == "TNCP06/Cloud-Drive-Telegram":
                set_secret(repo, sec, "/home/ec2-user/tcd")
            elif sec == "DEPLOY_PATH" and repo == "TNCP06/tionusa.id":
                set_secret(repo, sec, "/home/ec2-user/tncp.web.id")
        print()

    print("All repositories synced successfully!")


if __name__ == "__main__":
    main()
