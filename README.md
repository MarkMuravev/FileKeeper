# FileKeeper

A background backup utility for Windows, Linux and macOS. It watches a source directory and copies new and changed files to a destination directory — for example, an external or network drive.

## Features

- **Real-time watching** — new and changed files are copied as soon as they appear (with a debounce delay, 500 ms by default).
- **Scheduled full synchronization** — `daily`, `weekly`, `idle` (system idle time). Fully streaming: no file list is built in memory, so memory usage does not depend on the number of files.
- **Deletion mirroring** — with `delete: true`, files removed from the source are also removed from the destination.
- **Resilient to destination outages** — if the network/external drive is disconnected, synchronization pauses and resumes when the drive reappears. Real-time changes accumulated in the meantime are not lost.
- **Resumable after interruption** — an interrupted synchronization starts over, but up-to-date files are skipped by size and mtime, so the re-scan is cheap.
- **Multiple jobs** — any number of "source → destination" pairs with individual settings.
- **Autostart** — installation into Windows Task Scheduler (runs at logon, hidden, no console window), a systemd user unit (Linux) or a LaunchAgent (macOS).
- **Log file and live indicator** — a rotating log file (2 MB) and, for interactive runs, a live-updating job status table.
- **Localization** — all messages in English or Russian (`language` config field or `--lang` flag).

## Requirements

- Windows, Linux or macOS.
- To run from source — Node.js 18+.
- The prebuilt `filekeeper.exe` (SEA build) works without Node.js installed (Windows only).

## Quick start

1. Place `filekeeper.exe` in a folder of your choice.
2. Create a `filekeeper.json` config next to it:

```json
{
    "language": "en",
    "debounce": 500,
    "delete": true,
    "verbose": false,
    "schedule": "weekly sun 10:00",
    "jobs": [
        {
            "source": "D:\\Media\\Photo",
            "destination": "Z:\\Photo"
        }
    ]
}
```

3. Double-click `filekeeper.exe` — a menu opens:

```
  1. Run (watch for changes in real time)
  2. Install to autostart (on Windows — as administrator)
  3. Remove from autostart (on Windows — as administrator)
  4. Exit
```

Install/remove automatically requests administrator rights (UAC) when needed. On Linux and macOS no elevated rights are required — autostart is installed for the current user.

## Command line usage

```
filekeeper.exe                                        interactive menu
node index.js <source> <destination> [--debounce=500] [--no-delete] [--verbose] [--lang=ru|en]
node index.js --config=filekeeper.json                run with a config file
node index.js install   [--config=...] [--name=FileKeeper]   install to autostart
node index.js uninstall [--name=FileKeeper]                  remove from autostart
node index.js status    [--name=FileKeeper]                  check the task status
```

On startup, a full scan is **not** performed — real-time watching begins immediately. A full synchronization happens on schedule or when resuming an interrupted synchronization. If the utility was not running at the scheduled time, the synchronization runs at the next startup.

## Linux / macOS

The core (watching, synchronization, schedules, state file) is fully cross-platform. Platform specifics:

- **Running from source.** Node.js 18+ is required: `node index.js --config=filekeeper.json`. The prebuilt `filekeeper.exe` is Windows-only; standalone binaries for Linux/macOS can be built on the target platform (e.g. `npm run build-cli`, pkg targets `node18-linux-x64` / `node18-macos-x64` are already declared in `package.json`).
- **Autostart on Linux** — `node index.js install` creates a systemd user unit `~/.config/systemd/user/<name>.service` and enables it (`systemctl --user enable --now`). To keep the service running without a user login session: `sudo loginctl enable-linger $USER`.
- **Autostart on macOS** — `node index.js install` creates a LaunchAgent `~/Library/LaunchAgents/com.filekeeper.<name>.plist` and loads it (`launchctl load -w`).
- **`uninstall` / `status`** work correspondingly via `systemctl --user` / `launchctl`.
- **`idle N` schedule** is supported on Windows and macOS (via `ioreg`); on Linux it is ignored with a warning.

## Configuration (`filekeeper.json`)

```json
{
    "language": "en",
    "debounce": 500,
    "delete": true,
    "verbose": false,
    "schedule": ["weekly sun 10:00", "idle 30"],
    "stateFile": "filekeeper-state.json",
    "logFile": "filekeeper.log",
    "exclude": ["node_modules", ".git"],
    "jobs": [
        { "source": "D:\\Documents", "destination": "E:\\Backup\\Documents" },
        {
            "source": "D:\\Photos",
            "destination": "E:\\Backup\\Photos",
            "delete": false,
            "schedule": "daily 02:00",
            "exclude": []
        }
    ]
}
```


| Field       | Description                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `language`  | Message language:`"ru"` or `"en"`. Default `"ru"`. Overridden by the `--lang` flag.                                                               |
| `debounce`  | Delay (ms) before copying a changed file. Default`500`.                                                                                           |
| `delete`    | Delete files in the destination when they are deleted in the source. Default`true`.                                                               |
| `verbose`   | Verbose logging (DEBUG level). Default`false`.                                                                                                    |
| `schedule`  | Full synchronization schedule (a string or an array of strings), globally or per job.                                                             |
| `stateFile` | State file path. Default`filekeeper-state.json` next to the config.                                                                               |
| `logFile`   | Log file path, rotated at 2 MB. Default`filekeeper.log` next to the config.                                                                       |
| `exclude`   | File/folder names skipped during scanning and watching (case-insensitive). Default`["node_modules", ".git"]`; an empty array disables exclusions. |
| `jobs`      | Array of`source` → `destination` jobs. Per-job settings override global ones.                                                                    |

### `schedule` format


| Value                  | Meaning                                                      |
| ------------------------ | -------------------------------------------------------------- |
| `"daily HH:MM"`        | Every day at the given time                                  |
| `"weekly <day> HH:MM"` | Weekly (day:`sun`, `mon`, `tue`, `wed`, `thu`, `fri`, `sat`) |
| `"idle N"`             | When the system has been idle for N minutes (Windows and macOS)   |
| `"never"` or omitted   | No full synchronization is scheduled                         |

## State and log files

- `filekeeper-state.json` — running-synchronization flag, processed-file counter, queue of uncopied real-time changes, and the time of the last full synchronization.
- `filekeeper.log` — the log; when it exceeds 2 MB it is renamed to `filekeeper.log.old` and started fresh.

Both files live next to the config by default (not in the destination — it may be unavailable).

## Building from source

```
npm install
npm start          # run from source
npm run build-sea  # build filekeeper.exe (Node SEA) into ./dist
```

Other build variants: `npm run build` (pkg, Windows), `npm run build-cli` (pkg, linux/macOS/Windows), `npm run build-sea-cli` (SEA via build.json).

## License

MIT © EchoSystem - https://echosystem.ru
