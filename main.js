const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Bot } = require('grammy');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const token = process.env.BOT_TOKEN;
const configuredAdminChatIds = (process.env.ADMIN_CHAT_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const adminChatIds = new Set(configuredAdminChatIds);
const processName = process.env.PM2_PROCESS_NAME;
const healthCheckUrl = process.env.HEALTH_CHECK_URL || '';
const diskPath = process.env.MONITOR_DISK_PATH || '/';
const cpuAlertPercent = readThreshold('CPU_ALERT_PERCENT', 90);
const memoryAlertPercent = readThreshold('MEMORY_ALERT_PERCENT', 90);
const diskFreeAlertPercent = readThreshold('DISK_FREE_ALERT_PERCENT', 10);

if (!token) {
  throw new Error('BOT_TOKEN is not set. Copy .env.example to .env and configure it.');
}

if (adminChatIds.size !== 2 || [...adminChatIds].some((id) => !/^[1-9]\d*$/.test(id))) {
  throw new Error('Set exactly two administrator chat IDs in ADMIN_CHAT_IDS.');
}

if (!processName || !/^[A-Za-z0-9_.@:-]+$/.test(processName) || processName.startsWith('-')) {
  throw new Error('Set PM2_PROCESS_NAME to the exact PM2 process name.');
}

if (!diskPath.startsWith('/')) {
  throw new Error('MONITOR_DISK_PATH must be an absolute Linux path.');
}

if (healthCheckUrl) {
  let parsedHealthUrl;
  try {
    parsedHealthUrl = new URL(healthCheckUrl);
  } catch {
    throw new Error('HEALTH_CHECK_URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsedHealthUrl.protocol)) {
    throw new Error('HEALTH_CHECK_URL must use HTTP or HTTPS.');
  }
}

const dataDirectory = path.join(__dirname, 'data');
const remindersFile = path.join(dataDirectory, 'reminders.json');
const actionsFile = path.join(dataDirectory, 'admin-actions.jsonl');
fs.mkdirSync(dataDirectory, { recursive: true });

function readThreshold(name, defaultValue) {
  const value = Number(process.env[name] || defaultValue);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`${name} must be a number greater than 0 and at most 100.`);
  }
  return value;
}

function recordAdminAction(message, action, result, detail = '') {
  const entry = {
    timestamp: new Date().toISOString(),
    chatId: String(message.chat.id),
    username: message.from?.username || null,
    action,
    processName,
    result,
    detail: detail.slice(0, 500),
  };
  try {
    if (fs.existsSync(actionsFile) && fs.statSync(actionsFile).size > 1024 * 1024) {
      const currentLog = fs.readFileSync(actionsFile, 'utf8');
      const tail = currentLog.slice(-512 * 1024);
      const firstNewline = tail.indexOf('\n');
      fs.writeFileSync(actionsFile, tail.slice(firstNewline + 1), { mode: 0o600 });
    }
    fs.appendFileSync(actionsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`Could not write admin action log: ${error.message}`);
  }
}

function loadReminders() {
  try {
    const data = JSON.parse(fs.readFileSync(remindersFile, 'utf8'));
    if (!Array.isArray(data)) {
      throw new Error('Expected an array of reminders.');
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Could not read ${remindersFile}: ${error.message}`);
  }
}

let reminders = loadReminders();

function saveReminders() {
  const temporaryFile = `${remindersFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(reminders, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, remindersFile);
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: error ? error.code : 0,
      };

      if (error && !allowFailure) {
        reject(new Error(result.stderr || result.stdout || error.message));
        return;
      }

      resolve(result);
    });
  });
}

