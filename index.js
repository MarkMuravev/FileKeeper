#!/usr/bin/env node
/**
 * filekeeper — утилита фонового резервного копирования.
 * Следит за директорией-источником и копирует изменённые/новые файлы
 * в директорию назначения (например, внешний или сетевой диск).
 *
 * При запуске полное сканирование НЕ выполняется — сразу включается
 * слежение в реальном времени. Полная синхронизация происходит:
 *   - по расписанию ("schedule" в конфиге: daily/weekly/idle),
 *   - при возобновлении прерванной синхронизации.
 * Полная синхронизация — потоковая: файлы проверяются и копируются прямо
 * по ходу обхода дерева, список файлов в памяти не строится. В state-файле
 * хранится только флаг "синхронизация идёт" и счётчик обработанных файлов,
 * поэтому расход памяти не зависит от числа файлов. Прерванная синхронизация
 * после перезапуска начинается заново — актуальные файлы пропускаются по
 * размеру и mtime, так что повторный обход дёшев.
 * Если назначение (диск/сеть) недоступно, синхронизация приостанавливается
 * и возобновляется, когда назначение снова появится.
 *
 * Использование:
 *   filekeeper.exe                                    интерактивное меню (запуск / установка / удаление)
 *   node index.js <источник> <назначение> [--debounce=500] [--no-delete] [--verbose] [--lang=ru|en]
 *   node index.js --config=filekeeper.json [--lang=ru|en]   запуск по конфиг-файлу
 *   node index.js install   [--config=...] [--name=FileKeeper]  установить в автозагрузку (Планировщик заданий)
 *   node index.js uninstall [--name=FileKeeper]                 удалить из автозагрузки
 *   node index.js status    [--name=FileKeeper]                 проверить состояние задачи
 *
 * Установка и удаление через меню автоматически запрашивают права
 * администратора (UAC), если утилита запущена без них.
 *
 * Формат конфиг-файла (JSON):
 *   {
 *     "language": "ru",
 *     "debounce": 500,
 *     "delete": true,
 *     "verbose": false,
 *     "schedule": ["weekly sun 10:00", "idle 30"],
 *     "stateFile": "filekeeper-state.json",
 *     "logFile": "filekeeper.log",
 *     "exclude": ["node_modules", ".git"],
 *     "jobs": [
 *       { "source": "D:\\Documents", "destination": "E:\\Backup\\Documents" },
 *       { "source": "D:\\Photos", "destination": "E:\\Backup\\Photos", "delete": false, "schedule": "daily 02:00", "exclude": [] }
 *     ]
 *   }
 *
 * Поле "language" — язык сообщений: "ru" (по умолчанию) или "en".
 * Флаг --lang=ru|en перекрывает значение из конфига.
 *
 * Поле "exclude" — имена файлов/папок, которые пропускаются при сканировании
 * и слежении (сравнение по имени, без учёта регистра). По умолчанию —
 * ["node_modules", ".git"]; пустой массив отключает исключения.
 *
 * Поле "logFile" — файл журнала (по умолчанию "filekeeper.log" рядом с
 * конфигом, ротация при превышении 2 МБ). При интерактивном запуске в консоли
 * дополнительно показывается живая таблица состояния заданий (обновляется
 * на месте, без потока новых строк).
 *
 * Поле "schedule" (строка или массив строк; глобально или на уровне задания):
 *   "daily HH:MM"          — ежедневно в указанное время
 *   "weekly <день> HH:MM"  — еженедельно (день: sun, mon, tue, wed, thu, fri, sat)
 *   "idle N"               — когда система простаивает N минут (только Windows)
 *   "never" / отсутствует  — полная синхронизация не планируется
 * Если в момент расписания утилита не работала, синхронизация выполнится
 * при ближайшем запуске.
 *
 * Поле "stateFile" — путь к файлу состояния (флаг идущей синхронизации,
 * счётчик обработанных файлов, нескопированные реал-тайм изменения, время
 * последней полной синхронизации). По умолчанию — "filekeeper-state.json"
 * рядом с конфигом.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFile, spawnSync } = require('child_process');
const readline = require('readline');
const { setLanguage, t } = require('./i18n');

const DEFAULT_TASK_NAME = 'FileKeeper';

const SCHEDULER_TICK_MS = 30 * 1000;  // проверка расписания
const DST_PROBE_MS = 30 * 1000;       // пробник доступности назначения
const IDLE_POLL_MS = 60 * 1000;       // опрос времени простоя системы
const CHECKPOINT_EVERY = 50;          // файлов между обновлениями счётчика прогресса в state-файле
const STATE_SAVE_INTERVAL = 30 * 1000; // минимальный интервал между записями state-файла
const LOG_MAX_BYTES = 2 * 1024 * 1024; // ротация лог-файла (в .old)
const DEFAULT_EXCLUDE = ['node_modules', '.git'];

// Коды ошибок, означающих недоступность назначения (диск отключён, сеть пропала)
const DST_ERROR_CODES = new Set([
    'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENXIO', 'ENODEV',
    'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENOTFOUND',
    'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ESHUTDOWN',
]);

// ---------- Утилиты ----------
// Журнал дублируется в файл (см. initLog). В консоль пишем только при
// интерактивном запуске: при работе из Планировщика консоли нет, а записи
// в «ничей» stdout копятся в буфере и раздувают память процесса.
let logStream = null;

function initLog(logPath) {
    try {
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES) {
            fs.rmSync(logPath + '.old', { force: true });
            fs.renameSync(logPath, logPath + '.old');
        }
        logStream = fs.createWriteStream(logPath, { flags: 'a' });
        logStream.on('error', () => { logStream = null; });
    } catch {
        /* лог-файл недоступен — остаётся только консоль */
    }
}

