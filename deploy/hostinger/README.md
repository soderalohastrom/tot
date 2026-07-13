# Hostinger archive

The Hostinger VPS is an independent, pull-based archive of the private
Cloudflare Tot Dashboard mirror. Cloudflare remains the serving layer; this
host stores a restorable copy of the current manifest, historical manifest
snapshots, Tot HTML, and referenced assets.

## Layout

- Application: `/opt/tot-dashboard-backup`
- Archive: `/srv/backups/tot-dashboard`
- Secret configuration: `/etc/tot-dashboard-backup.env` (root-only)
- Service: `tot-dashboard-backup.service`
- Schedule: hourly, persistent, with up to five minutes of jitter

The environment file contains:

```ini
TOT_DASHBOARD_CLOUD_URL=https://tot-dashboard.scott-c93.workers.dev
TOT_DASHBOARD_SYNC_TOKEN=<sync secret>
CF_ACCESS_CLIENT_ID=<Access service token client ID>
CF_ACCESS_CLIENT_SECRET=<Access service token client secret>
```

The backup is content-addressed, so unchanged objects are not downloaded
again. Each successful run refreshes `manifest/current.json` and retains a
timestamped manifest in `manifest/snapshots/`.

## Operations

```bash
systemctl status tot-dashboard-backup.timer
systemctl start tot-dashboard-backup.service
journalctl -u tot-dashboard-backup.service --since today
```

To restore or migrate, first copy the entire `/srv/backups/tot-dashboard` tree
to the recovery host. With the three credentials from the root-only environment
file loaded into that recovery process, run:

```bash
tot dashboard restore /srv/backups/tot-dashboard --cloud https://replacement.example.com
```

The command verifies every archived digest, uploads immutable objects first,
and publishes the current manifest last. See
[`docs/CLOUD_DASHBOARD.md`](../../docs/CLOUD_DASHBOARD.md#restore-runbook) for
the complete recovery and cutover procedure.