function issueSignature(issue) {
  return issue
    .replace(/^\d+\|[^|]+\s*\|\s*/, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<timestamp>')
    .trim()
    .toLowerCase();
}

function cpuTimes() {
  return os.cpus().reduce(
    (total, cpu) => {
      for (const [mode, time] of Object.entries(cpu.times)) {
        total[mode] = (total[mode] || 0) + time;
      }
      return total;
    },
    {},
  );
}

async function getCpuUsagePercent() {
  const first = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = cpuTimes();
  const totalDelta = Object.keys(second).reduce((sum, mode) => sum + second[mode] - first[mode], 0);
  const idleDelta = second.idle - first.idle;
  return totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
}

async function getResourceSnapshot() {
  const [cpuPercent, diskResult] = await Promise.all([
    getCpuUsagePercent(),
    run('df', ['-Pk', diskPath]),
  ]);
  const memoryInfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const totalMatch = /^MemTotal:\s+(\d+)\s+kB$/m.exec(memoryInfo);
  const availableMatch = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(memoryInfo);
  if (!totalMatch || !availableMatch) {
    throw new Error('Could not read MemTotal and MemAvailable from /proc/meminfo.');
  }
  const memoryTotal = Number(totalMatch[1]) * 1024;
  const memoryAvailable = Number(availableMatch[1]) * 1024;
  const memoryUsed = memoryTotal - memoryAvailable;
  const diskLine = diskResult.stdout.split(/\r?\n/).filter(Boolean).pop();
  const diskColumns = diskLine ? diskLine.trim().split(/\s+/) : [];
  const diskUsedPercent = Number.parseInt((diskColumns[4] || '').replace('%', ''), 10);
  if (!Number.isFinite(diskUsedPercent)) {
    throw new Error(`Could not parse disk usage for ${diskPath}.`);
  }

  return {
    cpuPercent,
    memoryPercent: Math.round((memoryUsed / memoryTotal) * 100),
    memoryUsed,
    memoryTotal,
    diskFreePercent: 100 - diskUsedPercent,
    diskPath,
  };
}

async function checkHealthUrl() {
  if (!healthCheckUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(healthCheckUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    await response.body?.cancel();
    if (!response.ok) {
      return `Health-check URL returned HTTP ${response.status}.`;
    }
    return null;
  } catch (error) {
    return `Health-check URL is unavailable: ${error.message}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function getHealthSnapshot() {
  const [statusResult, logsResult, resourceResult, urlIssue] = await Promise.all([
    run('pm2', ['jlist']),
    run('pm2', ['logs', processName, '--lines', '100', '--nostream']),
    getResourceSnapshot().then(
      (resources) => ({ resources }),
      (error) => ({ error }),
    ),
    checkHealthUrl(),
  ]);
  const processes = JSON.parse(statusResult.stdout);
  const processInfo = processes.find((entry) => entry.name === processName);
  const state = processInfo?.pm2_env?.status || 'not found';
  const logText = [logsResult.stdout, logsResult.stderr].filter(Boolean).join('\n');
  const issues = [];
  const resources = resourceResult.resources || null;

  if (state !== 'online') {
    issues.push({
      key: 'pm2:status',
      message: `PM2-процесс «${processName}» имеет статус: ${state}.`,
      recovery: true,
    });
  }

  const logIssues = [...new Set(
    logText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && problemLogPatterns.some((pattern) => pattern.test(line)))
      .map((line) => line.slice(0, 800)),
  )].slice(-20);
  for (const line of logIssues) {
    issues.push({
      key: `log:${issueSignature(line)}`,
      message: `Ошибка в логах: ${line}`,
      recovery: false,
    });
  }

  if (resourceResult.error) {
    issues.push({
      key: 'resource:check',
      message: `Не удалось получить метрики ресурсов: ${resourceResult.error.message}`,
      recovery: true,
    });
  }
  if (resources && resources.cpuPercent >= cpuAlertPercent) {
    issues.push({
      key: 'resource:cpu',
      message: `Высокая загрузка CPU: ${resources.cpuPercent}% (порог ${cpuAlertPercent}%).`,
      recovery: true,
    });
  }
  if (resources && resources.memoryPercent >= memoryAlertPercent) {
    issues.push({
      key: 'resource:memory',
      message: `Высокое использование RAM: ${resources.memoryPercent}% (порог ${memoryAlertPercent}%).`,
      recovery: true,
    });
  }
  if (resources && resources.diskFreePercent <= diskFreeAlertPercent) {
    issues.push({
      key: 'resource:disk',
      message: `Мало свободного места на диске ${resources.diskPath}: ${resources.diskFreePercent}% (порог ${diskFreeAlertPercent}%).`,
      recovery: true,
    });
  }
  if (urlIssue) {
    issues.push({ key: 'health-url', message: urlIssue, recovery: true });
  }

  return { state, logIssues, issues, resources };
}

const bot = new Bot(token);
const commandHandlers = [];
const pendingConfirmations = new Map();
const cancelConfirmationText = '↩️ Отмена';
const cancelReminderText = '↩️ Отменить напоминание';
const reminderDurations = new Map([
  ['10 минут', 10 * 60 * 1000],
  ['30 минут', 30 * 60 * 1000],
  ['1 час', 60 * 60 * 1000],
  ['1,5 часа', 90 * 60 * 1000],
]);
const menuKeyboard = {
  keyboard: [
    ['📊 Статус', '📋 Логи'],
    ['▶️ Запустить', '🔄 Перезапустить'],
    ['⏹ Остановить', '⏰ Напоминание'],
    ['📈 Ресурсы', '🧾 Журнал действий'],
    ['🗓 Мои напоминания', 'ℹ️ Помощь'],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const reminderDurationKeyboard = {
  keyboard: [
    ['10 минут', '30 минут'],
    ['1 час', '1,5 часа'],
    [cancelReminderText],
  ],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const problemLogPatterns = [
  /\b(?:ERROR|FATAL|CRITICAL)\b/i,
  /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):/i,
  /Unhandled (?:exception|rejection)/i,
  /\bEADDRINUSE\b/i,
  /exited with code \[[1-9]\d*\]/i,
  /\b(?:errored|crashed|uncaught exception)\b/i,
];

function isAdmin(message) {
  return message.chat.type === 'private' && adminChatIds.has(String(message.chat.id));
}

function escapeMarkdownV2(value) {
  return String(value).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeMarkdownV2WithinLimit(value, maxLength = 3400) {
  let escaped = '';
  for (const character of String(value)) {
    const safeCharacter = escapeMarkdownV2(character);
    if (escaped.length + safeCharacter.length > maxLength) {
      return `${escaped}\n…вывод сокращён`;
    }
    escaped += safeCharacter;
  }
  return escaped;
}

function fitMarkdownLines(lines, maxLength = 3400) {
  const fitted = [];
  let length = 0;
  for (const line of lines) {
    const addedLength = line.length + (fitted.length ? 1 : 0);
    if (length + addedLength > maxLength) {
      fitted.push('…список сокращён');
      break;
    }
    fitted.push(line);
    length += addedLength;
  }
  return fitted.join('\n');
}

async function sendMarkdown(chatId, text, options = {}) {
  await bot.api.sendMessage(chatId, text, {
    ...options,
    parse_mode: 'MarkdownV2',
  });
}

async function reply(message, text, keyboard = menuKeyboard) {
  await sendMarkdown(message.chat.id, escapeMarkdownV2(text), { reply_markup: keyboard });
}

async function replyFormatted(message, markdown, keyboard = menuKeyboard) {
  await sendMarkdown(message.chat.id, markdown, { reply_markup: keyboard });
}

function onAdminCommand(regex, handler) {
  commandHandlers.push({ regex, handler });
}

async function executeCommand(message, text) {
  const command = commandHandlers
    .map(({ regex, handler }) => ({ match: regex.exec(text), handler }))
    .find(({ match }) => match);
  if (!command) {
    return;
  }

  try {
    await command.handler(message, command.match);
  } catch (error) {
    console.error(`Command failed: ${error.message}`);
    await reply(message, `Ошибка: ${error.message}`);
  }
}

bot.on('message:text', async (context) => {
  const message = context.message;
  if (!isAdmin(message)) {
    return;
  }

  const chatId = String(message.chat.id);
  const pending = pendingConfirmations.get(chatId);
  if (pending) {
    pendingConfirmations.delete(chatId);
    if (pending.expiresAt > Date.now() && message.text === pending.confirmText) {
      await executeCommand(message, `/${pending.command}`);
      return;
    }
    if (pending.expiresAt > Date.now() && message.text === cancelConfirmationText) {
      await reply(message, 'Действие отменено.');
      return;
    }
  }

  const actions = new Map([
    ['📊 Статус', '/status'],
    ['📋 Логи', '/logs'],
    ['▶️ Запустить', '/startserver'],
    ['📈 Ресурсы', '/resources'],
    ['🧾 Журнал действий', '/actions'],
    ['🗓 Мои напоминания', '/reminders'],
    ['ℹ️ Помощь', '/help'],
  ]);

  if (message.text === '↩️ Отмена' || message.text === cancelReminderText) {
    pendingConfirmations.delete(chatId);
    await reply(message, 'Действие отменено.');
    return;
  }

  if (message.text === '⏰ Напоминание') {
    await reply(message, 'Через какое время отправить напоминание?', reminderDurationKeyboard);
    return;
  }

  const durationMs = reminderDurations.get(message.text);
  if (durationMs) {
    try {
      const snapshot = await getHealthSnapshot();
      const timestamp = new Date(Date.now() + durationMs).toISOString();
      const ownMonitors = reminders.filter(
        (reminder) => reminder.type === 'health-check' && reminder.chatId === chatId,
      );
      reminders = reminders.filter(
        (reminder) => !(reminder.type === 'health-check' && reminder.chatId === chatId),
      );

      const monitor = {
        id: randomUUID().slice(0, 8),
        type: 'health-check',
        chatId,
        timestamp,
        activeIssues: {},
        issueCounts: {},
        issueLabels: {},
        observedIssues: [],
      };

      reminders.push(monitor);
      saveReminders();
      if (snapshot.issues.length > 0) {
        try {
          await sendMarkdown(
            chatId,
            `*🚨 Срочное уведомление*\n\n${escapeMarkdownV2WithinLimit(snapshot.issues.map((issue) => issue.message).join('\n\n'))}`,
          );
          for (const issue of snapshot.issues) {
            monitor.activeIssues[issue.key] = { message: issue.message, recovery: issue.recovery };
            monitor.issueCounts[issue.key] = 1;
            monitor.issueLabels[issue.key] = issue.message;
            monitor.observedIssues.push(issue.message);
          }
          saveReminders();
        } catch (error) {
          console.error(`Could not deliver initial health alert to ${chatId}: ${error.message}`);
        }
      }

      await reply(
        message,
        `Наблюдение включено на ${message.text}. Каждые 30 секунд проверяю PM2, логи и ресурсы${healthCheckUrl ? ', а также доступность приложения' : ''}. Уведомления и итог придут только вам.${ownMonitors.length ? '\nВаше предыдущее наблюдение заменено.' : ''}`,
      );
    } catch (error) {
      console.error(`Could not start health monitoring for ${chatId}: ${error.message}`);
      await reply(message, `Не удалось включить наблюдение: ${error.message}`);
    }
    return;
  }

  if (actions.has(message.text)) {
    await executeCommand(message, actions.get(message.text));
    return;
  }

  const confirmations = new Map([
    ['🔄 Перезапустить', { command: 'restartserver', confirmText: '✅ Да, перезапустить' }],
    ['⏹ Остановить', { command: 'stopserver', confirmText: '✅ Да, остановить' }],
  ]);
  const confirmation = confirmations.get(message.text);
  if (confirmation) {
    pendingConfirmations.set(chatId, { ...confirmation, expiresAt: Date.now() + 60_000 });
    await reply(
      message,
      `Подтвердите действие с сервером «${processName}» в течение минуты:`,
      {
        keyboard: [[confirmation.confirmText], [cancelConfirmationText]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    );
    return;
  }

  await executeCommand(message, message.text);
});

onAdminCommand(/^\/(?:start|help)(?:@\w+)?$/, async (message) => {
  await replyFormatted(
    message,
    [
      '*🛠 Панель управления сервером*',
      '',
      '*Мониторинг*',
      `📊 ${escapeMarkdownV2('/status')} — состояние PM2`,
      `📋 ${escapeMarkdownV2('/logs')} — последние строки логов`,
      `📈 ${escapeMarkdownV2('/resources')} — CPU, RAM и диск`,
      `🧾 ${escapeMarkdownV2('/actions')} — журнал действий`,
      '',
      '*Управление*',
      `▶️ ${escapeMarkdownV2('/startserver')} — запуск`,
      `⏹ ${escapeMarkdownV2('/stopserver')} — остановка`,
      `🔄 ${escapeMarkdownV2('/restartserver')} — перезапуск`,
      '',
      '*Наблюдение*',
      'Нажмите «⏰ Напоминание» и выберите интервал\\.',
      'Проверка выполняется каждые 30 секунд\\. Уведомления приходят только включившему наблюдение администратору\\.',
      '',
      `🗓 ${escapeMarkdownV2('/reminders')} — мои наблюдения`,
      `❌ ${escapeMarkdownV2('/cancelreminder')} ID — отменить наблюдение`,
    ].join('\n'),
  );
});

onAdminCommand(/^\/status(?:@\w+)?$/, async (message) => {
  const result = await run('pm2', ['jlist']);
  const processes = JSON.parse(result.stdout);
  const target = processes.find((processInfo) => processInfo.name === processName);
  if (!target) {
    await replyFormatted(message, `*❌ Процесс не найден*\n\nИмя: ${escapeMarkdownV2(processName)}\nПроверьте имя приложения в выводе \`pm2 list\`\\.`);
    return;
  }

  const state = target.pm2_env?.status || 'неизвестно';
  const statusIcon = state === 'online' ? '🟢' : '🔴';
  await replyFormatted(
    message,
    `*${statusIcon} Статус сервера*\n\n*Приложение:* ${escapeMarkdownV2(processName)}\n*Состояние:* ${escapeMarkdownV2(state)}`,
  );
});