// Метка времени в локальном часовом поясе: "YYYY-MM-DD HH:MM:SS"
function localTimestamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level, msg) {
    const time = localTimestamp(new Date());
    const line = `[${time}] [${level}] ${msg}`;
    if (process.stdout.isTTY) {
        // При живом индикаторе пофайловые события не засоряют консоль
        // (они остаются в лог-файле) — иначе поток строк ломает перерисовку
        const quiet = progress.active && (level === 'COPY' || level === 'DEL' || level === 'SKIP' || level === 'DEBUG');
        if (!quiet) {
            try { progressLog(line); } catch { }
        }
    }
    if (logStream) logStream.write(line + '\n');
}

// ---------- Индикатор прогресса (только интерактивная консоль) ----------
// Внизу консоли живёт обновляемая таблица: одна строка на задание,
// перерисовывается на месте, новых строк не добавляет. При работе из
// Планировщика консоли нет — индикатор не включается, всё идёт в лог-файл.
const PROGRESS_RENDER_MS = 500;

const progress = {
    active: false,
    jobs: new Map(), // jobKey -> metrics
    renderedLines: 0,
    timer: null,
    dirty: false,
};

function progressStart() {
    if (!process.stdout.isTTY || progress.active) return;
    progress.active = true;
    progress.timer = setInterval(renderProgress, PROGRESS_RENDER_MS);
    if (progress.timer.unref) progress.timer.unref();
}

function progressStop() {
    if (!progress.active) return;
    progress.active = false;
    if (progress.timer) clearInterval(progress.timer);
    progress.timer = null;
    clearProgressBlock();
}

function clearProgressBlock() {
    if (!progress.renderedLines) return;
    try {
        readline.moveCursor(process.stdout, 0, -progress.renderedLines);
        readline.clearScreenDown(process.stdout);
    } catch {
        progress.active = false; // консоль не поддерживает курсорные операции
    }
    progress.renderedLines = 0;
}