onAdminCommand(/^\/logs(?:@\w+)?(?:\s+(\d+))?$/, async (message, match) => {
  const lines = Number(match[1] || 30);
  if (!Number.isInteger(lines) || lines < 1 || lines > 100) {
    await reply(message, 'Укажите число строк от 1 до 100: /logs 30');
    return;
  }

  const result = await run('pm2', ['logs', processName, '--lines', String(lines), '--nostream']);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(Логи пусты.)';
  await replyFormatted(
    message,
    `*📋 Логи ${escapeMarkdownV2(processName)}*\n_${lines} последних строк_\n\n${escapeMarkdownV2WithinLimit(output)}`,
  );
});

onAdminCommand(/^\/resources(?:@\w+)?$/, async (message) => {
  const resources = await getResourceSnapshot();
  const memoryUsedGb = (resources.memoryUsed / 1024 ** 3).toFixed(1);
  const memoryTotalGb = (resources.memoryTotal / 1024 ** 3).toFixed(1);
  await replyFormatted(
    message,
    [
      '*📈 Ресурсы сервера*',
      '',
      `*CPU:* ${resources.cpuPercent}% _порог ${cpuAlertPercent}%_`,
      `*RAM:* ${resources.memoryPercent}% — ${escapeMarkdownV2(memoryUsedGb)}/${escapeMarkdownV2(memoryTotalGb)} GB _порог ${memoryAlertPercent}%_`,
      `*Диск ${escapeMarkdownV2(resources.diskPath)}:* свободно ${resources.diskFreePercent}% _тревога при ${diskFreeAlertPercent}% или меньше_`,
      `*HTTP health\\-check:* ${healthCheckUrl ? 'включён' : 'не настроен'}`,
    ].join('\n'),
  );
});