// Обычное сообщение поверх индикатора: стираем таблицу, печатаем строку,
// таблица перерисуется под ней на ближайшем тике.
function progressLog(line) {
    if (!progress.active) {
        console.log(line);
        return;
    }
    clearProgressBlock();
    console.log(line);
    progress.dirty = true;
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

function renderProgress() {
    if (!progress.active || !progress.dirty) return;
    progress.dirty = false;
    clearProgressBlock();
    if (!progress.active) return; // консоль не поддерживает перерисовку
    const rows = [...progress.jobs.values()];
    if (!rows.length) return;
    const lines = [
        ` ${pad(t('col_job'), 20)} ${pad(t('col_state'), 16)} ${pad(t('col_checked'), 10)} ${pad(t('col_copied'), 12)} ${pad(t('col_skipped'), 10)} ${pad(t('col_deleted'), 8)} ${pad(t('col_errors'), 7)} ${pad(t('col_pending'), 9)}`,
    ];
    for (const m of rows) {
        lines.push(` ${pad(m.tag, 20)} ${pad(m.status, 16)} ${pad(m.processed, 10)} ${pad(m.copied, 12)} ${pad(m.skipped, 10)} ${pad(m.deleted, 8)} ${pad(m.errors, 7)} ${pad(m.pending, 9)}`);
    }
    try {
        process.stdout.write(lines.join('\n') + '\n');
        progress.renderedLines = lines.length;
    } catch {
        progress.active = false;
    }
}

function getArg(args, name) {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found ? found.split('=').slice(1).join('=') : undefined;
}

function isDstError(err) {
    return Boolean(err && DST_ERROR_CODES.has(err.code));
}

// ---------- Расписание ----------
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseSchedule(str) {
    const raw = String(str).trim();
    const parts = raw.toLowerCase().split(/\s+/);

    if (parts[0] === 'never') return null;

    const parseTime = (s) => {
        const m = s && s.match(/^(\d{1,2}):(\d{2})$/);
        if (!m || +m[1] > 23 || +m[2] > 59) return null;
        return { hour: +m[1], minute: +m[2] };
    };

    if (parts[0] === 'daily' && parts.length === 2) {
        const t = parseTime(parts[1]);
        if (t) return { type: 'daily', ...t, raw };
    }
    if (parts[0] === 'weekly' && parts.length === 3 && parts[1] in DAYS) {
        const t = parseTime(parts[2]);
        if (t) return { type: 'weekly', day: DAYS[parts[1]], ...t, raw };
    }
    if (parts[0] === 'idle' && parts.length === 2 && Number(parts[1]) > 0) {
        return { type: 'idle', minutes: Number(parts[1]), raw };
    }
    throw new Error(t('invalid_schedule_format', { raw }));
}

// Момент последнего "должного" срабатывания расписания (<= now), либо null для idle
function lastDue(sched, now) {
    if (sched.type === 'idle') return null;
    const t = new Date(now);
    t.setSeconds(0, 0);
    if (sched.type === 'daily') {
        t.setHours(sched.hour, sched.minute, 0, 0);
        if (t > now) t.setDate(t.getDate() - 1);
        return t;
    }
    // weekly
    t.setHours(sched.hour, sched.minute, 0, 0);
    t.setDate(t.getDate() - ((t.getDay() - sched.day + 7) % 7));
    if (t > now) t.setDate(t.getDate() - 7);
    return t;
}

// ---------- Конфигурация ----------
function loadJobs(args) {
    const configPath = getArg(args, 'config') ? path.resolve(getArg(args, 'config')) : path.resolve(__dirname, 'filekeeper.json');

    let fileCfg = {};
    if (fs.existsSync(configPath)) {
        try {
            fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            log('INFO', t('config_loaded', { path: configPath }));
        } catch (err) {
            console.error(t('config_read_error', { path: configPath, error: err.message }));
            process.exit(1);
        }
    }

    // Флаг --lang перекрывает "language" из конфига; неизвестные значения — откат на ru
    setLanguage(getArg(args, 'lang') || fileCfg.language);

    const defaults = {
        debounce: fileCfg.debounce ?? 500,
        delete: fileCfg.delete ?? true,
        verbose: fileCfg.verbose ?? false,
        schedule: fileCfg.schedule,
        exclude: fileCfg.exclude ?? DEFAULT_EXCLUDE,
    };

    // state-файл и лог по умолчанию лежат рядом с конфигом (НЕ в назначении — оно может быть недоступно)
    const statePath = path.resolve(path.dirname(configPath), fileCfg.stateFile || 'filekeeper-state.json');
    const logPath = path.resolve(path.dirname(configPath), fileCfg.logFile || 'filekeeper.log');

    let jobs = Array.isArray(fileCfg.jobs) ? fileCfg.jobs : [];

    // Позиционные аргументы (источник и назначение) — дополнительное задание поверх конфига
    const positional = args.filter((a) => !a.startsWith('--'));
    if (positional.length >= 2) {
        jobs.push({
            source: positional[0],
            destination: positional[1],
            debounce: Number(getArg(args, 'debounce')) || undefined,
            delete: args.includes('--no-delete') ? false : undefined,
            verbose: args.includes('--verbose') ? true : undefined,
        });
    }

    if (jobs.length === 0) {
        console.error(t('no_jobs'));
        process.exit(1);
    }

    return { jobs: jobs.map((job, i) => normalizeJob({ ...defaults, ...job }, i)), statePath, logPath };
}

function normalizeJob(job, index) {
    const srcDir = job.source && path.resolve(job.source);
    const dstDir = job.destination && path.resolve(job.destination);

    if (!srcDir || !dstDir) {
        console.error(t('job_needs_src_dst', { n: index + 1 }));
        process.exit(1);
    }
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
        console.error(t('job_src_missing', { n: index + 1, path: srcDir }));
        process.exit(1);
    }
    if (dstDir === srcDir || dstDir.startsWith(srcDir + path.sep) || srcDir.startsWith(dstDir + path.sep)) {
        console.error(t('job_overlap', { n: index + 1 }));
        process.exit(1);
    }

    // Назначение может быть недоступно при старте (сетевой диск ещё не поднят) — не падаем,
    // пробник доступности подхватит его позже
    try {
        fs.mkdirSync(dstDir, { recursive: true });
    } catch {
        log('WARN', t('job_dst_unavailable', { n: index + 1, path: dstDir }));
    }

    const rawSchedules = job.schedule == null ? [] : (Array.isArray(job.schedule) ? job.schedule : [job.schedule]);
    let schedules;
    try {
        schedules = rawSchedules.map(parseSchedule).filter(Boolean);
    } catch (err) {
        console.error(t('job_error', { n: index + 1, error: err.message }));
        process.exit(1);
    }

    return {
        srcDir,
        dstDir,
        debounce: job.debounce,
        delete: job.delete,
        verbose: job.verbose,
        schedules,
        exclude: new Set((Array.isArray(job.exclude) ? job.exclude : []).map((s) => String(s).toLowerCase())),
        jobKey: `${srcDir}->${dstDir}`,
    };
}

// ---------- State-файл (прогресс синхронизации) ----------
function createStateStore(statePath) {
    let data = { jobs: {} };
    let saveTimer = null;
    let dirty = false;
    let lastWrite = 0;

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object') {
                data = parsed;
            }
        } catch {
            /* файла нет или он повреждён — начинаем с чистого состояния */
        }
    }

    function writeSync() {
        const tmp = statePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, statePath);
        lastWrite = Date.now();
    }

    // Троттлинг: не чаще одного раза в STATE_SAVE_INTERVAL, чтобы счётчик
    // прогресса не дёргал диск на каждый обработанный файл.
    function scheduleSave() {
        dirty = true;
        if (saveTimer) return;
        const wait = Math.max(0, STATE_SAVE_INTERVAL - (Date.now() - lastWrite));
        saveTimer = setTimeout(() => {
            saveTimer = null;
            if (!dirty) return;
            dirty = false;
            try {
                writeSync();
            } catch (err) {
                log('ERROR', t('state_write_error', { error: err.message }));
            }
        }, wait);
        if (saveTimer.unref) saveTimer.unref();
    }

    function get(key) {
        if (!data.jobs[key]) {
            data.jobs[key] = { pending: [], syncInProgress: false, syncProcessed: 0, syncStartedAt: null, lastFullSync: null };
        }
        const jobState = data.jobs[key];
        if (!Array.isArray(jobState.pending)) jobState.pending = [];
        // Миграция старого формата: была персистентная очередь файлов.
        // Незавершённую очередь не возобновляем — просто помечаем, что
        // синхронизация не окончена, и потоковый обход пройдётся заново.
        if (Array.isArray(jobState.queue)) {
            if (jobState.queue.length) jobState.syncInProgress = true;
            delete jobState.queue;
        }
        return jobState;
    }

    function update(key, patch) {
        Object.assign(get(key), patch);
        scheduleSave();
    }

    function flush() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (!dirty) return;
        dirty = false;
        try {
            writeSync();
        } catch {
            /* при завершении просто теряем последние пару секунд прогресса */
        }
    }

    load();
    log('INFO', t('state_file', { path: statePath }));
    return { get, update, flush };
}