onAdminCommand(/^\/actions(?:@\w+)?$/, async (message) => {
  let entries = [];
  try {
    const content = fs.readFileSync(actionsFile, 'utf8');
    entries = content.split(/\r?\n/).filter(Boolean).slice(-15).reverse().map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Could not read admin action log: ${error.message}`);
    }
  }

  if (entries.length === 0) {
    await reply(message, 'Журнал действий пока пуст.');
    return;
  }

  await replyFormatted(
    message,
    `*🧾 Последние действия администраторов*\n\n${fitMarkdownLines(entries.map((entry) => {
      const username = entry.username ? `@${entry.username}` : entry.chatId;
      const detail = entry.detail ? ` — ${entry.detail}` : '';
      return `• *${escapeMarkdownV2(entry.timestamp)}* | ${escapeMarkdownV2(username)} | ${escapeMarkdownV2(entry.action)} | ${escapeMarkdownV2(entry.result)}${escapeMarkdownV2(detail)}`;
    }))}`,
  );
});

for (const [command, action, verb] of [
  ['startserver', 'restart', 'запущен'],
  ['stopserver', 'stop', 'остановлен'],
  ['restartserver', 'restart', 'перезапущен'],
]) {
  onAdminCommand(new RegExp(`^\\/${command}(?:@\\w+)?$`), async (message) => {
    try {
      await run('pm2', [action, processName]);
      recordAdminAction(message, action, 'success');
    } catch (error) {
      recordAdminAction(message, action, 'failure', error.message);
      throw error;
    }
    await reply(message, `Команда выполнена: процесс ${processName} ${verb}.`);
  });
}

onAdminCommand(/^\/reminders(?:@\w+)?$/, async (message) => {
  const ownReminders = reminders.filter((reminder) => reminder.chatId === String(message.chat.id));
  if (ownReminders.length === 0) {
    await reply(message, 'У вас нет запланированных напоминаний.');
    return;
  }

  await replyFormatted(
    message,
    `*🗓 Ваши активные наблюдения*\n\n${fitMarkdownLines(ownReminders
      .map((reminder) => {
        const description = reminder.type === 'health-check'
          ? 'автоматическая проверка сервера'
          : reminder.text;
        return `• *${escapeMarkdownV2(reminder.id)}* — до ${escapeMarkdownV2(reminder.timestamp)}\n  ${escapeMarkdownV2(description)}`;
      })
      .flatMap((entry) => entry.split('\n')))}`
  );
});

onAdminCommand(/^\/cancelreminder(?:@\w+)?\s+([a-f0-9-]+)$/i, async (message, match) => {
  const index = reminders.findIndex(
    (reminder) => reminder.id === match[1] && reminder.chatId === String(message.chat.id),
  );
  if (index === -1) {
    await reply(message, 'Напоминание не найдено.');
    return;
  }

  reminders.splice(index, 1);
  saveReminders();
  await reply(message, 'Напоминание отменено.');
});

let checkingReminders = false;
async function deliverDueReminders() {
  if (checkingReminders) {
    return;
  }
  checkingReminders = true;

  try {
    const now = Date.now();
    const healthChecks = reminders.filter((reminder) => reminder.type === 'health-check');
    const dueLegacyReminders = reminders.filter(
      (reminder) => reminder.type !== 'health-check' && Date.parse(reminder.timestamp) <= now,
    );
    if (healthChecks.length === 0 && dueLegacyReminders.length === 0) {
      return;
    }

    let snapshot;
    let snapshotError;
    if (healthChecks.length > 0) {
      try {
        snapshot = await getHealthSnapshot();
      } catch (error) {
        snapshotError = error;
        console.error(`Health check failed: ${error.message}`);
      }
    }

    for (const monitor of healthChecks) {
      const due = Date.parse(monitor.timestamp) <= now;
      const activeIssues = { ...(monitor.activeIssues || {}) };
      const issueCounts = { ...(monitor.issueCounts || {}) };
      const issueLabels = { ...(monitor.issueLabels || {}) };
      const observedIssues = [...(monitor.observedIssues || [])];
      const newAlerts = [];
      const recoveries = [];
      const currentIssues = snapshotError
        ? [{
            key: 'monitor:check',
            message: `Не удалось проверить сервер: ${snapshotError.message}`,
            recovery: true,
          }]
        : snapshot.issues;
      const currentKeys = new Set(currentIssues.map((issue) => issue.key));

      for (const issue of currentIssues) {
        issueCounts[issue.key] = (issueCounts[issue.key] || 0) + 1;
        issueLabels[issue.key] = issue.message;
        if (!activeIssues[issue.key]) {
          newAlerts.push(issue.message);
          activeIssues[issue.key] = { message: issue.message, recovery: issue.recovery };
          if (!observedIssues.includes(issue.message)) {
            observedIssues.push(issue.message);
          }
        } else {
          if (issue.key === 'pm2:status' && activeIssues[issue.key].message !== issue.message) {
            newAlerts.push(`Состояние процесса изменилось: ${issue.message}`);
            if (!observedIssues.includes(issue.message)) {
              observedIssues.push(issue.message);
            }
          }
          activeIssues[issue.key] = { message: issue.message, recovery: issue.recovery };
        }
      }

      for (const [key, issue] of Object.entries(activeIssues)) {
        if (!currentKeys.has(key) && issue.recovery) {
          recoveries.push(`✅ Восстановлено: ${issue.message}`);
          delete activeIssues[key];
        }
      }

      if (newAlerts.length > 0 || recoveries.length > 0) {
        try {
          await sendMarkdown(
            monitor.chatId,
            `*🚨 Мониторинг сервера*\n\n${escapeMarkdownV2WithinLimit(
              [...newAlerts.map((issue) => `⚠️ ${issue}`), ...recoveries].join('\n\n'),
            )}`,
          );
        } catch (error) {
          console.error(`Could not deliver health alert to ${monitor.chatId}: ${error.message}`);
          continue;
        }
      }

      monitor.activeIssues = activeIssues;
      monitor.issueCounts = issueCounts;
      monitor.issueLabels = issueLabels;
      monitor.observedIssues = observedIssues;
      saveReminders();

      if (due) {
        let report;
        if (snapshotError) {
          report = `*⚠️ Не удалось проверить сервер*\n\n${escapeMarkdownV2WithinLimit(snapshotError.message, 2500)}`;
        } else if (monitor.observedIssues.length === 0 && snapshot.issues.length === 0) {
          report = '*✅ Проверка завершена*\n\nНикаких проблем с сервером не обнаружено\\.';
        } else {
          const uniqueIssues = [...new Set(monitor.observedIssues)];
          const repeatedIssues = Object.entries(monitor.issueCounts)
            .filter(([, count]) => count > 1)
            .map(([key, count]) => {
              const issue = monitor.issueLabels[key];
              return issue ? `${issue} (наблюдалась в ${count} проверках)` : null;
            })
            .filter(Boolean);
          report = `*⚠️ Проверка завершена: обнаружены проблемы*\n\n${escapeMarkdownV2WithinLimit(uniqueIssues.join('\n'), 1800)}`;
          if (repeatedIssues.length > 0) {
            report += `\n\n*Повторяющиеся сигналы*\n${escapeMarkdownV2WithinLimit(repeatedIssues.join('\n'), 800)}`;
          }
          if (snapshot.resources) {
            report += `\n\n*📈 Итоговые ресурсы*\nCPU: ${snapshot.resources.cpuPercent}%\nRAM: ${snapshot.resources.memoryPercent}%\nСвободно на диске: ${snapshot.resources.diskFreePercent}%`;
          }
        }

        try {
          await sendMarkdown(monitor.chatId, report);
          reminders = reminders.filter((reminder) => reminder.id !== monitor.id);
          saveReminders();
        } catch (error) {
          console.error(`Could not deliver health report to ${monitor.chatId}: ${error.message}`);
        }
      }
    }

    for (const reminder of dueLegacyReminders) {
      try {
        await sendMarkdown(
          reminder.chatId,
          `*⏰ Напоминание*\n\n*Время:* ${escapeMarkdownV2(reminder.timestamp)}\n*Текст:* ${escapeMarkdownV2WithinLimit(reminder.text, 2500)}`,
        );
        reminders = reminders.filter((item) => item.id !== reminder.id);
        saveReminders();
      } catch (error) {
        console.error(`Could not deliver reminder ${reminder.id} to ${reminder.chatId}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Could not process reminders: ${error.message}`);
  } finally {
    checkingReminders = false;
  }
}

setInterval(deliverDueReminders, 30000);
bot.catch((error) => console.error(`Telegram bot error: ${error.message}`));
bot.api.setMyCommands([
  { command: 'status', description: 'Состояние процесса в PM2' },
  { command: 'logs', description: 'Последние строки логов' },
  { command: 'resources', description: 'Метрики CPU, RAM и диска' },
  { command: 'actions', description: 'Журнал действий администраторов' },
  { command: 'startserver', description: 'Запустить процесс' },
  { command: 'stopserver', description: 'Остановить процесс' },
  { command: 'restartserver', description: 'Перезапустить процесс' },
  { command: 'reminders', description: 'Список напоминаний' },
  { command: 'cancelreminder', description: 'Отменить напоминание' },
]).catch((error) => console.error(`Could not register bot commands: ${error.message}`));

console.log(`Bot started. Managing PM2 process: ${processName}`);
bot.start().catch((error) => {
  console.error(`Could not start Telegram polling: ${error.message}`);
  process.exitCode = 1;
});