// ---------- Резервное копирование одного задания ----------
function runJob(job, stateStore) {
    const { srcDir, dstDir, debounce, delete: allowDelete, verbose: isVerbose, schedules, exclude, jobKey } = job;
    const verbose = (msg) => isVerbose && log('DEBUG', msg);
    const tag = path.basename(srcDir);

    const state = stateStore.get(jobKey);
    const pendingSet = new Set(state.pending); // для быстрой дедупликации (includes по массиву — O(n))
    const isExcluded = (relPath) => relPath.split(path.sep).some((seg) => exclude.has(seg.toLowerCase()));

    const watchers = new Map(); // relDir -> FSWatcher (по одному на папку, исключённые не наблюдаются)
    let dstAvailable = true;
    let syncing = false;    // идёт полная синхронизация (обход + копирование)
    let stopped = false;
    const timers = { scheduler: null, probe: null, idle: null };
    const pendingTimers = new Map(); // relPath -> timer (debounce событий watcher'а)

    // Метрики для живого индикатора прогресса в консоли
    const metrics = { tag, status: t('status_starting'), processed: 0, copied: 0, skipped: 0, deleted: 0, errors: 0, pending: state.pending.length };
    progress.jobs.set(jobKey, metrics);
    const touch = () => { progress.dirty = true; };
    touch();

    // ----- Копирование одного файла/папки или удаление, если в источнике исчезло -----
    async function syncPath(relPath) {
        const src = path.join(srcDir, relPath);
        const dst = path.join(dstDir, relPath);

        let stat;
        try {
            stat = await fs.promises.stat(src);
        } catch {
            // В источнике удалено
            if (allowDelete) {
                await fs.promises.rm(dst, { recursive: true, force: true });
                log('DEL', `[${tag}] ${relPath}`);
                metrics.deleted++;
                touch();
            }
            return;
        }

        if (stat.isDirectory()) {
            await fs.promises.mkdir(dst, { recursive: true });
            verbose(`DIR  ${relPath}`);
            return;
        }

        // Пропускаем, если файл в копии актуален (размер и mtime совпадают)
        try {
            const dstStat = await fs.promises.stat(dst);
            if (dstStat.size === stat.size && Math.abs(dstStat.mtimeMs - stat.mtimeMs) < 2000) {
                verbose(`SKIP ${relPath}`);
                metrics.skipped++;
                touch();
                return;
            }
        } catch (err) {
            if (!isDstError(err)) throw err;
            /* файла в копии нет (или назначение недоступно) — копируем */
        }

        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(src, dst);
        await fs.promises.utimes(dst, stat.atime, stat.mtime).catch(() => { });
        metrics.copied++;
        touch();
        log('COPY', `[${tag}] ${relPath}`);
    }

    // ----- Очередь реал-тайм путей, не скопировавшихся из-за недоступности назначения -----
    function addPending(relPath) {
        if (pendingSet.has(relPath)) return;
        pendingSet.add(relPath);
        state.pending.push(relPath);
        metrics.pending = state.pending.length;
        touch();
        stateStore.update(jobKey, { pending: state.pending });
    }

    async function drainPending() {
        // Индексный обход вместо shift(): shift на большом массиве — O(n) на
        // элемент, итого O(n²). splice один раз в конце дешевле.
        let i = 0;
        while (i < state.pending.length && dstAvailable && !stopped) {
            const rel = state.pending[i];
            try {
                await syncPath(rel);
                i++;
                pendingSet.delete(rel);
            } catch (err) {
                if (isDstError(err)) {
                    dstAvailable = false;
                    log('WARN', t('dst_unavailable_waiting', { tag, code: err.code }));
                    break;
                }
                log('ERROR', `[${tag}] ${rel}: ${err.message}`);
                metrics.errors++;
                i++; // пропускаем проблемный файл, чтобы не зациклиться
                pendingSet.delete(rel);
            }
        }
        if (i) state.pending.splice(0, i);
        metrics.pending = state.pending.length;
        touch();
        stateStore.update(jobKey, { pending: state.pending });
    }

    // ----- Полная синхронизация: потоковый обход без списка файлов -----
    // Список файлов в памяти не строится и в state-файл не пишется — только
    // флаг syncInProgress и счётчик обработанных. Прерванная синхронизация
    // начинается заново: syncPath пропускает актуальные файлы, так что
    // повторный обход по сути бесплатен.
    async function walk(rel) {
        let entries;
        try {
            entries = await fs.promises.readdir(rel ? path.join(srcDir, rel) : srcDir, { withFileTypes: true });
        } catch (err) {
            log('ERROR', t('read_dir_error', { tag, path: rel || '.', error: err.message }));
            return;
        }
        for (const entry of entries) {
            if (stopped || !dstAvailable) return;
            if (exclude.has(entry.name.toLowerCase())) continue;
            const child = rel ? path.join(rel, entry.name) : entry.name;
            if (entry.isDirectory()) {
                await walk(child);
            } else {
                try {
                    await syncPath(child);
                } catch (err) {
                    if (isDstError(err)) {
                        dstAvailable = false;
                        log('WARN', t('dst_unavailable_sync_paused', { tag, code: err.code, count: processed }));
                        return;
                    }
                    log('ERROR', `[${tag}] ${child}: ${err.message}`); // пропускаем проблемный файл
                    metrics.errors++;
                }
                processed++;
                metrics.processed = processed;
                touch();
                if (processed % CHECKPOINT_EVERY === 0) {
                    stateStore.update(jobKey, { syncProcessed: processed });
                }
            }
        }
    }

    let processed = 0;

    async function fullSync(reason) {
        if (syncing) {
            verbose(t('sync_already_running'));
            return;
        }
        if (!dstAvailable || stopped) return;
        syncing = true; // флаг ставится до первого await — расписание/idle не запустят вторую синхронизацию
        processed = 0;
        metrics.status = t('status_syncing');
        metrics.processed = 0;
        touch();
        log('INFO', t('full_sync_start', { tag, reason }));
        stateStore.update(jobKey, { syncInProgress: true, syncProcessed: 0, syncStartedAt: new Date().toISOString() });
        stateStore.flush(); // факт начала должен пережить внезапный сбой
        try {
            await walk('');
        } finally {
            syncing = false;
        }
        stateStore.update(jobKey, { syncProcessed: processed });
        if (!stopped && dstAvailable) {
            stateStore.update(jobKey, { syncInProgress: false, syncStartedAt: null, lastFullSync: new Date().toISOString() });
            stateStore.flush(); // факт завершения должен пережить внезапный сбой
            metrics.status = t('status_watching');
            touch();
            log('INFO', t('full_sync_done', { tag, count: processed }));
            drainPending();
        } else if (!stopped) {
            // Назначение отвалилось на ходу — syncInProgress остаётся true,
            // пробник доступности перезапустит синхронизацию
            metrics.status = t('status_waiting_disk');
            touch();
            stateStore.flush();
        }
    }

    // ----- Планировщик -----
    function schedulerTick() {
        if (stopped || syncing) return;
        const now = new Date();
        const lastRun = state.lastFullSync ? new Date(state.lastFullSync) : null;
        for (const sched of schedules) {
            const due = lastDue(sched, now);
            if (due && (!lastRun || lastRun < due)) {
                fullSync(t('reason_schedule', { raw: sched.raw })).catch((err) => log('ERROR', `[${tag}] ${err.message}`));
                return; // одна синхронизация за тик
            }
        }
    }

    // ----- Пробник доступности назначения -----
    async function checkDst() {
        if (stopped) return;
        // Пока идёт проверка диска (на спящем/сетевом носителе mkdir может
        // занять десятки секунд) — показываем это в живой таблице. Статус
        // синхронизации не трогаем, чтобы не мешать полному обходу.
        if (!syncing) {
            metrics.status = t('status_checking_disk');
            touch();
        }
        try {
            // mkdir заодно и создаёт отсутствующую папку назначения, когда диск появляется
            await fs.promises.mkdir(dstDir, { recursive: true });
            if (!dstAvailable) {
                dstAvailable = true;
                metrics.status = t('status_watching');
                touch();
                log('INFO', t('dst_available_again', { tag }));
                if (state.syncInProgress) {
                    // Синхронизация была прервана недоступностью назначения —
                    // запускаем заново (актуальные файлы будут пропущены)
                    fullSync(t('reason_dst_back')).catch((err) => log('ERROR', `[${tag}] ${err.message}`));
                } else {
                    drainPending();
                }
            } else if (!syncing) {
                metrics.status = t('status_watching');
                touch();
            }
        } catch {
            if (dstAvailable) {
                dstAvailable = false;
                verbose(t('dst_unavailable_verbose', { path: dstDir }));
            }
            if (!syncing) {
                metrics.status = t('status_waiting_disk');
                touch();
            }
        }
    }

    // ----- Детект простоя системы (Windows, GetLastInputInfo) -----
    function getIdleSeconds() {
        return new Promise((resolve) => {
            const script = [
                `$src = @'`,
                `using System;`,
                `using System.Runtime.InteropServices;`,
                `public static class IdleCheck {`,
                `    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);`,
                `    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }`,
                `    public static uint GetSeconds() {`,
                `        LASTINPUTINFO li = new LASTINPUTINFO();`,
                `        li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));`,
                `        GetLastInputInfo(ref li);`,
                `        return ((uint)Environment.TickCount - li.dwTime) / 1000;`,
                `    }`,
                `}`,
                `'@`,
                `Add-Type -TypeDefinition $src;`,
                `[IdleCheck]::GetSeconds()`,
            ].join('\n');
            execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 }, (err, stdout) => {
                if (err) {
                    verbose(t('idle_time_error', { error: err.message }));
                    return resolve(null);
                }
                const sec = parseInt(stdout, 10);
                resolve(Number.isFinite(sec) ? sec : null);
            });
        });
    }

    function setupIdleWatcher() {
        const idleSchedules = schedules.filter((s) => s.type === 'idle');
        if (!idleSchedules.length) return;
        if (process.platform !== 'win32') {
            log('WARN', t('idle_windows_only', { tag }));
            return;
        }
        const threshold = Math.min(...idleSchedules.map((s) => s.minutes)) * 60;
        let wasIdle = false;
        timers.idle = setInterval(async () => {
            const sec = await getIdleSeconds();
            if (sec == null) return;
            const isIdle = sec >= threshold;
            if (isIdle && !wasIdle) {
                fullSync(t('reason_idle', { minutes: Math.floor(sec / 60) })).catch((err) => log('ERROR', `[${tag}] ${err.message}`));
            }
            wasIdle = isIdle;
        }, IDLE_POLL_MS);
    }

    // ----- Debounce событий слежения -----
    function schedule(relPath) {
        if (pendingTimers.has(relPath)) clearTimeout(pendingTimers.get(relPath));
        pendingTimers.set(
            relPath,
            setTimeout(() => {
                pendingTimers.delete(relPath);
                syncPath(relPath).catch((err) => {
                    if (isDstError(err)) {
                        dstAvailable = false;
                        metrics.status = t('status_waiting_disk');
                        touch();
                        verbose(t('wait_queued', { path: relPath }));
                        addPending(relPath);
                    } else {
                        log('ERROR', `[${tag}] ${relPath}: ${err.message}`);
                        metrics.errors++;
                        touch();
                    }
                });
            }, debounce)
        );
    }

    // ----- Слежение в реальном времени (по одному fs.watch на папку) -----
    // fs.watch({recursive: true}) не умеет исключения и держит дескрипторы на все
    // подпапки, включая node_modules — поэтому наблюдаем дерево сами, пропуская exclude.
    function onWatchEvent(dir, event, filename) {
        if (!filename) return;
        // Windows при удалении корня может прислать абсолютный путь — такие события игнорируем,
        // чтобы случайно не удалить всю резервную копию
        if (path.isAbsolute(filename)) {
            verbose(t('event_skipped', { event, path: filename }));
            return;
        }
        const rel = path.normalize(path.join(dir, filename));
        if (rel === '.' || rel.startsWith('..' + path.sep) || isExcluded(rel)) {
            verbose(t('event_skipped', { event, path: rel }));
            return;
        }
        verbose(`EVENT ${event}: ${rel}`);
        schedule(rel);
        // Появилась новая папка — начинаем следить и за ней. Содержимое, успевшее
        // появиться до подключения watcher'а, событий не даст — ставим его вручную.
        if (event === 'rename' && !watchers.has(rel)) {
            fs.stat(path.join(srcDir, rel), (err, st) => {
                if (err || !st.isDirectory() || stopped || watchers.has(rel)) return;
                (async () => {
                    await watchTree(rel);
                    await scheduleTree(rel);
                })().catch(() => { });
            });
        }
    }

    // Рекурсивно поставить на синхронизацию всё содержимое папки
    async function scheduleTree(rel) {
        let entries;
        try {
            entries = await fs.promises.readdir(path.join(srcDir, rel), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (exclude.has(entry.name.toLowerCase())) continue;
            const child = path.join(rel, entry.name);
            schedule(child);
            if (entry.isDirectory()) await scheduleTree(child);
        }
    }

    function watchDir(dir) {
        let w;
        try {
            w = fs.watch(path.join(srcDir, dir), (event, filename) => onWatchEvent(dir, event, filename));
        } catch (err) {
            verbose(t('watch_skipped', { path: dir || '.', error: err.message }));
            return;
        }
        w.on('error', (err) => {
            try { w.close(); } catch { }
            if (watchers.get(dir) === w) watchers.delete(dir);
            log('WARN', t('watch_interrupted', { tag, path: dir || '.', error: err.message }));
            retryWatch(dir); // например, диск отключали
        });
        watchers.set(dir, w);
    }

    function retryWatch(dir) {
        setTimeout(() => {
            if (stopped || watchers.has(dir)) return;
            if (fs.existsSync(path.join(srcDir, dir))) {
                watchTree(dir);
            } else if (dir === '') {
                retryWatch(dir); // корень недоступен — продолжаем попытки
            }
        }, 3000);
    }

    async function watchTree(dir) {
        if (stopped || watchers.has(dir)) return;
        watchDir(dir);
        if (!watchers.has(dir)) {
            if (dir === '') retryWatch(dir);
            return;
        }
        let entries;
        try {
            entries = await fs.promises.readdir(path.join(srcDir, dir), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !exclude.has(entry.name.toLowerCase())) {
                await watchTree(path.join(dir, entry.name));
            }
        }
    }

    async function startWatcher() {
        await watchTree('');
    }

    // ----- Запуск / остановка -----
    async function start() {
        log('INFO', `[${tag}] ${srcDir} -> ${dstDir}`);
        await startWatcher();
        metrics.status = t('status_watching');
        touch();
        log('INFO', t('watch_started', { tag, count: watchers.size }));

        await checkDst();
        if (!dstAvailable) {
            log('WARN', t('dst_unavailable_start', { tag, path: dstDir }));
        }

        if (state.syncInProgress) {
            log('INFO', t('resume_incomplete_sync', { tag, count: state.syncProcessed || 0 }));
            fullSync(t('reason_resume')).catch((err) => log('ERROR', `[${tag}] ${err.message}`));
        } else if (state.pending.length) {
            log('INFO', t('pending_changes', { tag, count: state.pending.length }));
            drainPending();
        }

        schedulerTick(); // догнать слот расписания, пропущенный, пока утилита была выключена
        timers.scheduler = setInterval(schedulerTick, SCHEDULER_TICK_MS);
        timers.probe = setInterval(checkDst, DST_PROBE_MS);
        setupIdleWatcher();
    }

    function stop() {
        stopped = true;
        progress.jobs.delete(jobKey);
        progress.dirty = true;
        for (const w of watchers.values()) {
            try { w.close(); } catch { }
        }
        watchers.clear();
        for (const t of pendingTimers.values()) clearTimeout(t);
        for (const key of Object.keys(timers)) {
            if (timers[key]) {
                clearInterval(timers[key]);
                clearTimeout(timers[key]);
            }
        }
    }

    return { start, stop };
}

// ---------- Режим службы (Планировщик заданий Windows) ----------
async function serviceInstall(args) {
    if (process.platform !== 'win32') {
        console.error(t('install_windows_only'));
        console.error(t('install_other_os_hint'));
        process.exit(1);
    }

    const taskName = getArg(args, 'name') || DEFAULT_TASK_NAME;
    const configArg = getArg(args, 'config')
        ? `--config "${path.resolve(getArg(args, 'config'))}"`
        : `--config "${path.resolve(__dirname, 'filekeeper.json')}"`;

    // Скрытый запуск без консольного окна через VBS-обёртку
    const launcher = path.resolve(__dirname, 'filekeeper-launcher.vbs');
    // В exe-сборке (SEA) скрипт уже встроен в бинарник — путь к index.js не нужен
    const cmdParts = [`"${process.execPath}"`];
    if (!isSea()) cmdParts.push(`"${path.join(__dirname, 'index.js')}"`);
    cmdParts.push(configArg);
    // В VBScript кавычки внутри строкового литерала удваиваются
    const vbsCmd = cmdParts.join(' ').replace(/"/g, '""');
    const vbs = [
        `Set sh = CreateObject("Wscript.Shell")`,
        `sh.CurrentDirectory = "${__dirname}"`,
        `sh.Run "${vbsCmd}", 0, False`,
    ].join('\r\n');
    fs.writeFileSync(launcher, vbs);

    execSync(
        `schtasks /create /tn "${taskName}" /sc onlogon /rl highest /f ` +
        `/tr "wscript.exe \\"${launcher}\\""`,
        { stdio: 'inherit' }
    );
    console.log(t('task_installed', { name: taskName }));
    console.log(t('task_run_now', { name: taskName }));
    if (args.includes('--pause')) await waitForEnter();
}

async function serviceUninstall(args) {
    const taskName = getArg(args, 'name') || DEFAULT_TASK_NAME;
    execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'inherit' });
    const launcher = path.resolve(__dirname, 'filekeeper-launcher.vbs');
    fs.rmSync(launcher, { force: true });
    console.log(t('task_removed', { name: taskName }));
    if (args.includes('--pause')) await waitForEnter();
}

function serviceStatus(args) {
    const taskName = getArg(args, 'name') || DEFAULT_TASK_NAME;
    try {
        execSync(`schtasks /query /tn "${taskName}"`, { stdio: 'inherit' });
    } catch {
        console.log(t('task_not_installed', { name: taskName }));
    }
}

// ---------- Интерактивное меню (запуск без аргументов) ----------
function isSea() {
    try { return require('node:sea').isSea(); } catch { return false; }
}

function isElevated() {
    try {
        execSync('net session', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// Перезапуск себя с правами администратора (UAC) в отдельном окне консоли.
// --pause: дочерний процесс в конце ждёт Enter, чтобы окно не закрылось мгновенно.
function runElevated(cmdArgs) {
    const parts = [];
    if (!isSea()) parts.push(`"${path.join(__dirname, 'index.js')}"`);
    parts.push(...cmdArgs, '--pause');
    // В PowerShell-строке в одинарных кавычках экранируются только сами одинарные кавычки
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const ps = `Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${q(parts.join(' '))} -Verb RunAs -Wait`;
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    if (res.error || res.status !== 0) {
        console.error(t('elevation_failed'));
    }
}

function waitForEnter() {
    if (!process.stdin.isTTY) return Promise.resolve();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(t('press_enter'), () => {
        rl.close();
        resolve();
    }));
}

async function showMenu() {
    console.log('');
    console.log(t('menu_title'));
    console.log('');
    console.log(t('menu_option_run'));
    console.log(t('menu_option_install'));
    console.log(t('menu_option_uninstall'));
    console.log(t('menu_option_exit'));
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(t('menu_prompt'), resolve));
    rl.close();

    const choice = answer.trim();
    if (choice === '2' || choice === '3') {
        const cmd = choice === '2' ? 'install' : 'uninstall';
        if (isElevated()) {
            if (cmd === 'install') await serviceInstall([]);
            else await serviceUninstall([]);
        } else {
            console.log(t('requesting_elevation'));
            runElevated([cmd]);
        }
        process.exit(0);
    }
    if (choice !== '1' && choice !== '') process.exit(0);
    // '1' или Enter — обычный запуск (код ниже)
}

// ---------- Запуск ----------
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    // Раннее определение языка: меню и команды install/uninstall/status идут
    // до loadJobs, поэтому конфиг читаем здесь толерантно — только ради поля
    // "language". Ошибки игнорируем (битый конфиг разберёт loadJobs).
    // Флаг --lang перекрывает значение из конфига.
    try {
        let lang = getArg(args, 'lang');
        if (!lang) {
            const earlyConfigPath = getArg(args, 'config')
                ? path.resolve(getArg(args, 'config'))
                : path.resolve(__dirname, 'filekeeper.json');
            if (fs.existsSync(earlyConfigPath)) {
                lang = JSON.parse(fs.readFileSync(earlyConfigPath, 'utf8')).language;
            }
        }
        setLanguage(lang);
    } catch { /* язык остаётся ru */ }

    if (command === 'install') {
        await serviceInstall(args.slice(1));
    } else if (command === 'uninstall') {
        await serviceUninstall(args.slice(1));
    } else if (command === 'status') {
        serviceStatus(args.slice(1));
    } else {
        // Запуск без аргументов (двойной клик по exe) — интерактивное меню
        if (args.length === 0 && process.stdin.isTTY && process.platform === 'win32') {
            await showMenu();
        }

        const { jobs, statePath, logPath } = loadJobs(args);
        initLog(logPath);
        const stateStore = createStateStore(statePath);
        const runners = jobs.map((job) => runJob(job, stateStore));

        function shutdown() {
            log('INFO', t('shutting_down'));
            progressStop();
            for (const r of runners) r.stop();
            stateStore.flush();
            if (logStream) logStream.end();
            process.exit(0);
        }
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        progressStart(); // живая таблица — до старта заданий, чтобы были видны начальное сканирование и проверка диска
        await Promise.all(runners.map((r) => r.start()));
    }
}

main().catch((err) => {
    log('ERROR', err.message);
    process.exit(1);
});
